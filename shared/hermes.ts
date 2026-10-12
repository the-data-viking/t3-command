export interface HermesBot {
  name: string;
  title: string;
  description: string;
  model: string | null;
  provider: string | null;
  skillCount: number;
  isDefault: boolean;
}
export interface HermesBotDetail extends HermesBot {
  soul: string;
  memory: string;
  userMemory: string;
  memoryProvider: string;
  skills: Array<{ name: string; enabled: boolean }>;
  toolsets: string[];
  availableToolsets: Array<{ name: string; description: string }>;
  mcpServers: Array<{ name: string; enabled: boolean }>;
}
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
export type HermesAction = 'profiles.list' | 'profiles.path' | 'profiles.get' | 'profiles.create' | 'profiles.update' | 'profiles.delete'
  | 'jobs.list' | 'jobs.create' | 'jobs.update' | 'jobs.pause' | 'jobs.resume' | 'jobs.trigger' | 'jobs.delete'
  | 'jobs.runs' | 'jobs.output' | 'session.open' | 'session.read';
