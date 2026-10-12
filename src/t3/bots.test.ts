import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnvWorld, GameState } from '../store';
import type { ThreadShell } from './types';
import { botOperators } from './bots';

function fixture(): Pick<GameState, 'envs' | 'hermesCatalog'> {
  const thread = (id: string, profile: string, status: string) => ({
    id, hermesProfile: profile, hermesBotChat: id === 'chat', title: id, projectId: 'workspace',
    session: { status }, latestTurn: null, latestUserMessageAt: '2026-01-01', updatedAt: '2026-01-01',
    hasPendingApprovals: status === 'approval', hasPendingUserInput: false,
  } as ThreadShell);
  const env: EnvWorld = { summary: { id: 'hermes', kind: 'hermes', addedAt: '2026-01-01', label: 'Hermes', url: '/workspace', status: 'ok' },
    connection: 'live', threads: { chat: thread('chat', 'steward', 'idle'), task: thread('task', 'steward', 'running') },
    synced: true, projects: {}, providers: [],
  };
  return { envs: { hermes: env }, hermesCatalog: { envId: 'hermes', loaded: true, bots: [
    { name: 'steward', title: 'Build Steward', description: 'Watch CI', isDefault: false, model: null, provider: null, skillCount: 0 },
    { name: 'researcher', title: 'Researcher', description: 'Read papers', isDefault: false, model: null, provider: null, skillCount: 0 },
  ] } };
}
test('bots exist before a conversation and multiple sessions stay under one persistent identity', () => {
  const state = fixture();
  const bots = botOperators(state);
  assert.equal(bots.length, 2);
  const steward = bots.find(b => b.name === 'steward')!;
  assert.equal(steward.title, 'Build Steward');
  assert.equal(steward.sessions.length, 2);
  assert.equal(steward.state, 'working');
  assert.equal(steward.observed, true);
  assert.equal(bots.find(b => b.name === 'researcher')!.observed, false, 'no fabricated on-call activity');
  state.envs.second = { ...state.envs.hermes, summary: { ...state.envs.hermes.summary, id: 'second' }, threads: { extra: { ...state.envs.hermes.threads.task, id: 'extra' } } };
  assert.equal(botOperators(state).length, 2, 'workspace connections do not multiply identities');
});
test('approval takes priority over work and offline snapshots cannot claim a bot is currently working', () => {
  const state = fixture();
  state.envs.hermes.threads.chat.hasPendingApprovals = true;
  assert.equal(botOperators(state).find(b => b.name === 'steward')!.state, 'alert');
  state.envs.hermes.connection = 'offline';
  const bot = botOperators(state).find(b => b.name === 'steward')!;
  assert.equal(bot.observed, false);
  assert.equal(bot.state, 'idle');
  assert.equal(bot.sessions.length, 2, 'last known transcripts remain accessible');
});
