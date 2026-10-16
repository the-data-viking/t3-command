// The one place Command builds a T3 WebSocket URL. It checks the machine's advertised
// orchestration protocol and explicitly requests v2 (`?orchestrationProtocol=2`, like T3's
// own client). Unsupported future versions are refused before any RPC is sent.

import { SUPPORTED_PROTOCOL_VERSIONS } from "../shared/api.ts";
import type { Registry, StoredEnv } from "./registry.ts";

export class ProtocolUnsupported extends Error {
  readonly version: number;
  constructor(label: string, serverVersion: string | undefined, version: number) {
    super(`${label} runs T3 ${serverVersion ?? "?"} with orchestration protocol v${version}; this Command speaks v${SUPPORTED_PROTOCOL_VERSIONS.join(", v")}. Update Command.`);
    this.version = version;
  }
}

/** Query parameter T3 clients use to ask for a protocol newer than 1. */
export function withProtocol(url: URL, version: number): URL {
  if (version > 1) url.searchParams.set("orchestrationProtocol", String(version));
  return url;
}

export async function t3SocketUrl(registry: Registry, env: StoredEnv, clientAppVersion: string): Promise<URL> {
  const status = await registry.status(env.id);
  const version = status?.protocolVersion ?? 1;
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(version)) throw new ProtocolUnsupported(env.label, status?.serverVersion, version);
  const url = new URL("/ws", await registry.resolveUrl(env));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientSurface", "web");
  url.searchParams.set("clientAppVersion", clientAppVersion);
  return withProtocol(url, version);
}
