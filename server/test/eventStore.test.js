import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../db/connection.js';
import { createEventStore, DuplicateEventError } from '../store/eventStore.js';

/** Fresh, isolated in-memory DB + store per test, with a conversation/
 *  message/run already set up so tests can focus on the behaviour
 *  they're actually checking. */
function setup() {
  const db = createDb(':memory:');
  const store = createEventStore(db);
  store.createConversation('conv-1');
  store.createMessage({ id: 'msg-1', conversationId: 'conv-1', role: 'user', content: 'hi' });
  store.createRun({ id: 'run-1', conversationId: 'conv-1', messageId: 'msg-1' });
  return { db, store };
}

test('appendEvent rejects a duplicate (run_id, position) pair', () => {
  const { store } = setup();
  store.appendEvent({ runId: 'run-1', position: 0, type: 'chunk', payload: { text: 'a' } });

  assert.throws(
    () => store.appendEvent({ runId: 'run-1', position: 0, type: 'chunk', payload: { text: 'b' } }),
    DuplicateEventError
  );
});

test('appendEvent allows the same position across different runs', () => {
  const { store } = setup();
  store.createRun({ id: 'run-2', conversationId: 'conv-1', messageId: 'msg-1' });

  store.appendEvent({ runId: 'run-1', position: 0, type: 'chunk', payload: { text: 'a' } });
  // Same position, different run — must NOT throw, since UNIQUE is scoped
  // to (run_id, position), not position alone.
  assert.doesNotThrow(() =>
    store.appendEvent({ runId: 'run-2', position: 0, type: 'chunk', payload: { text: 'a' } })
  );
});

test('getEventsAfter returns events strictly greater than cursor, in order', () => {
  const { store } = setup();
  for (let i = 0; i < 5; i++) {
    store.appendEvent({ runId: 'run-1', position: i, type: 'chunk', payload: { text: `word${i}` } });
  }

  const after2 = store.getEventsAfter('run-1', 2);
  assert.deepEqual(after2.map((e) => e.position), [3, 4]);

  const afterAll = store.getEventsAfter('run-1', 4);
  assert.deepEqual(afterAll, []);

  const fromStart = store.getEventsAfter('run-1', -1);
  assert.deepEqual(fromStart.map((e) => e.position), [0, 1, 2, 3, 4]);
});

test('getEventsAfter round-trips JSON payload correctly', () => {
  const { store } = setup();
  store.appendEvent({ runId: 'run-1', position: 0, type: 'chunk', payload: { text: 'hello', n: 3 } });
  const [event] = store.getEventsAfter('run-1', -1);
  assert.deepEqual(event.payload, { text: 'hello', n: 3 });
});

test('getHighestPosition returns -1 for a run with no events', () => {
  const { store } = setup();
  assert.equal(store.getHighestPosition('run-1'), -1);
});

test('getHighestPosition returns the max position written', () => {
  const { store } = setup();
  store.appendEvent({ runId: 'run-1', position: 0, type: 'chunk', payload: {} });
  store.appendEvent({ runId: 'run-1', position: 1, type: 'chunk', payload: {} });
  store.appendEvent({ runId: 'run-1', position: 2, type: 'chunk', payload: {} });
  assert.equal(store.getHighestPosition('run-1'), 2);
});

test('getRun returns null for an unknown run id', () => {
  const { store } = setup();
  assert.equal(store.getRun('does-not-exist'), null);
});

test('new runs start in running status', () => {
  const { store } = setup();
  const run = store.getRun('run-1');
  assert.equal(run.status, 'running');
});

test('setRunStatus transitions from running and reports success', () => {
  const { store } = setup();
  const changed = store.setRunStatus('run-1', 'completed');
  assert.equal(changed, true);
  assert.equal(store.getRun('run-1').status, 'completed');
});

test('setRunStatus only transitions once — second call is a no-op', () => {
  const { store } = setup();
  const first = store.setRunStatus('run-1', 'completed');
  const second = store.setRunStatus('run-1', 'failed');

  assert.equal(first, true);
  assert.equal(second, false); // lost the race — must not have applied
  assert.equal(store.getRun('run-1').status, 'completed'); // first write wins
});

test('listRunningRuns only returns runs still in running status', () => {
  const { store } = setup();
  store.createRun({ id: 'run-2', conversationId: 'conv-1', messageId: 'msg-1' });
  store.setRunStatus('run-1', 'completed');

  const running = store.listRunningRuns();
  assert.deepEqual(running, ['run-2']);
});
