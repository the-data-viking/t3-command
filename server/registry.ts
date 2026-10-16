// Environment registry: which T3 servers t3-command talks to, and the token for each.
// Tokens are stored on disk with owner-only permissions and never leave this process
// except as an Authorization header to the T3 server they belong to. Linked bases are the
// exception: their tokens belong to T3 desktop and are read from its encrypted catalog on demand.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SUPPORTED_PROTOCOL_VERSIONS, type EnvStatus, type EnvSummary, type T3SelfUpdate } from "../shared/api.ts";
import { CatalogError, forgetCachedCatalog, readDesktopConnections } from "./desktop-catalog.ts";
import { createPairingCredential, discover, SshError, SshTunnels, validateTarget, type SshTarget } from "./ssh.ts";
import { probeHermes } from "./hermes/acp.ts";

export interface StoredEnv {
  id: string;
  label: string;
  /** Direct bases: the T3 server's URL. SSH bases: unset; the URL is a local tunnel. */
  url?: string;
  ssh?: SshTarget;
  /** Linked bases use T3 desktop's own connection on this machine; no token is stored here. */
  linked?: { connectionId: string };
  token?: string;
  tokenExpiresAt?: string;
  scopes?: string;
  addedAt: string;
  hermes?: { workspaceRoot: string };
}

interface EnvironmentDescriptor {
  environmentId?: string;
  label?: string;
  serverVersion?: string;
  orchestrationProtocolVersion?: number;
  capabilities?: { serverSelfUpdate?: string; desktopAppUpdate?: boolean; serverUpdateThreadContinuation?: boolean };
}

/** A machine's remote-update support from its descriptor; undefined if it can only be relaunched by hand. */
export function selfUpdateOf(descriptor: EnvironmentDescriptor): T3SelfUpdate | undefined {
  const c = descriptor.capabilities;
  const method = c?.serverSelfUpdate;
  if (method !== "boot-service" && method !== "respawn" && method !== "desktop-managed") return undefined;
  return { method, desktopAppUpdate: c?.desktopAppUpdate === true, continuesThreads: c?.serverUpdateThreadContinuation === true };
}

/** v2 no longer implies diagnostics/files/maintenance from the broad orchestration scopes. */
export function pairingScopes(version: number): string {
  const legacy = "orchestration:read orchestration:operate";
  return version === 2 ? `${legacy} diagnostics:read filesystem:read filesystem:write source-control:write providers:manage environment:maintain terminal:read terminal:operate` : legacy;
}

export function pairingNotice(permissions: readonly string[] | undefined, linked = false): string | undefined {
  if (!permissions) return undefined; // Older servers don't report granular grants.
  const features = [
    ["diagnostics:read", "usage estimates"], ["filesystem:read", "file browsing"], ["filesystem:write", "new folders"],
    ["source-control:write", "checkout changes"], ["providers:manage", "provider updates"],
    ["environment:maintain", "T3 updates"], ["terminal:operate", "remote storage checks"],
  ].filter(([scope]) => !permissions.includes(scope)).map(([, feature]) => feature);
  if (!features.length) return undefined;
  return `Pair this machine again to enable ${features.join(", ")}. ${linked ? "Reconnect it in T3 desktop." : "Create a new pairing link in T3 Settings → Connections and add it below, or run npm run pair:local for this host."}`;
}
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
  private tunnels = new SshTunnels();
  private statusCache = new Map<string, { at: number; summary: EnvSummary }>();
  private readonly file: string;
  private readonly dataDir: string;
  private readonly hermesLaunch: { command: string; args: string[] };

  constructor(dataDir: string, hermesLaunch = { command: "hermes", args: ["acp"] }) {
    this.dataDir = dataDir;
    this.hermesLaunch = hermesLaunch;
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

  /** Every registered environment's id, without probing their status. */
  ids(): string[] {
    return [...this.envs.keys()];
  }

  get(id: string): StoredEnv | undefined {
    return this.envs.get(id);
  }

  /** Where to reach an environment's T3 server right now (opens the SSH tunnel if needed). */
  resolveUrl(env: StoredEnv): Promise<string> {
    if (env.hermes) return Promise.reject(new UserError("Hermes uses local ACP, not a T3 server URL"));
    if (env.ssh) return this.tunnels.ensure(env.id, env.ssh);
    return Promise.resolve(env.url!);
  }

  /** The bearer token to use for an environment right now. */
  async tokenFor(env: StoredEnv): Promise<string> {
    if (env.hermes) throw new UserError("Hermes has no T3 pairing token");
    if (!env.linked) return env.token!;
    const connection = (await readDesktopConnections()).find((c) => c.connectionId === env.linked!.connectionId);
    if (!connection) throw new CatalogError(`T3 desktop no longer has a connection to "${env.label}"`);
    return connection.token;
  }

  /** A linked base's token was rejected: re-read T3 desktop's catalog next time (it may have re-paired). */
  tokenRejected(id: string): void {
    if (this.envs.get(id)?.linked) forgetCachedCatalog();
    this.statusCache.delete(id);
  }

  /**
   * Link every direct (bearer) connection T3 desktop has saved on this machine. Environments that
   * are already paired with t3-command directly are left alone.
   */
  async importDesktopConnections(): Promise<{ linked: string[]; skipped: string[] }> {
    let connections;
    try {
      connections = await readDesktopConnections({ fresh: true });
    } catch (err) {
      if (err instanceof CatalogError) throw new UserError(err.message);
      throw err;
    }
    const linked: string[] = [];
    const skipped: string[] = [];
    for (const c of connections) {
      const existing = this.envs.get(c.environmentId);
      if (existing && !existing.linked) {
        skipped.push(`${c.label} (already paired directly)`);
        continue;
      }
      this.envs.set(c.environmentId, {
        id: c.environmentId,
        label: existing?.label ?? c.label,
        url: c.httpBaseUrl,
        linked: { connectionId: c.connectionId },
        addedAt: existing?.addedAt ?? new Date().toISOString(),
      });
      this.statusCache.delete(c.environmentId);
      linked.push(c.label);
    }
    await this.save();
    return { linked, skipped };
  }

  /** Exchange a one-time pairing credential for a token and remember the environment. */
  async add(rawUrl: string, rawCredential: string, label?: string): Promise<EnvSummary> {
    const input = parsePairingInput(rawUrl, rawCredential);
    if (!input.credential) throw new UserError("Pairing link or credential is required");
    if (!input.url) throw new UserError("T3 server URL is required");
    return this.pair(normalizeUrl(input.url), input.credential, label, {});
  }

  async addHermes(rawWorkspace: string, label?: string): Promise<EnvSummary> {
    const expanded = rawWorkspace.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
    if (!path.isAbsolute(expanded)) throw new UserError("Hermes workspace must be an absolute local directory path");
    let workspaceRoot: string;
    try {
      workspaceRoot = await fs.realpath(expanded);
      if (!(await fs.stat(workspaceRoot)).isDirectory()) throw new Error("Not a directory");
      await probeHermes(this.hermesLaunch.command, this.hermesLaunch.args, workspaceRoot);
    } catch (err) {
      throw new UserError(`Couldn't launch local Hermes: ${(err as Error).message}. Run hermes setup and hermes acp --check on this host.`);
    }
    const existing = [...this.envs.values()].find((env) => env.hermes?.workspaceRoot === workspaceRoot);
    const stored: StoredEnv = {
      id: existing?.id ?? `hermes-${randomUUID()}`,
      label: label?.trim() || existing?.label || `Hermes · ${path.basename(workspaceRoot)}`,
      hermes: { workspaceRoot },
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    this.envs.set(stored.id, stored);
    this.statusCache.delete(stored.id);
    await this.save();
    return this.summary(stored);
  }

  /** Add a T3 server reached over SSH: find it, tunnel to it, and pair using T3's own CLI there. */
  async addSsh(rawTarget: string, port: number | undefined, label?: string): Promise<EnvSummary> {
    let ssh: SshTarget;
    try {
      ssh = { target: validateTarget(rawTarget), ...(port ? { port } : {}) };
    } catch (err) {
      throw new UserError((err as Error).message);
    }
    const tempId = `pending-ssh:${ssh.target}`;
    try {
      const { runner } = await discover(ssh);
      if (!runner) {
        throw new UserError(`${ssh.target} has no T3 SSH launcher yet. Connect to it once from T3 desktop, then retry.`);
      }
      const url = await this.tunnels.ensure(tempId, ssh);
      const credential = await createPairingCredential(ssh, runner);
      return await this.pair(url, credential, label || ssh.target, { ssh });
    } catch (err) {
      if (err instanceof SshError) throw new UserError(err.message);
      throw err;
    } finally {
      this.tunnels.close(tempId);
    }
  }

  private async pair(url: string, credential: string, label: string | undefined, where: { ssh?: SshTarget }): Promise<EnvSummary> {
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
      scope: pairingScopes(version),
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
      ...(where.ssh ? { ssh: where.ssh } : { url }),
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
    this.tunnels.close(id);
    const existed = this.envs.delete(id);
    this.statusCache.delete(id);
    if (existed) await this.save();
    return existed;
  }

  async list(): Promise<EnvSummary[]> {
    return Promise.all([...this.envs.values()].map((e) => this.summary(e)));
  }

  /** One environment's status (reachability, pairing, T3 version and protocol), cached briefly. */
  status(id: string): Promise<EnvSummary> | undefined {
    const env = this.envs.get(id);
    return env ? this.summary(env) : undefined;
  }

  private async summary(env: StoredEnv): Promise<EnvSummary> {
    const cached = this.statusCache.get(env.id);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.summary;

    const base: EnvSummary = {
      id: env.id,
      label: env.label,
      url: env.hermes ? env.hermes.workspaceRoot : env.ssh ? `ssh://${env.ssh.target}${env.ssh.port ? `:${env.ssh.port}` : ""}` : env.url!,
      ...(env.hermes ? { kind: "hermes" as const } : {}),
      status: "ok",
      tokenExpiresAt: env.tokenExpiresAt,
      addedAt: env.addedAt,
      ...(env.linked ? { linked: true } : {}),
    };
    const set = (status: EnvStatus, statusDetail?: string): EnvSummary => {
      const summary = { ...base, status, statusDetail };
      this.statusCache.set(env.id, { at: Date.now(), summary });
      return summary;
    };

    if (env.hermes) {
      try {
        base.serverVersion = await probeHermes(this.hermesLaunch.command, this.hermesLaunch.args, env.hermes.workspaceRoot);
        return set("ok");
      } catch (err) { return set("unreachable", (err as Error).message); }
    }

    let url: string;
    try {
      url = await this.resolveUrl(env);
    } catch (err) {
      return set("unreachable", (err as Error).message);
    }
    try {
      const descriptor = await fetchDescriptor(url);
      base.serverVersion = descriptor.serverVersion;
      base.protocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
      const selfUpdate = selfUpdateOf(descriptor);
      if (selfUpdate) base.selfUpdate = selfUpdate;
    } catch (err) {
      return set("unreachable", (err as Error).message);
    }
    if (!protocolSupported(base.protocolVersion)) {
      return set("needs-update", `T3 ${base.serverVersion} uses orchestration protocol v${base.protocolVersion}`);
    }
    let token: string;
    try {
      token = await this.tokenFor(env);
    } catch (err) {
      return set("needs-pairing", (err as Error).message);
    }
    try {
      const res = await fetchWithTimeout(`${url}/api/auth/session`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const session = (await res.json()) as { authenticated?: boolean; expiresAt?: string; permissions?: string[] };
      if (!session.authenticated) {
        return set("needs-pairing", env.linked ? "T3 desktop's connection was revoked or expired; reconnect it in T3 desktop" : "Token expired or revoked");
      }
      if (env.linked) base.tokenExpiresAt = session.expiresAt;
      if (base.protocolVersion === 2) base.permissionNotice = pairingNotice(session.permissions, !!env.linked);
    } catch (err) {
      return set("unreachable", (err as Error).message);
    }
    return set("ok");
  }
}
