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
  /** T3 server base URL as seen from the t3-command server, e.g. http://127.0.0.1:3773 */
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
  url: string;
  /** One-time pairing credential from T3's Settings → Connections or `t3 auth pairing create`. */
  credential: string;
  label?: string;
}

export interface ApiError {
  error: string;
}
