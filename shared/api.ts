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
  kind?: "t3" | "hermes";
  label: string;
  /** T3: HTTP URL or SSH destination. Local Hermes: workspace directory on the Command host. */
  url: string;
  status: EnvStatus;
  statusDetail?: string;
  serverVersion?: string;
  protocolVersion?: number;
  /** How this machine's T3 can update itself remotely (absent: only by relaunching it there). */
  selfUpdate?: T3SelfUpdate;
  tokenExpiresAt?: string;
  addedAt: string;
  /** Uses T3 desktop's own saved connection on the t3-command host (no separate pairing). */
  linked?: boolean;
}

/** T3's self-update support, from its environment descriptor's capabilities. */
export interface T3SelfUpdate {
  /** "boot-service": the T3 background service restarts into the new version; "respawn": the server
   * relaunches itself; "desktop-managed": the T3 desktop app updates and relaunches. */
  method: "boot-service" | "respawn" | "desktop-managed";
  /** The desktop app can be updated remotely (desktop-managed only). */
  desktopAppUpdate: boolean;
  /** Running turns can carry on through the restart instead of being interrupted. */
  continuesThreads: boolean;
}

/** The newest T3 release on npm (the `t3` package), as the Command server last saw it. */
export interface T3Latest { version: string | null; checkedAt: number }

export interface ImportDesktopResponse {
  linked: string[];
  skipped: string[];
}

export interface MeResponse {
  user: string;
  devMode: boolean;
}

export interface AddEnvRequest {
  /** Local Hermes ACP sessions, launched by the command host in this workspace. */
  hermes?: { workspaceRoot: string };
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

export type UpdatePhase = "idle" | "checking" | "available" | "fetching" | "installing" | "building" | "restarting" | "succeeded" | "failed";

export interface UpdateStatus {
  enabled: boolean;
  reason?: string;
  phase: UpdatePhase;
  currentCommit: string | null;
  localChanges: boolean;
  latestCommit: string | null;
  targetCommit: string | null;
  message: string;
  log: string;
  updatedAt: string;
}
