import type { HermesBot } from '../../shared/hermes';
import type { GameState } from '../store';
import { isHistory, unitState, type UnitState } from './derive';
import type { ThreadShell } from './types';

export interface BotSession { envId: string; thread: ThreadShell; state: UnitState }
export interface BotOperator extends HermesBot {
  envId: string;
  sessions: BotSession[];
  state: UnitState;
  observed: boolean;
  configured: boolean;
}
const urgency: UnitState[] = ['alert', 'question', 'working', 'error', 'monitoring', 'done', 'idle', 'sleeping'];
export const BOT_STATE_LABELS: Record<UnitState, string> = {
  alert: 'Needs approval', question: 'Has a question', working: 'Working', error: 'Turn failed',
  monitoring: 'Monitoring', done: 'Report ready', idle: 'On call', sleeping: 'On call',
};
export { HERMES_COLOR } from '../game/theme';
export function botColor(profile: string): number {
  let hash = 0;
  for (const ch of profile) hash = Math.imul(hash, 31) + ch.charCodeAt(0) | 0;
  return [0x9bc9c2, 0xb8bada, 0xe1b5a4, 0xb9c7a5, 0xd8c599][(hash >>> 0) % 5];
}

/** Persistent identities: a bot's task sessions never become extra operators. */
export function botOperators(state: Pick<GameState, 'envs' | 'hermesCatalog'>): BotOperator[] {
  const envs = Object.values(state.envs).filter(e => e.summary.kind === 'hermes')
    .sort((a, b) => a.summary.addedAt.localeCompare(b.summary.addedAt));
  if (!envs.length) return [];
  const envId = envs.some(e => e.summary.id === state.hermesCatalog?.envId)
    ? state.hermesCatalog!.envId : envs[0].summary.id;
  const bots = new Map<string, BotOperator>();
  for (const bot of state.hermesCatalog?.bots ?? []) bots.set(bot.name, {
    ...bot, envId, sessions: [], state: 'idle', observed: false, configured: true,
  });
  for (const env of envs) for (const thread of Object.values(env.threads)) {
    if (isHistory(thread)) continue;
    const name = thread.hermesProfile ?? 'default';
    let bot = bots.get(name);
    if (!bot) {
      bot = { name, title: name, description: '', model: null, provider: null, skillCount: 0,
        isDefault: name === 'default', envId, sessions: [], state: 'idle', observed: false, configured: false };
      bots.set(name, bot);
    }
    bot.sessions.push({ envId: env.summary.id, thread, state: unitState(thread) });
  }
  for (const bot of bots.values()) {
    bot.sessions.sort((a, b) => urgency.indexOf(a.state) - urgency.indexOf(b.state)
      || b.thread.updatedAt.localeCompare(a.thread.updatedAt));
    const observed = bot.sessions.filter(s => state.envs[s.envId]?.connection === 'live');
    bot.state = observed[0]?.state ?? 'idle';
    bot.observed = observed.length > 0;
    if (bot.state === 'sleeping') bot.state = 'idle';
  }
  return [...bots.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.title.localeCompare(b.title));
}
