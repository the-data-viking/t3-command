import type http from "node:http";
import type { Registry } from "./registry.ts";
import { subagentSnapshot, type BoundedThreadSnapshot, type ThreadHistoryPage } from "../shared/thread-history.ts";

const MAX_BYTES = 64 * 1024 * 1024;
export class ThreadReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Fixed authenticated T3 endpoints only; never fall back to an unbounded projection. */
export async function readThreadData(registry: Registry, envId: string, threadId: string,
  kind: "bounded" | "subagents" | "history", cursor?: string, signal?: AbortSignal): Promise<BoundedThreadSnapshot | ThreadHistoryPage> {
  const env = registry.get(envId);
  if (!env || env.hermes) throw new ThreadReadError(404, "Unknown T3 environment");
  if (kind === "history" && (!cursor || cursor.length > 8192)) throw new ThreadReadError(400, "Invalid history cursor");
  const url = new URL(`/api/orchestration/threads/${encodeURIComponent(threadId)}/${kind === "history" ? "history" : "bounded"}`, await registry.resolveUrl(env));
  if (kind === "history") url.searchParams.set("cursor", cursor!);
  else url.searchParams.set("compactTurnItems", "1");
  const timeout = AbortSignal.timeout(30_000);
  const upstream = await fetch(url, { headers: { authorization: `Bearer ${await registry.tokenFor(env)}`, "x-t3-orchestration-protocol": "2" },
    redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    if (upstream.status === 401 || upstream.status === 403) registry.tokenRejected(envId);
    throw new ThreadReadError(upstream.status, upstream.status === 404
      ? "This T3 server cannot provide bounded thread history. Open this conversation in T3 Code."
      : `Could not load thread history from T3 (HTTP ${upstream.status})`);
  }
  if (!upstream.headers.get("content-type")?.includes("application/json")) {
    await upstream.body?.cancel();
    throw new ThreadReadError(502, "T3 did not return bounded thread history");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of upstream.body!) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      throw new ThreadReadError(413, "This history page is too large. Open this conversation in T3 Code.");
    }
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Number.isSafeInteger(value.snapshotSequence) || value.snapshotSequence < 0 || (kind === "history" ? !Array.isArray(value.items) : !value.projection?.thread)) {
    throw new ThreadReadError(502, "T3 returned an invalid history page");
  }
  return kind === "subagents" ? subagentSnapshot(value) : value;
}

/** Caller applies Command's identity check. Credentials and upstream errors stay on the server. */
export async function serveThreadData(_req: http.IncomingMessage, res: http.ServerResponse, registry: Registry,
  envId: string, threadId: string, kind: "bounded" | "subagents" | "history", cursor?: string): Promise<void> {
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", abort);
  try {
    const value = await readThreadData(registry, envId, threadId, kind, cursor, controller.signal);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
    res.end(JSON.stringify(value));
  } catch (err) {
    if (controller.signal.aborted) return;
    res.writeHead(err instanceof ThreadReadError ? err.status : 502, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: err instanceof ThreadReadError ? err.message : "Could not load bounded thread history from T3" }));
  } finally { res.off("close", abort); }
}
