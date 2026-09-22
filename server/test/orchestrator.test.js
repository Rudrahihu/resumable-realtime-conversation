import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb } from '../db/connection.js';
import { createEventStore } from '../store/eventStore.js';
import { createOrchestrator } from '../orchestrator/runOrchestrator.js';
import { simpleGenerate, createControllableGenerator, tick } from './helpers.js';

// --- Test helpers -----------------------------------------------------

/** Fresh in-memory DB + store + orchestrator, with a conversation and
 *  user message already seeded so tests can go straight to startRun. */
function setup(generate) {
  const db = createDb(':memory:');
  const store = createEventStore(db);
  store.createConversation('conv-1');
  store.createMessage({ id: 'msg-1', conversationId: 'conv-1', role: 'user', content: 'hi' });
  const orchestrator = createOrchestrator({ store, generate });
  return { db, store, orchestrator };
}

function failOnInvalidCursor(reason) {
  assert.fail(`unexpected invalid cursor: ${reason}`);
}

// --- AC1: ordered live stream ------------------------------------------

test('AC1: ordered live event delivery reaching completed state', async () => {
  const { store, orchestrator } = setup(() => simpleGenerate(['a ', 'b ', 'c ']));
  const runId = 'run-1';
  const events = [];

  // Call startRun without awaiting it yet — its synchronous prefix
  // (store.createRun) runs immediately, so the run exists by the time
  // resume() is called on the next line, before any chunk can be emitted
  // (the first chunk requires at least one await via the generator
  // protocol, so there is no window for a race here).
  const runPromise = orchestrator.startRun({
    runId, conversationId: 'conv-1', userMessageId: 'msg-1', input: 'hi',
  });
  const unsub = orchestrator.resume({
    runId, cursor: -1, onEvent: (e) => events.push(e), onInvalidCursor: failOnInvalidCursor,
  });

  await runPromise;
  unsub();

  assert.deepEqual(events.map((e) => e.position), [0, 1, 2, 3]); // 3 chunks + done
  assert.equal(events.at(-1).type, 'done');
  assert.equal(store.getRun(runId).status, 'completed');

  const message = store.getRun(runId); // sanity: run row itself
  assert.ok(message);
});

// --- AC2: missed-event recovery -----------------------------------------

test('AC2: reconnect receives every event after cursor, without loss or repeat', async () => {
  const ctrl = createControllableGenerator([
    { type: 'chunk', value: 'a ' },
    { type: 'chunk', value: 'b ' },
    { type: 'chunk', value: 'c ' },
  ]);
  const { orchestrator } = setup(() => ctrl.generate());
  const runId = 'run-1';

  const firstClientEvents = [];
  const runPromise = orchestrator.startRun({
    runId, conversationId: 'conv-1', userMessageId: 'msg-1', input: 'hi',
  });
  const unsub1 = orchestrator.resume({
    runId, cursor: -1, onEvent: (e) => firstClientEvents.push(e), onInvalidCursor: failOnInvalidCursor,
  });

  ctrl.release(); await tick(); // chunk 0 delivered live
  ctrl.release(); await tick(); // chunk 1 delivered live

  // Simulate a dropped connection: stop listening.
  unsub1();
  const cursor = firstClientEvents.at(-1).position;
  assert.equal(cursor, 1);

  ctrl.release(); // chunk 2 happens while "disconnected" — client never sees it live
  await runPromise; // let generation finish (chunk 2 + done)

  // Reconnect with the last cursor the first client saw.
  const replayed = [];
  const unsub2 = orchestrator.resume({
    runId, cursor, onEvent: (e) => replayed.push(e), onInvalidCursor: failOnInvalidCursor,
  });
  unsub2();

  assert.deepEqual(replayed.map((e) => e.position), [2, 3]); // missed chunk + done
  assert.equal(replayed.at(-1).type, 'done');
});

// --- AC3: replay/live overlap --------------------------------------------

test('AC3: reconnect mid-generation yields one correctly ordered stream with zero duplicates', async () => {
  const ctrl = createControllableGenerator([
    { type: 'chunk', value: 'a ' },
    { type: 'chunk', value: 'b ' },
    { type: 'chunk', value: 'c ' },
    { type: 'chunk', value: 'd ' },
  ]);
  const { orchestrator } = setup(() => ctrl.generate());
  const runId = 'run-1';

  const runPromise = orchestrator.startRun({
    runId, conversationId: 'conv-1', userMessageId: 'msg-1', input: 'hi',
  });

  // Two chunks happen with nobody subscribed — they only exist in history.
  ctrl.release(); await tick();
  ctrl.release(); await tick();

  const events = [];
  const unsub = orchestrator.resume({
    runId, cursor: -1, onEvent: (e) => events.push(e), onInvalidCursor: failOnInvalidCursor,
  });
  // resume() has now synchronously replayed [0,1] from history and switched
  // to live passthrough, all before this line runs.

  ctrl.release(); await tick(); // chunk 2, delivered live
  ctrl.release(); await tick(); // chunk 3, delivered live
  await runPromise; // done, delivered live

  unsub();

  const positions = events.map((e) => e.position);
  assert.deepEqual(positions, [0, 1, 2, 3, 4]);
  assert.equal(new Set(positions).size, positions.length, 'no duplicate positions');
  assert.equal(events.at(-1).type, 'done');
});

// --- AC4: service restart -------------------------------------------------

test('AC4: restart reconciliation marks orphaned running runs as failed with an inspectable event', () => {
  const db = createDb(':memory:');
  const store = createEventStore(db);
  store.createConversation('conv-1');
  store.createMessage({ id: 'msg-1', conversationId: 'conv-1', role: 'user', content: 'hi' });
  store.createRun({ id: 'run-1', conversationId: 'conv-1', messageId: 'msg-1' });
  store.appendEvent({ runId: 'run-1', position: 0, type: 'chunk', payload: { text: 'partial' } });
  // Run is left 'running' here — simulating a process that died mid-stream.

  // "Restart": a fresh orchestrator instance over the same durable store.
  const orchestrator = createOrchestrator({ store, generate: () => simpleGenerate([]) });
  const orphaned = orchestrator.reconcileAfterRestart();

  assert.deepEqual(orphaned, ['run-1']);
  assert.equal(store.getRun('run-1').status, 'failed');

  const events = store.getEventsAfter('run-1', -1);
  assert.deepEqual(events.map((e) => e.type), ['chunk', 'error']);
  assert.equal(events.at(-1).payload.message, 'process_restart');
});

test('AC4b: a completed run is left untouched by restart reconciliation', async () => {
  const { store, orchestrator } = setup(() => simpleGenerate(['a ']));
  const runId = 'run-1';
  await orchestrator.startRun({ runId, conversationId: 'conv-1', userMessageId: 'msg-1', input: 'hi' });
  assert.equal(store.getRun(runId).status, 'completed');

  const orphaned = orchestrator.reconcileAfterRestart();
  assert.deepEqual(orphaned, []);
  assert.equal(store.getRun(runId).status, 'completed');
});

// --- AC5: generation failure ----------------------------------------------

test('AC5: generator failure after partial output marks the run failed, never completed', async () => {
  const ctrl = createControllableGenerator([
    { type: 'chunk', value: 'a ' },
    { type: 'chunk', value: 'b ' },
    { type: 'error', message: 'boom' },
  ]);
  const { store, orchestrator } = setup(() => ctrl.generate());
  const runId = 'run-1';
  const events = [];

  const runPromise = orchestrator.startRun({
    runId, conversationId: 'conv-1', userMessageId: 'msg-1', input: 'hi',
  });
  orchestrator.resume({
    runId, cursor: -1, onEvent: (e) => events.push(e), onInvalidCursor: failOnInvalidCursor,
  });

  ctrl.release(); await tick(); // chunk 0
  ctrl.release(); await tick(); // chunk 1
  ctrl.release();               // triggers the throw
  await runPromise;

  assert.equal(store.getRun(runId).status, 'failed');
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).payload.message, 'boom');
  assert.ok(!events.some((e) => e.type === 'done'), 'a failed run must never emit done');
});

// --- AC6: unknown or stale cursor -------------------------------------------

test('AC6a: resume against an unknown run yields an explicit invalid-cursor response', () => {
  const { orchestrator } = setup(() => simpleGenerate([]));
  let reason = null;
  orchestrator.resume({
    runId: 'does-not-exist',
    cursor: -1,
    onEvent: () => assert.fail('should never emit for an unknown run'),
    onInvalidCursor: (r) => { reason = r; },
  });
  assert.equal(reason, 'unknown_run');
});

test('AC6b: a cursor ahead of the highest known position is rejected, not silently treated as caught up', async () => {
  const { orchestrator } = setup(() => simpleGenerate(['a ', 'b ']));
  const runId = 'run-1';
  await orchestrator.startRun({ runId, conversationId: 'conv-1', userMessageId: 'msg-1', input: 'hi' });

  let reason = null;
  const events = [];
  orchestrator.resume({
    runId, cursor: 999, onEvent: (e) => events.push(e), onInvalidCursor: (r) => { reason = r; },
  });

  assert.equal(reason, 'cursor_ahead');
  assert.deepEqual(events, []);
});

test('AC6c: a negative cursor below the sentinel is rejected', async () => {
  const { orchestrator } = setup(() => simpleGenerate(['a ']));
  const runId = 'run-1';
  await orchestrator.startRun({ runId, conversationId: 'conv-1', userMessageId: 'msg-1', input: 'hi' });

  let reason = null;
  orchestrator.resume({
    runId,
    cursor: -5,
    onEvent: () => assert.fail('should never emit'),
    onInvalidCursor: (r) => { reason = r; },
  });
  assert.equal(reason, 'negative_cursor');
});
