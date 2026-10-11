import type http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Registry } from "./registry.ts";

/** Only signed T3 asset paths may be proxied; never forward tokens to arbitrary URLs. */
export function upstreamAssetUrl(baseUrl: string, assetPath: string): URL {
  if (!assetPath.startsWith("/api/assets/") || /[\\\r\n]/.test(assetPath)) throw new Error("Invalid asset path");
  const base = new URL(baseUrl);
  const url = new URL(assetPath, base);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/assets/")) throw new Error("Invalid asset path");
  return url;
}

/** Caller must apply t3-command's identity check before serving any environment asset. */
export async function serveEnvironmentAsset(req: http.IncomingMessage, res: http.ServerResponse,
  registry: Registry, envId: string, assetPath: string): Promise<void> {
  const fail = (status: number, error: string) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error }));
  };
  const env = registry.get(envId);
  if (!env) return fail(404, "Unknown environment");
  if (env.hermes) return fail(404, "Hermes image assets are not supported");
  try {
    const url = upstreamAssetUrl(await registry.resolveUrl(env), assetPath);
    const token = await registry.tokenFor(env);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (req.headers.range) headers.range = req.headers.range;
    if (typeof req.headers["if-range"] === "string") headers["if-range"] = req.headers["if-range"];
    const upstream = await fetch(url, { method: req.method, headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!upstream.ok && upstream.status !== 304) {
      await upstream.body?.cancel();
      if (upstream.status === 401 || upstream.status === 403) registry.tokenRejected(envId);
      return fail(upstream.status, "T3 image unavailable");
    }
    const contentType = upstream.headers.get("content-type");
    if (upstream.status !== 304 && !contentType?.toLowerCase().startsWith("image/")) {
      await upstream.body?.cancel();
      return fail(415, "Asset is not an image");
    }
    const responseHeaders: Record<string, string> = {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // SVGs opened in a tab must not run scripts on t3-command's origin.
      "content-security-policy": "default-src 'none'; sandbox",
    };
    for (const name of ["content-type", "content-disposition", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (req.method === "HEAD" || !upstream.body) res.end();
    else await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    if (!res.headersSent) fail(502, "Could not load image from T3");
    else res.destroy();
  }
}
