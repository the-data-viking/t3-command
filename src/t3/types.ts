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
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settledAt: string | null;
  unsettledAt: string | null;
  snoozedUntil: string | null;
  pinnedAt: string | null;
}

export type ShellStreamItem =
  | { kind: "snapshot"; snapshot: { snapshotSequence: number; projects: ProjectShell[]; threads: ThreadShell[] } }
  | { kind: "synchronized" }
  | { kind: "project-upserted"; sequence: number; project: ProjectShell }
  | { kind: "project-removed"; sequence: number; projectId: string }
  | { kind: "thread-upserted"; sequence: number; thread: ThreadShell }
  | { kind: "thread-removed"; sequence: number; threadId: string };

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "reasoning";
  text: string;
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
}

export interface ServerConfig {
  providers: Provider[];
}

/** A pending approval or question, derived from a thread's activities. */
export interface PendingRequest {
  requestId: string;
  kind: "approval" | "user-input";
  activity: Activity;
}
