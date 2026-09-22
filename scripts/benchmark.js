#!/usr/bin/env node
/**
 * Verification benchmark, per the README's requirements:
 *   1. Generate at least 30 ordered text events for one run
 *   2. Interrupt and reconnect the client at least once while generation
 *      is active
 *   3. Reconstruct the expected final response with zero missing and
 *      zero duplicate events
 *   4. Report the observed event count and final run state
 *
 * Runs directly against the orchestrator — no live sockets, no real
 * model, fully deterministic. This is a correctness check, not a
 * throughput benchmark: exit code 0 means every guarantee held, 1 means
 * something regressed.
 *
 * Usage: npm run benchmark
 */

import { createDb } from '../server/db/connection.js';
import { createEventStore } from '../server/store/eventStore.js';
import { createOrchestrator } from '../server/orchestrator/runOrchestrator.js';
import { createControllableGenerator, tick } from '../server/test/helpers.js';

const CHUNK_COUNT = 35; // > the 30 required by the README

async function main() {
  const steps = Array.from({ length: CHUNK_COUNT }, (_, i) => ({ type: 'chunk', value: `word${i} ` }));
  const ctrl = createControllableGenerator(steps);

  const db = createDb(':memory:');
  const store = createEventStore(db);
  const orchestrator = createOrchestrator({ store, generate: () => ctrl.generate() });

  const runId = 'benchmark-run';
  store.createConversation('benchmark-conv');
  store.createMessage({ id: 'benchmark-msg', conversationId: 'benchmark-conv', role: 'user', content: 'benchmark input' });

  const runPromise = orchestrator.startRun({
    runId, conversationId: 'benchmark-conv', userMessageId: 'benchmark-msg', input: 'benchmark input',
  });

  // "Client 1" watches from the very start.
  const client1Events = [];
  const unsub1 = orchestrator.resume({
    runId,
    cursor: -1,
    onEvent: (e) => client1Events.push(e),
    onInvalidCursor: (reason) => { throw new Error(`unexpected invalid cursor: ${reason}`); },
  });

  // Release roughly the first half of the chunks while client 1 watches.
  const interruptAt = Math.floor(CHUNK_COUNT / 2);
  for (let i = 0; i < interruptAt; i++) {
    ctrl.release();
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }

  // --- Interrupt: simulate a dropped connection ---
  unsub1();
  const cursorAtInterrupt = client1Events.at(-1)?.position ?? -1;

  // A few more chunks are generated while "disconnected" — nobody is
  // watching, so these only exist in persisted history until reconnect.
  const duringOutage = Math.min(3, CHUNK_COUNT - interruptAt);
  for (let i = 0; i < duringOutage; i++) {
    ctrl.release();
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }

  // --- Reconnect: resume from the last cursor client 1 saw, while
  //     generation is still active (satisfies "reconnects... while the
  //     run is still producing events") ---
  const client2Events = [];
  const unsub2 = orchestrator.resume({
    runId,
    cursor: cursorAtInterrupt,
    onEvent: (e) => client2Events.push(e),
    onInvalidCursor: (reason) => { throw new Error(`unexpected invalid cursor on reconnect: ${reason}`); },
  });

  // Release the remainder live, after the reconnect.
  const remaining = CHUNK_COUNT - interruptAt - duringOutage;
  for (let i = 0; i < remaining; i++) {
    ctrl.release();
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
  await runPromise;
  unsub2();

  // --- Reconstruct and verify ---
  const reconstructed = [...client1Events, ...client2Events];
  const positions = reconstructed.map((e) => e.position);
  const uniquePositions = new Set(positions);
  const highestPosition = Math.max(...positions);

  const expectedEventCount = CHUNK_COUNT + 1; // chunks + one 'done'

  const missingPositions = [];
  for (let p = 0; p <= highestPosition; p++) {
    if (!uniquePositions.has(p)) missingPositions.push(p);
  }
  const duplicateEventCount = positions.length - uniquePositions.size;

  const finalRun = store.getRun(runId);
  const reconstructedText = reconstructed
    .filter((e) => e.type === 'chunk')
    .sort((a, b) => a.position - b.position)
    .map((e) => e.payload.text)
    .join('');

  const report = {
    chunkCount: CHUNK_COUNT,
    interruptedAtPosition: cursorAtInterrupt,
    observedEventCount: reconstructed.length,
    expectedEventCount,
    missingPositions,
    duplicateEventCount,
    finalRunState: finalRun.status,
    reconstructedTextLength: reconstructedText.length,
    reconstructedTextPreview:
      reconstructedText.length > 60 ? `${reconstructedText.slice(0, 60)}…` : reconstructedText,
  };

  console.log(JSON.stringify(report, null, 2));

  const ok =
    missingPositions.length === 0 &&
    duplicateEventCount === 0 &&
    reconstructed.length === expectedEventCount &&
    finalRun.status === 'completed';

  if (!ok) {
    console.error('BENCHMARK FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('BENCHMARK PASSED');
}

main().catch((err) => {
  console.error('benchmark crashed:', err);
  process.exitCode = 1;
});
