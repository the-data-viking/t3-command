// t3-command server: serves the UI, keeps the environment registry, and relays each
// browser WebSocket to the right T3 environment with that environment's token attached.

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AddEnvRequest, MeResponse } from "../shared/api.ts";
import { loadConfig, type Config } from "./config.ts";
import { Registry, UserError } from "./registry.ts";
import { serveEnvironmentAsset } from "./assets.ts";
import { HermesBridge } from "./hermes/bridge.ts";

const config = loadConfig();
const hermesLaunch = { command: config.hermesCommand, args: config.hermesArgs };
const registry = new Registry(config.dataDir, hermesLaunch);
await registry.load();
const hermesBridges = new Map<string, Promise<HermesBridge>>();

function hermesBridge(envId: string, workspaceRoot: string): Promise<HermesBridge> {
  let bridge = hermesBridges.get(envId);
  if (!bridge) {
    const instance = new HermesBridge(config.dataDir, envId, workspaceRoot, hermesLaunch);
    bridge = instance.load().then(() => instance).catch((err) => { hermesBridges.delete(envId); throw err; });
    hermesBridges.set(envId, bridge);
  }
  return bridge;
}

// ---- Access control --------------------------------------------------------------

/**
 * Who is making this request. `tailscale serve` adds Tailscale-User-Login for requests from
 * a user's device; we bind to 127.0.0.1 so nothing else can reach us to forge it.
 */
function identify(req: http.IncomingMessage): string | null {
  if (config.devNoAuth) return "local-dev";
  const login = req.headers["tailscale-user-login"];
  if (typeof login === "string" && config.allowedUsers.has(login.toLowerCase())) return login;
  return null;
}

/**
 * Blocks cross-site requests. Without this, any web page you visit could open a WebSocket
 * to t3-command from your browser (WebSockets aren't covered by CORS), and Tailscale would
 * happily attach your identity to it.
 */
function originAllowed(req: http.IncomingMessage, cfg: Config): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // browsers always send Origin cross-site; its absence means a non-browser client
  if (cfg.allowedOrigins.has(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [req.headers.host, req.headers["x-forwarded-host"]].flat().filter(Boolean);
  return hosts.includes(originHost);
}

// ---- HTTP ------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new UserError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new UserError("Request body must be JSON");
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const root = config.staticDir;
  let file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(root + path.sep) && file !== root) return sendJson(res, 400, { error: "Bad path" });
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(root, "index.html"); // SPA fallback
  }
  try {
    const body = await fs.readFile(file);
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "UI not built. Run `npm run build`, or use `npm run dev` during development." });
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const user = identify(req);
  if (!user) return sendJson(res, 403, { error: "Not allowed. Access t3-command through `tailscale serve` as an allowed user." });

  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && !originAllowed(req, config)) {
    return sendJson(res, 403, { error: "Cross-origin request blocked" });
  }

  const assetMatch = pathname.match(/^\/env\/([^/]+)\/assets\/(.+)$/);
  if (assetMatch && (method === "GET" || method === "HEAD")) {
    const search = new URL(req.url ?? "/", "http://localhost").search;
    return serveEnvironmentAsset(req, res, registry, decodeURIComponent(assetMatch[1]), `/api/assets/${assetMatch[2]}${search}`);
  }

  if (pathname === "/api/me" && method === "GET") {
    return sendJson(res, 200, { user, devMode: config.devNoAuth } satisfies MeResponse);
  }
  if (pathname === "/api/envs" && method === "GET") {
    return sendJson(res, 200, await registry.list());
  }
  if (pathname === "/api/envs" && method === "POST") {
    const body = await readJson<AddEnvRequest>(req);
    if (body.hermes) {
      return sendJson(res, 200, await registry.addHermes(String(body.hermes.workspaceRoot ?? ""), body.label));
    }
    if (body.ssh) {
      const port = body.ssh.port ? Number(body.ssh.port) : undefined;
      return sendJson(res, 200, await registry.addSsh(String(body.ssh.target ?? ""), port, body.label));
    }
    return sendJson(res, 200, await registry.add(String(body.url ?? ""), String(body.credential ?? ""), body.label));
  }
  if (pathname === "/api/envs/import-desktop" && method === "POST") {
    return sendJson(res, 200, await registry.importDesktopConnections());
  }
  const envMatch = pathname.match(/^\/api\/envs\/([^/]+)$/);
  if (envMatch && method === "DELETE") {
    const envId = decodeURIComponent(envMatch[1]);
    const env = registry.get(envId);
    // Load persisted Hermes state too, even when no browser has connected yet.
    const bridge = env?.hermes ? await hermesBridge(envId, env.hermes.workspaceRoot) : undefined;
    const removed = await registry.remove(envId);
    if (bridge) { await bridge.close(true); hermesBridges.delete(envId); }
    return sendJson(res, removed ? 200 : 404, { removed });
  }
  if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });

  return serveStatic(pathname, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
  });
});

// ---- WebSocket relay -------------------------------------------------------------

/** Close codes the UI understands. 4000-4999 are reserved for applications. */
const CLOSE = {
  unknownEnv: 4404,
  needsPairing: 4401,
  upstreamFailed: 4502,
} as const;

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const match = new URL(req.url ?? "/", "http://localhost").pathname.match(/^\/env\/([^/]+)\/ws$/);
  if (!match || !identify(req) || !originAllowed(req, config)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const envId = decodeURIComponent(match[1]);
  wss.handleUpgrade(req, socket, head, (client) => {
    void relay(client, envId).catch(() => client.close(CLOSE.upstreamFailed, "Could not open environment"));
  });
});

async function relay(client: WebSocket, envId: string): Promise<void> {
  const env = registry.get(envId);
  if (!env) {
    client.close(CLOSE.unknownEnv, "Unknown environment");
    return;
  }
  if (env.hermes) {
    // Hold the first subscription requests while loading the persisted fleet state.
    const early: RawData[] = [];
    const hold = (data: RawData) => early.push(data);
    client.on("message", hold);
    const bridge = await hermesBridge(envId, env.hermes.workspaceRoot);
    client.off("message", hold);
    if (client.readyState !== WebSocket.OPEN) return;
    bridge.attach(client);
    for (const data of early) client.emit("message", data);
    return;
  }

  // Hold what the browser sends while we resolve the URL (an SSH base may need a tunnel first).
  const early: Array<[RawData, boolean]> = [];
  const hold = (data: RawData, isBinary: boolean) => early.push([data, isBinary]);
  client.on("message", hold);
  let baseUrl: string;
  let token: string;
  try {
    baseUrl = await registry.resolveUrl(env);
    token = await registry.tokenFor(env);
  } catch (err) {
    if (client.readyState === WebSocket.OPEN) client.close(CLOSE.upstreamFailed, (err as Error).message.slice(0, 120));
    return;
  }
  client.off("message", hold);
  if (client.readyState !== WebSocket.OPEN) return;

  const upstreamUrl = new URL("/ws", baseUrl);
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
  upstreamUrl.searchParams.set("clientSurface", "web");
  upstreamUrl.searchParams.set("clientAppVersion", "t3-command");
  const upstream = new WebSocket(upstreamUrl, {
    headers: { authorization: `Bearer ${token}` },
    maxPayload: 64 * 1024 * 1024,
  });

  // Frames the browser sends before the upstream connection is open.
  const pending: Array<[RawData, boolean]> = early;

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push([data, isBinary]);
  });
  upstream.on("open", () => {
    for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  upstream.on("unexpected-response", (_req, res) => {
    const pairing = res.statusCode === 401 || res.statusCode === 403;
    if (pairing) registry.tokenRejected(envId);
    client.close(pairing ? CLOSE.needsPairing : CLOSE.upstreamFailed, `T3 rejected the connection (HTTP ${res.statusCode})`);
    upstream.terminate();
  });
  upstream.on("error", (err) => {
    if (client.readyState === WebSocket.OPEN) client.close(CLOSE.upstreamFailed, err.message.slice(0, 120));
  });
  upstream.on("close", (code, reason) => {
    if (client.readyState === WebSocket.OPEN) {
      // 1005/1006 are reserved and can't be sent in a close frame.
      client.close(code === 1005 || code === 1006 ? CLOSE.upstreamFailed : code, reason);
    }
  });
  client.on("close", () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  });
  client.on("error", () => upstream.terminate());
}

server.listen(config.port, config.host, () => {
  console.log(`t3-command listening on http://${config.host}:${config.port}`);
  console.log(`  data dir: ${config.dataDir}`);
  if (config.devNoAuth) {
    console.warn(
      "  WARNING: T3C_DEV_NO_AUTH=1 — identity checks are off. Don't put this behind `tailscale serve`.",
    );
  } else {
    console.log(`  allowed users: ${[...config.allowedUsers].join(", ")}`);
  }
});

async function shutdown(): Promise<void> {
  await Promise.all([...hermesBridges.values()].map(async (bridge) => (await bridge).close()));
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
