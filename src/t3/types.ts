// T3 Code orchestration protocol v1 types — only the parts t3-command uses.
// See docs/PROTOCOL.md. Fields T3 sends that we don't read are left out (or typed loosely).

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";
export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string | boolean }>;
}

export interface RepositoryIdentity {
  /** Stable across machines, e.g. "github.com/owner/repo". */
  canonicalKey: string;
  displayName?: string;
  name?: string;
}

export interface ProjectShell {
  id: string;
  title: string;
  workspaceRoot: string;
  /** Null when T3 couldn't identify a git remote for the workspace. */
  repositoryIdentity?: RepositoryIdentity | null;
  defaultModelSelection: ModelSelection | null;
  defaultThreadEnvMode?: "local" | "worktree" | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
export type TurnState = "running" | "interrupted" | "completed" | "error";

export interface ThreadSession {
  threadId: string;
  status: SessionStatus;
  providerName: string;
  providerInstanceId?: string;
  runtimeMode: RuntimeMode;
  activeTurnId: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface LatestTurn {
  turnId: string;
  state: TurnState;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
}

export interface ThreadShell {
  hermesProfile?: string;
  hermesBotChat?: boolean;
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: LatestTurn | null;
  session: ThreadSession | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan?: boolean;
  /**
   * Work still running after the turn settled. "working": background agents (subagents,
   * workflows). "monitoring": only watch loops (monitor tasks, background shells) remain.
   * In-memory on the T3 server, so it resets to null when that server restarts.
   */
  backgroundLiveness?: "working" | "monitoring" | null;
  /** The agent's current plan step while a turn runs; cleared when it settles. */
  planProgress?: { step: string; completedSteps: number; totalSteps: number } | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settledAt: string | null;
  unsettledAt: string | null;
  snoozedUntil: string | null;
  pinnedAt: string | null;
  /** Pull requests T3 has linked to this thread, with its last synced snapshot of each. */
  pullRequests?: ThreadPullRequest[];
}

export interface ThreadPullRequest {
  host: string;
  repository: string;
  number: number;
  url: string;
  snapshot: {
    state: "open" | "closed" | "merged" | string;
    title: string;
    headBranch: string;
    baseBranch: string;
    isDraft: boolean;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    reviewDecision?: string | null;
    checksState?: string | null;
    /** When it merged, if Command read that from GitHub (T3's snapshot doesn't carry it). */
    mergedAt?: string | null;
  } | null;
}

export type ShellStreamItem =
  | { kind: "snapshot"; snapshot: { snapshotSequence: number; projects: ProjectShell[]; threads: ThreadShell[] } }
  | { kind: "synchronized" }
  | { kind: "project-upserted"; sequence: number; project: ProjectShell }
  | { kind: "project-removed"; sequence: number; projectId: string }
  | { kind: "thread-upserted"; sequence: number; thread: ThreadShell }
  | { kind: "thread-removed"; sequence: number; threadId: string };

export interface MessageAttachment {
  type: string;
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export type ImageResource =
  | { _tag: "media-file"; threadId: string; path: string }
  | { _tag: "attachment"; attachmentId: string; fileName?: string; mimeType?: string; disposition?: "inline" };

export interface AssetUrl {
  relativeUrl: string;
  expiresAt: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "reasoning";
  text: string;
  attachments?: MessageAttachment[];
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  tone: "info" | "tool" | "approval" | "error";
  kind: string;
  summary: string;
  payload: Record<string, unknown> | null;
  turnId: string | null;
  sequence?: number;
  createdAt: string;
}

export interface Checkpoint {
  turnId: string;
  checkpointTurnCount: number;
  /** "missing"/"error" checkpoints can't be diffed or restored. */
  status?: "ready" | "missing" | "error";
  files: Array<{ path: string; kind: string; additions: number; deletions: number }>;
  completedAt: string;
}

export interface OrchestrationThread extends Omit<ThreadShell, "hasPendingApprovals" | "hasPendingUserInput"> {
  messages: Message[];
  activities: Activity[];
  checkpoints: Checkpoint[];
}

export interface OrchestrationEvent {
  sequence: number;
  aggregateKind: "project" | "thread";
  aggregateId: string;
  occurredAt: string;
  type: string;
  payload: Record<string, unknown>;
}

export type ThreadStreamItem =
  | { kind: "snapshot"; snapshot: { snapshotSequence: number; thread: OrchestrationThread } }
  | { kind: "synchronized" }
  | { kind: "event"; event: OrchestrationEvent };

export interface ModelOptionDescriptor {
  id: string;
  label: string;
  type: "select" | "boolean";
  options?: Array<{ id: string; label: string; isDefault?: boolean }>;
}

export interface ProviderModel {
  slug: string;
  name: string;
  isDefault?: boolean;
  capabilities?: { optionDescriptors?: ModelOptionDescriptor[] };
}

export interface Provider {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  models: ProviderModel[];
  /** An adapter can expose only the permission modes its agent actually supports. */
  runtimeModes?: Array<{ id: RuntimeMode; label: string }>;
  /** Absent means supported; only an explicit false rules out checkpoint rollback. */
  supportsConversationRollback?: boolean;
  /** Health notes such as an outdated CLI. */
  message?: string;
  usageLimits?: ProviderUsageLimits;
  /** Installed CLI version; null when T3 couldn't read it. */
  version?: string | null;
  versionAdvisory?: ProviderVersionAdvisory;
  compatibilityAdvisory?: { status: ProviderCompatibility; latestVersionStatus?: ProviderCompatibility; message: string | null };
  /** Progress of the last `server.updateProvider` run for this instance. */
  updateState?: ProviderUpdateState;
}

export type ProviderCompatibility = "unknown" | "supported" | "graceful" | "unsupported" | "broken";

/** Whether the installed CLI is behind the latest release, and whether T3 can update it itself. */
export interface ProviderVersionAdvisory {
  status: "unknown" | "current" | "behind_latest";
  currentVersion: string | null;
  latestVersion: string | null;
  updateCommand: string | null;
  canUpdate: boolean;
  message: string | null;
}

export interface ProviderUpdateState {
  status: "idle" | "queued" | "running" | "succeeded" | "failed" | "unchanged";
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  output: string | null;
}

/** Quota windows a provider reports for its signed-in account. */
export interface ProviderUsageLimits {
  checkedAt: string;
  windows: Array<{ id: string; kind: "session" | "weekly" | "monthly" | "other"; label: string; usedPercent: number; resetsAt?: string }>;
  credentialFingerprint?: string;
  unavailable?: { reason: "unsupported" | "probeFailed"; message?: string };
}

/** Git state of a workspace, from T3's subscribeVcsStatus stream. */
export interface VcsLocalStatus {
  isRepo: boolean;
  refName: string | null;
  isDefaultRef: boolean;
  hasWorkingTreeChanges: boolean;
  workingTree: { files: Array<{ path: string; insertions: number; deletions: number }>; insertions: number; deletions: number };
}
export interface VcsRemoteStatus {
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  pr: { number: number; title: string; url: string; state: string } | null;
}
export type VcsStatusEvent =
  | { _tag: "snapshot"; local: VcsLocalStatus; remote: VcsRemoteStatus | null }
  | { _tag: "localUpdated"; local: VcsLocalStatus }
  | { _tag: "remoteUpdated"; remote: VcsRemoteStatus | null };

/** filesystem.browse: the folder listed and its subfolders (hidden ones only when asked for). */
export interface FolderListing {
  parentPath: string;
  entries: Array<{ name: string; fullPath: string }>;
}

/** One clone T3 is tracking (subscribeProjectClones); kept after it ends. */
export interface ProjectClone {
  projectId: string;
  remoteUrl: string;
  destinationPath: string;
  phase: "running" | "done" | "failed" | "cancelled";
  /** git's own clone stages, in order. */
  stage: "connecting" | "counting" | "receiving" | "resolving" | "checkout";
  /** Percent of the current stage. */
  percent: number | null;
  /** Transfer size and rate, from git's progress line. */
  detail: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type ServerConfigEvent =
  | { type: "snapshot"; config: ServerConfig }
  | { type: "providerStatuses"; payload: { providers: Provider[] } }
  | { type: string };

export interface ServerConfig {
  providers: Provider[];
}

/** A pending approval or question, derived from a thread's activities. */
export interface PendingRequest {
  requestId: string;
  kind: "approval" | "user-input";
  activity: Activity;
}

/** T3's pull request detail (`pullRequests.detail`): the parts Command reads. */
export interface PullRequestDetail {
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  mergeability: "mergeable" | "conflicting" | "unknown";
  additions: number;
  deletions: number;
  changedFiles: number;
  headBranch: string;
  baseBranch: string;
  mergedAt: string | null;
  reviewers: Array<{ login: string; name: string | null; isBot?: boolean }>;
  checks: Array<{ name: string; status: "pending" | "action-required" | "success" | "failure" | "skipped" | "neutral" | "cancelled"; description: string | null; url: string | null }>;
  baseComparison?: "up-to-date" | "behind" | "unknown";
  behindBy?: number;
}
