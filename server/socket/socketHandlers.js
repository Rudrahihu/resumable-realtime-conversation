/**
 * Transport only. Every decision about ordering, dedup, or terminal state
 * belongs to the orchestrator — this file just moves bytes and tracks
 * which resume() subscriptions belong to which socket so they can be
 * cleaned up on disconnect.
 */

import { randomUUID } from 'node:crypto';

export function registerSocketHandlers(io, orchestrator, store) {
  // socket.id -> Set<unsubscribe fn>. A socket can have more than one
  // active resume() over its lifetime (send, then later reconnect to a
  // different run), so this is a set, not a single slot.
  const activeUnsubs = new Map();

  function trackUnsub(socket, unsub) {
    if (!activeUnsubs.has(socket.id)) activeUnsubs.set(socket.id, new Set());
    activeUnsubs.get(socket.id).add(unsub);
  }

  io.on('connection', (socket) => {
    socket.on('message:send', ({ conversation_id, client_message_id, content } = {}) => {
      if (typeof conversation_id !== 'string' || typeof content !== 'string' || content.trim() === '') {
        socket.emit('message:error', { reason: 'invalid_payload' });
        return;
      }

      store.ensureConversation(conversation_id);

      const userMessageId = randomUUID();
      store.createMessage({
        id: userMessageId,
        conversationId: conversation_id,
        role: 'user',
        content,
        clientMessageId: client_message_id ?? null,
      });

      const runId = randomUUID();
      socket.emit('run:started', { run_id: runId, conversation_id });

      // Not awaited: the orchestrator owns this run's lifecycle
      // independently of this socket's connection (see restart/resume
      // policy in runOrchestrator.js). If it somehow throws outside its
      // own try/catch, that's a bug, not a normal failure path — log it
      // rather than let it become an unhandled rejection.
      orchestrator
        .startRun({ runId, conversationId: conversation_id, userMessageId, input: content })
        .catch((err) => console.error('startRun crashed unexpectedly', err));

      // Deliberately NOT auto-subscribing this socket to the run here.
      // The client always requests streaming via 'run:resume' — with
      // cursor -1 for "from the beginning" — so there is exactly one code
      // path for both "start watching a run" and "reconnect to one",
      // rather than two different mechanisms that could drift out of sync.
      // Any chunks emitted in the gap before the client's resume request
      // arrives are safely covered by replay, same as any other reconnect.
    });

    socket.on('run:resume', ({ run_id, cursor } = {}) => {
      if (typeof run_id !== 'string' || typeof cursor !== 'number') {
        socket.emit('run:invalid_cursor', { run_id: run_id ?? null, reason: 'malformed_request' });
        return;
      }

      const unsub = orchestrator.resume({
        runId: run_id,
        cursor,
        onEvent: (event) => socket.emit('run:event', event),
        onInvalidCursor: (reason) => socket.emit('run:invalid_cursor', { run_id, reason }),
      });
      trackUnsub(socket, unsub);
    });

    socket.on('disconnect', () => {
      const unsubs = activeUnsubs.get(socket.id);
      if (!unsubs) return;
      for (const unsub of unsubs) unsub();
      activeUnsubs.delete(socket.id);
    });
  });
}
