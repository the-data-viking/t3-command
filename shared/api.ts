// Types shared by the t3-command server (server/) and the UI (src/).
// Tokens never appear here: they stay on the server.

/** Orchestration protocol versions this build of t3-command knows how to speak. */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

export type EnvStatus =
  | "ok" // reachable, authenticated, supported protocol
  | "needs-pairing" // no token, or the token was rejected / expired
  | "needs-update" // environment speaks a protocol version we don't support
  | "unreachable"; // couldn't reach /.well-known/t3/environment

export interface EnvSummary {
  id: string;
  label: string;
  /** How the t3-command server reaches it: http(s)://host:port, or ssh://destination for SSH bases. */
  url: string;
  status: EnvStatus;
  statusDetail?: string;
  serverVersion?: string;
  protocolVersion?: number;
  tokenExpiresAt?: string;
  addedAt: string;
}

export interface MeResponse {
  user: string;
  devMode: boolean;
}

export interface AddEnvRequest {
  /** Direct base: T3 server URL (optional when `credential` is a full pairing link). */
  url?: string;
  /** One-time pairing credential or pairing link from T3's Settings → Connections. */
  credential?: string;
  /** SSH base: t3-command finds the T3 server over SSH, tunnels to it, and pairs automatically. */
  ssh?: { target: string; port?: number };
  label?: string;
}

export interface ApiError {
  error: string;
}
