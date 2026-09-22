/**
 * Owns everything about a run's lifecycle:
 *   - starting generation, persisting each chunk BEFORE emitting it live
 *   - marking terminal state exactly once (delegated to store.setRunStatus,
 *     which guards on `status = 'running'`)
 *   - serving resume requests: replay-from-cursor merged safely with any
 *     events still arriving live, with zero gap and zero duplicate
 *   - reconciling runs left 'running' by a previous process (AC4)
 *
 * No knowledge of Socket.io here — socket/ is a thin adapter over this.
 *
 * --- Why the replay/live merge is race-safe ---
 * resume() subscribes to the live event bus and queries persisted history
 * back-to-back with NO `await` between those two steps. Node is single-
 * threaded and synchronous code runs to completion without interruption,
 * so nothing can emit an event in the gap between "start listening" and
 * "read what's already there" — there is no gap. Symmetrically, startRun's
 * loop does `store.appendEvent(...)` immediately followed by
 * `liveBus.emit(...)` with no `await` between them, so a listener that is
 * subscribed before an event is appended is guaranteed to receive it live.
 * The position-based filter in the buffer-drain step is a second,
 * independent line of defense in case either invariant is ever violated.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DuplicateEventError } from '../store/eventStore.js';

export function createOrchestrator({ store, generate }) {
  const liveBus = new EventEmitter();
  liveBus.setMaxListeners(0); // unbounded — one listener per active resume

  async function startRun({ runId, conversationId, userMessageId, input }) {
    store.createRun({ id: runId, conversationId, messageId: userMessageId });

    let position = 0;
    let fullText = '';

    try {
      for await (const chunk of generate(input)) {
        const event = { runId, position, type: 'chunk', payload: { text: chunk } };
        store.appendEvent(event); // persist first
        liveBus.emit(runId, event); // then emit — no await between these two lines
        fullText += chunk;
        position++;
      }

      const doneEvent = { runId, position, type: 'done', payload: {} };
      store.appendEvent(doneEvent);
      liveBus.emit(runId, doneEvent);

      const won = store.setRunStatus(runId, 'completed');
      if (won) {
        store.createMessage({
          id: randomUUID(),
          conversationId,
          role: 'assistant',
          content: fullText.trim(),
        });
      }
    } catch (err) {
      const errorEvent = { runId, position, type: 'error', payload: { message: err.message } };
      try {
        store.appendEvent(errorEvent);
        liveBus.emit(runId, errorEvent);
      } catch (appendErr) {
        // Best-effort: if even the error event collides (shouldn't happen —
        // one run has one writer — but never let a secondary failure here
        // mask the original error or skip marking the run failed).
        if (!(appendErr instanceof DuplicateEventError)) throw appendErr;
      }
      store.setRunStatus(runId, 'failed');
    }
  }

  /**
   * Serves a resume request: replay everything after `cursor`, then
   * seamlessly hand off to live events, with no gap and no duplicate.
   *
   * onEvent(event) is called for both replay and live events, in order.
   * onInvalidCursor(reason) is called instead, and resume aborts, when the
   * cursor cannot be safely replayed from (AC6):
   *   - 'unknown_run'     run_id does not exist
   *   - 'negative_cursor' cursor < -1 (a real cursor from this protocol
   *                        can never be below the -1 sentinel)
   *   - 'cursor_ahead'    cursor is beyond the run's highest known
   *                        position — the client claims to have seen
   *                        events the server never emitted
   *
   * Returns an unsubscribe function; callers must call it on socket
   * disconnect to avoid leaking listeners.
   */
  function resume({ runId, cursor, onEvent, onInvalidCursor }) {
    const run = store.getRun(runId);
    if (!run) {
      onInvalidCursor('unknown_run');
      return () => {};
    }
    if (cursor < -1) {
      onInvalidCursor('negative_cursor');
      return () => {};
    }

    // Subscribe BEFORE querying history — see module-level note on why
    // this ordering, with no await between, is what makes this safe.
    const buffer = [];
    const onLive = (event) => buffer.push(event);
    liveBus.on(runId, onLive);

    const highestKnown = store.getHighestPosition(runId);
    if (cursor > highestKnown) {
      liveBus.off(runId, onLive);
      onInvalidCursor('cursor_ahead');
      return () => {};
    }

    const history = store.getEventsAfter(runId, cursor);
    let maxEmitted = cursor;
    for (const event of history) {
      onEvent(event);
      maxEmitted = event.position;
    }

    // Drain whatever arrived live while we were querying/replaying, but
    // only what replay didn't already cover — the actual dedup point.
    for (const event of buffer) {
      if (event.position > maxEmitted) {
        onEvent(event);
        maxEmitted = event.position;
      }
    }
    buffer.length = 0;
    liveBus.off(runId, onLive);

    // Steady-state passthrough for subsequent live events.
    const onLivePassthrough = (event) => {
      if (event.position > maxEmitted) {
        onEvent(event);
        maxEmitted = event.position;
      }
    };
    liveBus.on(runId, onLivePassthrough);

    return () => liveBus.off(runId, onLivePassthrough);
  }

  /**
   * Startup reconciliation (AC4 restart policy): any run still 'running'
   * from before this process started belongs to a generator loop that no
   * longer exists. We do NOT silently resume it — that would risk a
   * duplicate or divergent generation. Instead it's marked failed with a
   * distinguishable reason, so clients get an explicit, inspectable
   * terminal state rather than a run stuck in limbo forever.
   */
  function reconcileAfterRestart() {
    const orphaned = store.listRunningRuns();
    for (const runId of orphaned) {
      const position = store.getHighestPosition(runId) + 1;
      try {
        store.appendEvent({
          runId,
          position,
          type: 'error',
          payload: { message: 'process_restart' },
        });
      } catch (err) {
        if (!(err instanceof DuplicateEventError)) throw err;
      }
      store.setRunStatus(runId, 'failed');
    }
    return orphaned;
  }

  return { startRun, resume, reconcileAfterRestart };
}
