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
import { HermesManager, acquireBot } from "./hermes/manager.ts";
import type { HermesAction } from "../shared/hermes.ts";
import { Updater, UpdateConflict } from "./updater.ts";
import { TurnHistory } from "./history.ts";
import { HistoryRecorder } from "./history-recorder.ts";
import { StorageMonitor } from "./storage.ts";
import { CommsLog } from "./comms.ts";
import { ReadState } from "./read-state.ts";
import { PushNotifier } from "./push.ts";
import { FollowUps } from "./followups.ts";
import { Dispatches } from "./dispatches.ts";
import { Playbooks } from "./playbooks.ts";
import { randomUUID } from "node:crypto";
import { HostHistoryRecorder } from "./host-history.ts";
import { t3SocketUrl } from "./t3-socket.ts";
import { T3Versions } from "./t3-versions.ts";
import { T3LatestVersion } from "./t3-latest.ts";
import { LongTurns } from "./long-turns.ts";
import { HISTORY_RETENTION_DAYS, TIMELINE_MAX_HOURS } from "../shared/history.ts";

const config = loadConfig();
const hermesLaunch = { command: config.hermesCommand, args: config.hermesArgs };
const registry = new Registry(config.dataDir, hermesLaunch);
await registry.load();
const hermesManager = new HermesManager(config.hermesCommand);
const hermesBridges = new Map<string, Promise<HermesBridge>>();

function hermesBridge(envId: string, workspaceRoot: string): Promise<HermesBridge> {
  let bridge = hermesBridges.get(envId);
  if (!bridge) {
    const instance = new HermesBridge(config.dataDir, envId, workspaceRoot, hermesLaunch, hermesManager);
    bridge = instance.load().then(() => instance).catch((err) => { hermesBridges.delete(envId); throw err; });
    hermesBridges.set(envId, bridge);
  }
  return bridge;
}
// Turn history: followed from here so it keeps recording with no browser open.
const history = new TurnHistory(config.dataDir);
await history.load();
const recorder = new HistoryRecorder(registry, history, hermesBridge);
// The fleet comms log, shared by every browser.
const comms = new CommsLog(config.dataDir);
await comms.load();
const readState = new ReadState(config.dataDir);
await readState.load();
// Fleet events pushed to subscribed devices, filtered by the push rules and quiet hours.
const push = new PushNotifier(config.dataDir);
await push.load();
comms.onEntry((entry) => void push.notify(entry, entry.envId ? registry.get(entry.envId)?.label : undefined).catch((err) => console.warn("[push]", (err as Error).message)));
// Follow-ups go out over the server's own link to each machine, as the browser would send them.
const followUps = new FollowUps(config.dataDir, comms, async (envId, thread, text) => {
  await recorder.request(envId, "orchestration.dispatchCommand", {
    commandId: randomUUID(), type: "thread.turn.start", threadId: thread.id,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode,
    createdAt: new Date().toISOString(),
  });
}, (envId) => registry.get(envId)?.label);
await followUps.load();
const playbooks = new Playbooks(config.dataDir);
await playbooks.load();
const dispatches = new Dispatches(config.dataDir);
await dispatches.load();
dispatches.announceTo(comms, (envId, threadId) => followUps.view().queued.some((f) => f.envId === envId && f.threadId === threadId));
followUps.onDrop((f) => dispatches.followUpDropped(f.envId, f.threadId, f.afterTurnId));
recorder.listen({
  observe: (envId, threads) => { comms.observe(envId, threads); followUps.observe(envId, threads); dispatches.observe(envId, threads); },
  connected: (envId, label) => comms.connected(envId, label),
  disconnected: (envId, label) => comms.disconnected(envId, label),
  removed: (envId) => { comms.forget(envId); followUps.forget(envId); dispatches.forget(envId); },
});
setInterval(() => void comms.prune().catch((err) => console.warn("[comms] prune failed", (err as Error).message)), 6 * 3_600_000).unref();
recorder.start();
// Announce T3 updates on each machine, and protocol changes Command can't follow yet.
const t3Versions = new T3Versions(config.dataDir, registry, comms);
const t3Latest = new T3LatestVersion();
await t3Versions.load();
t3Versions.start();
// Note runaway turns (2/6/12/24 h) in the comms log.
const longTurns = new LongTurns(registry, recorder, comms);
longTurns.start();
// Whole-host CPU/RAM history per machine.
const hostHistory = new HostHistoryRecorder(config.dataDir, registry, recorder);
await hostHistory.load();
hostHistory.start();
// Disk usage per machine, for the engineering decks.
const storage = new StorageMonitor(config.dataDir, registry, recorder, comms);
await storage.load();
storage.start();

const updater = new Updater({ root: config.updateRoot, remote: config.updateRemote, enabled: config.managedUpdates,
  currentCommit: config.runningCommit, localChanges: config.localChanges,
  beforeActivate: ensureHermesIdle,
  activate: () => { setTimeout(() => void shutdown(), 1500); },
});
await updater.load();

async function ensureHermesIdle(): Promise<void> {
  for (const bridge of hermesBridges.values()) {
    if ((await bridge).hasRunningTurns()) throw new UpdateConflict("Local Hermes workers are running. Halt them before redeploying Command.");
  }
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
  ".webmanifest": "application/manifest+json",
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
  if (pathname === "/api/history" && method === "GET") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const days = Number(params.get("days") ?? 7);
    const timeZone = params.get("tz") ?? "UTC";
    if (!Number.isInteger(days) || days < 1 || days > HISTORY_RETENTION_DAYS) return sendJson(res, 400, { error: `days must be 1–${HISTORY_RETENTION_DAYS}` });
    try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { return sendJson(res, 400, { error: "Unknown time zone" }); }
    return sendJson(res, 200, history.summary(days, timeZone));
  }
  if (pathname === "/api/storage" && method === "GET") return sendJson(res, 200, storage.views());
  if (pathname === "/api/memory" && method === "GET") return sendJson(res, 200, history.memory());
  if (pathname === "/api/t3/latest" && method === "GET") return sendJson(res, 200, await t3Latest.get());
  if (pathname === "/api/history/timeline" && method === "GET") {
    const hours = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("hours") ?? 24);
    if (!Number.isInteger(hours) || hours < 1 || hours > TIMELINE_MAX_HOURS) return sendJson(res, 400, { error: `hours must be 1–${TIMELINE_MAX_HOURS}` });
    return sendJson(res, 200, history.timeline(hours));
  }
  // The comms stream also carries report read marks: all of them on connect, then each change.
  if (pathname === "/api/comms/stream" && method === "GET") {
    return comms.stream(req, res, (send) => {
      send("read", readState.all());
      send("followups", followUps.view());
      send("dispatches", dispatches.all());
      const offRead = readState.subscribe((changed) => send("read", changed));
      const offFollowUps = followUps.subscribe((view) => send("followups", view));
      const offDispatches = dispatches.subscribe((list) => send("dispatches", list));
      return () => { offRead(); offFollowUps(); offDispatches(); };
    });
  }
  if (pathname === "/api/playbooks" && method === "GET") return sendJson(res, 200, playbooks.all());
  if (pathname === "/api/playbooks" && method === "PUT") {
    try { return sendJson(res, 200, await playbooks.set((await readJson<{ playbooks?: unknown }>(req))?.playbooks)); }
    catch (err) { return sendJson(res, 400, { error: (err as Error).message }); }
  }
  if (pathname === "/api/dispatches" && method === "GET") return sendJson(res, 200, dispatches.all());
  if (pathname === "/api/dispatches" && method === "POST") {
    const body = await readJson<{ text?: unknown; members?: unknown; mission?: unknown }>(req);
    try { return sendJson(res, 200, dispatches.add(body?.text, body?.members, Date.now(), body?.mission)); }
    catch (err) { return sendJson(res, 400, { error: (err as Error).message }); }
  }
  if (pathname === "/api/dispatches/update" && method === "POST") {
    const body = await readJson<{ id?: string; members?: unknown }>(req);
    const updated = dispatches.update(String(body?.id ?? ""), body?.members);
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "No such dispatch" });
  }
  if (pathname === "/api/dispatches/close" && method === "POST") {
    const body = await readJson<{ id?: string }>(req);
    return sendJson(res, dispatches.close(String(body?.id ?? "")) ? 200 : 404, dispatches.all());
  }
  if (pathname === "/api/followups" && method === "GET") return sendJson(res, 200, followUps.view());
  if (pathname === "/api/followups" && method === "POST") {
    const body = await readJson<{ envId?: string; threadId?: string; text?: string; times?: number; startedAfter?: string | null }>(req);
    const opts = { ...(body?.times !== undefined ? { times: Number(body.times) } : {}),
      ...(body && "startedAfter" in body ? { startedAfter: typeof body.startedAfter === "string" ? body.startedAfter : null } : {}) };
    try { return sendJson(res, 200, followUps.add(String(body?.envId ?? ""), String(body?.threadId ?? ""), String(body?.text ?? ""), Date.now(), opts)); }
    catch (err) { return sendJson(res, 400, { error: (err as Error).message }); }
  }
  if (pathname === "/api/followups/cancel" && method === "POST") {
    const body = await readJson<{ id?: string }>(req);
    return sendJson(res, followUps.cancel(String(body?.id ?? "")) ? 200 : 404, followUps.view());
  }
  if (pathname === "/api/followups/pause" && method === "PUT") {
    const body = await readJson<{ paused?: boolean }>(req);
    followUps.setPaused(body?.paused === true);
    return sendJson(res, 200, followUps.view());
  }
  if (pathname === "/api/push" && method === "GET") return sendJson(res, 200, push.status());
  if (pathname === "/api/push/subscribe" && method === "POST") {
    const body = await readJson<{ subscription?: unknown; label?: string }>(req);
    try { push.subscribe(body?.subscription as never, String(body?.label ?? "")); } catch (err) { return sendJson(res, 400, { error: (err as Error).message }); }
    return sendJson(res, 200, push.status());
  }
  if (pathname === "/api/push/unsubscribe" && method === "POST") {
    const body = await readJson<{ endpoint?: string }>(req);
    push.unsubscribe(String(body?.endpoint ?? ""));
    return sendJson(res, 200, push.status());
  }
  if (pathname === "/api/push/rules" && method === "PUT") {
    try { push.setRules((await readJson<{ rules?: unknown }>(req))?.rules); } catch (err) { return sendJson(res, 400, { error: (err as Error).message }); }
    return sendJson(res, 200, push.status());
  }
  if (pathname === "/api/push/device" && method === "PUT") {
    const body = await readJson<{ endpoint?: string; kinds?: unknown }>(req);
    try { push.setDeviceKinds(String(body?.endpoint ?? ""), body?.kinds); } catch (err) { return sendJson(res, 400, { error: (err as Error).message }); }
    return sendJson(res, 200, push.status());
  }
  if (pathname === "/api/push/test" && method === "POST") {
    const body = await readJson<{ endpoint?: string }>(req);
    return sendJson(res, 200, { sent: await push.test(body?.endpoint) });
  }
  if (pathname === "/api/read" && method === "PUT") {
    const body = await readJson<{ marks?: Record<string, string> }>(req);
    if (!body?.marks || typeof body.marks !== "object" || Object.keys(body.marks).length > 500) return sendJson(res, 400, { error: "marks must be an object of up to 500 entries" });
    return sendJson(res, 200, { changed: readState.mark(body.marks) });
  }
  if (pathname === "/api/hosts/history" && method === "GET") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const envId = params.get("envId") ?? "";
    const hours = Number(params.get("hours") ?? 24);
    if (!registry.get(envId)) return sendJson(res, 404, { error: "Unknown environment" });
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) return sendJson(res, 400, { error: "hours must be 1–168" });
    return sendJson(res, 200, hostHistory.history(envId, hours));
  }
  if (pathname === "/api/update" && method === "GET") return sendJson(res, 200, await updater.status());
  if ((pathname === "/api/update" || pathname === "/api/update/check") && method === "POST") {
    const body = await readJson<unknown>(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      return sendJson(res, 400, { error: "Update requests do not accept repository, ref, or command overrides." });
    }
    const action = pathname.endsWith("/check") ? "check" : "deploy";
    if (action === "deploy") await ensureHermesIdle();
    return sendJson(res, 202, await updater.start(action));
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
  const hermesMatch = pathname.match(/^\/api\/envs\/([^/]+)\/hermes$/);
  if (hermesMatch && method === "POST") {
    const envId = decodeURIComponent(hermesMatch[1]);
    const env = registry.get(envId);
    if (!env?.hermes) return sendJson(res, 404, { error: "Unknown Hermes station" });
    const body = await readJson<{ action: HermesAction | 'chat.open'; profile?: string; body?: Record<string, unknown> }>(req);
    const profile = body.profile ?? 'default';
    try {
      if (body.action === 'chat.open') {
        const bridge = await hermesBridge(envId, env.hermes.workspaceRoot);
        return sendJson(res, 200, { threadId: await bridge.openBotChat(profile) });
      }
      // Profile mutations cannot race with starting a turn in another station/browser.
      const mutatingProfile = ['profiles.update', 'profiles.delete'].includes(body.action);
      const release = mutatingProfile ? acquireBot(profile, 'management') : undefined;
      try {
        const result = await hermesManager.request(body.action, profile, body.body, env.hermes.workspaceRoot);
        return sendJson(res, 200, result);
      } finally { release?.(); }
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
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
    if (err instanceof UpdateConflict) return sendJson(res, 409, { error: err.message });
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
  let upstreamUrl: URL;
  let token: string;
  try {
    // Also refuses a machine on an orchestration protocol this Command doesn't speak.
    upstreamUrl = await t3SocketUrl(registry, env, "t3-command");
    token = await registry.tokenFor(env);
  } catch (err) {
    if (client.readyState === WebSocket.OPEN) client.close(CLOSE.upstreamFailed, (err as Error).message.slice(0, 120));
    return;
  }
  client.off("message", hold);
  if (client.readyState !== WebSocket.OPEN) return;
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
  if (config.managedUpdates) process.send?.({ type: "t3-command-ready" });
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
  storage.stop();
  t3Versions.stop();
  longTurns.stop();
  await recorder.stop();
  await hostHistory.stop();
  await comms.flush();
  await readState.flush();
  await push.flush();
  await followUps.flush();
  await dispatches.flush();
  await Promise.all([...hermesBridges.values()].map(async (bridge) => (await bridge).close()));
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
