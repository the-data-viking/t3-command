// Environment registry: which T3 servers t3-command talks to, and the token for each.
// Tokens are stored on disk with owner-only permissions and never leave this process
// except as an Authorization header to the T3 server they belong to.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SUPPORTED_PROTOCOL_VERSIONS, type EnvStatus, type EnvSummary } from "../shared/api.ts";

interface StoredEnv {
  id: string;
  label: string;
  url: string;
  token: string;
  tokenExpiresAt?: string;
  scopes?: string;
  addedAt: string;
}

interface EnvironmentDescriptor {
  environmentId?: string;
  label?: string;
  serverVersion?: string;
  orchestrationProtocolVersion?: number;
}

/** Scopes t3-command asks for: read and drive threads. No access management, terminals, or relay. */
const REQUESTED_SCOPES = "orchestration:read orchestration:operate";
const STATUS_TTL_MS = 10_000;
const HTTP_TIMEOUT_MS = 5_000;

export class UserError extends Error {}

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UserError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UserError("Environment URL must start with http:// or https://");
  }
  return url.origin;
}

/** Accept a full pairing link (https://server:port/pair#token=…) as well as a bare credential. */
export function parsePairingInput(rawUrl: string, rawCredential: string): { url: string; credential: string } {
  const input = rawCredential.trim();
  try {
    const link = new URL(input);
    const token = new URLSearchParams(link.hash.slice(1)).get("token") ?? link.searchParams.get("token");
    if (token) return { url: rawUrl.trim() || link.origin, credential: token };
  } catch {
    // Not a URL: a bare credential.
  }
  return { url: rawUrl, credential: input };
}

function protocolSupported(version: number): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(version);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

async function fetchDescriptor(baseUrl: string): Promise<EnvironmentDescriptor> {
  const res = await fetchWithTimeout(`${baseUrl}/.well-known/t3/environment`);
  if (!res.ok) throw new Error(`GET /.well-known/t3/environment returned ${res.status}`);
  return (await res.json()) as EnvironmentDescriptor;
}

export class Registry {
  private envs = new Map<string, StoredEnv>();
  private statusCache = new Map<string, { at: number; summary: EnvSummary }>();
  private readonly file: string;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "environments.json");
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await fs.readFile(this.file, "utf8")) as StoredEnv[];
      this.envs = new Map(stored.map((e) => [e.id, e]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async save(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...this.envs.values()], null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  get(id: string): StoredEnv | undefined {
    return this.envs.get(id);
  }

  /** Exchange a one-time pairing credential for a token and remember the environment. */
  async add(rawUrl: string, rawCredential: string, label?: string): Promise<EnvSummary> {
    const input = parsePairingInput(rawUrl, rawCredential);
    if (!input.credential) throw new UserError("Pairing link or credential is required");
    if (!input.url) throw new UserError("T3 server URL is required");
    const url = normalizeUrl(input.url);
    const credential = input.credential;

    let descriptor: EnvironmentDescriptor;
    try {
      descriptor = await fetchDescriptor(url);
    } catch (err) {
      throw new UserError(`Couldn't reach a T3 server at ${url}: ${(err as Error).message}`);
    }
    const version = descriptor.orchestrationProtocolVersion ?? 1;
    if (!protocolSupported(version)) {
      throw new UserError(
        `${url} speaks T3 orchestration protocol v${version}; this t3-command supports ` +
          `v${SUPPORTED_PROTOCOL_VERSIONS.join(", v")}. Update t3-command first.`,
      );
    }

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential.trim(),
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: REQUESTED_SCOPES,
      client_label: "t3-command",
      client_device_type: "desktop",
    });
    const res = await fetchWithTimeout(`${url}/oauth/token`, { method: "POST", body });
    if (!res.ok) {
      // Don't echo the response body: it could reflect the credential back.
      throw new UserError(
        `Pairing was rejected (HTTP ${res.status}). Pairing credentials work once and expire after a few minutes; create a new one.`,
      );
    }
    const token = (await res.json()) as { access_token: string; expires_in?: number; scope?: string };

    const id = descriptor.environmentId ?? randomUUID();
    const existing = this.envs.get(id);
    const stored: StoredEnv = {
      id,
      label: label?.trim() || existing?.label || descriptor.label || new URL(url).hostname,
      url,
      token: token.access_token,
      tokenExpiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : undefined,
      scopes: token.scope,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    this.envs.set(id, stored);
    this.statusCache.delete(id);
    await this.save();
    return this.summary(stored);
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.envs.delete(id);
    this.statusCache.delete(id);
    if (existed) await this.save();
    return existed;
  }

  /** Mark an environment's token as rejected (e.g. the WebSocket upgrade got a 401). */
  invalidateStatus(id: string): void {
    this.statusCache.delete(id);
  }

  async list(): Promise<EnvSummary[]> {
    return Promise.all([...this.envs.values()].map((e) => this.summary(e)));
  }

  private async summary(env: StoredEnv): Promise<EnvSummary> {
    const cached = this.statusCache.get(env.id);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.summary;

    const base: EnvSummary = {
      id: env.id,
      label: env.label,
      url: env.url,
      status: "ok",
      tokenExpiresAt: env.tokenExpiresAt,
      addedAt: env.addedAt,
    };
    const set = (status: EnvStatus, statusDetail?: string): EnvSummary => {
      const summary = { ...base, status, statusDetail };
      this.statusCache.set(env.id, { at: Date.now(), summary });
      return summary;
    };

    try {
      const descriptor = await fetchDescriptor(env.url);
      base.serverVersion = descriptor.serverVersion;
      base.protocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
    } catch (err) {
      return set("unreachable", (err as Error).message);
    }
    if (!protocolSupported(base.protocolVersion)) {
      return set("needs-update", `T3 ${base.serverVersion} uses orchestration protocol v${base.protocolVersion}`);
    }
    try {
      const res = await fetchWithTimeout(`${env.url}/api/auth/session`, {
        headers: { authorization: `Bearer ${env.token}` },
      });
      const session = (await res.json()) as { authenticated?: boolean };
      if (!session.authenticated) return set("needs-pairing", "Token expired or revoked");
    } catch (err) {
      return set("unreachable", (err as Error).message);
    }
    return set("ok");
  }
}
