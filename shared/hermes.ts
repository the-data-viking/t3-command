export const HERMES_EDIT_PERMISSIONS = [
  { id: 'approval-required', modeId: 'default', label: 'Ask before edits' },
  { id: 'auto-accept-edits', modeId: 'accept_edits', label: 'Accept workspace edits' },
] as const;

export interface HermesBot {
  name: string;
  title: string;
  description: string;
  model: string | null;
  provider: string | null;
  skillCount: number;
  isDefault: boolean;
}
export interface HermesBotIdentity extends HermesBot {
  soul: string;
  memory: string;
  userMemory: string;
  memoryProvider: string;
}
export interface HermesCapabilities {
  skills: Array<{ name: string; enabled: boolean }>;
  toolsets: string[];
  availableToolsets: Array<{ name: string; description: string }>;
  mcpServers: Array<{ name: string; enabled: boolean }>;
}
export interface HermesBotDetail extends HermesBotIdentity, HermesCapabilities {}
export interface HermesJob {
  id: string;
  name: string;
  prompt: string;
  schedule: { display?: string; kind?: string; [key: string]: unknown };
  enabled: boolean;
  state?: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  last_fire_error?: string | null;
  last_delivery_error?: string | null;
  model?: string | null;
  provider?: string | null;
  reasoning_effort?: string | null;
  workdir?: string | null;
  skills?: string[];
  deliver?: string;
  script?: string | null;
  no_agent?: boolean;
  monitor_url?: string | null;
  monitor_script?: string | null;
  context_from?: string[];
}
export interface HermesScheduler {
  running: boolean | null;
  heartbeatAge: number | null;
  error: string | null;
}
export interface HermesJobs { jobs: HermesJob[]; scheduler: HermesScheduler }
export interface HermesRun {
  id: string;
  status: string;
  claimed_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  session_id?: string | null;
}
export interface HermesSession {
  sessionId: string;
  source?: string;
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: string }>;
}
export type HermesAction = 'profiles.list' | 'profiles.path' | 'profiles.get' | 'profiles.identity' | 'profiles.capabilities' | 'profiles.create' | 'profiles.update' | 'profiles.delete'
  | 'jobs.list' | 'jobs.create' | 'jobs.update' | 'jobs.pause' | 'jobs.resume' | 'jobs.trigger' | 'jobs.delete'
  | 'jobs.runs' | 'jobs.output' | 'session.open' | 'session.read';

/** Only these operations are safe to coalesce/cache; everything else is a write barrier. */
export const HERMES_READ_ACTIONS: ReadonlySet<string> = new Set([
  'profiles.list', 'profiles.path', 'profiles.get', 'profiles.identity', 'profiles.capabilities',
  'jobs.list', 'jobs.runs', 'jobs.output', 'session.read',
]);
export function hermesReadTtl(action: string): number {
  if (action === 'profiles.list' || action === 'profiles.get' || action === 'profiles.identity' || action === 'profiles.capabilities') return 15_000;
  if (action === 'jobs.list') return 5_000;
  return 0; // Live transcript/history/path reads only coalesce while in flight.
}
