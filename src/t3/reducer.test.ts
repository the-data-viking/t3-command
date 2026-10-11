import assert from 'node:assert/strict';
import test from 'node:test';
import { applyThreadEvent } from './reducer';
import type { MessageAttachment, OrchestrationThread } from './types';

const image: MessageAttachment = { type: 'image', id: 'attachment', name: 'map.png', mimeType: 'image/png', sizeBytes: 12 };
const at = '2026-10-11T00:00:00Z';
function send(thread: OrchestrationThread, payload: Record<string, unknown>) {
  return applyThreadEvent(thread, { sequence: 1, aggregateKind: 'thread', aggregateId: 'thread', occurredAt: at,
    type: 'thread.message-sent', payload: { messageId: 'message', role: 'user', ...payload } });
}

test('live attachment-only messages retain attachments through deltas and completion', () => {
  const empty = { messages: [] } as unknown as OrchestrationThread;
  const created = send(empty, { text: '', attachments: [image] });
  assert.deepEqual(created.messages[0].attachments, [image]);
  const delta = send(created, { text: 'Look', streaming: true });
  const completed = send(delta, { text: 'Look here', streaming: false });
  assert.equal(completed.messages[0].text, 'Look here');
  assert.deepEqual(completed.messages[0].attachments, [image]);
  assert.deepEqual(send(completed, { attachments: [] }).messages[0].attachments, []);
  assert.deepEqual(created.messages[0].attachments, [image]);
});

test('existing snapshot attachments survive live updates and can be replaced', () => {
  const snapshot = { messages: [{ id: 'message', role: 'user', text: 'before', attachments: [image], createdAt: at, updatedAt: at }] } as unknown as OrchestrationThread;
  assert.deepEqual(send(snapshot, { text: 'after' }).messages[0].attachments, [image]);
  const replacement = { ...image, id: 'second' };
  assert.deepEqual(send(snapshot, { attachments: [replacement] }).messages[0].attachments, [replacement]);
});
