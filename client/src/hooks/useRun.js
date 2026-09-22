import { useEffect, useRef, useState } from 'react';
import { getSocket } from '../lib/socketClient.js';

/**
 * Subscribes to a single run's event stream. Handles both the initial
 * "start watching from the beginning" case and every later reconnect
 * through the exact same mechanism: emit 'run:resume' with the highest
 * position we've already applied (or -1 if none yet).
 *
 * Connection states surfaced: connected | reconnecting | disconnected |
 * completed | failed — matching the README's required state set.
 *
 * All per-run state is stored under the run it belongs to, and is reset
 * during render when `runId` changes rather than inside an effect. An
 * effect-based reset runs *after* the consumer has already rendered (and
 * after its own effects have fired) with the previous run's events and
 * terminal connectionState still in place — which let a finished run's
 * text be attributed to the next run. Deriving the reset during render
 * means a given render never observes another run's data.
 */
export function useRun(runId) {
  const [state, setState] = useState({
    runId: null,
    events: [],
    connectionState: 'disconnected',
  });

  // Refs, not state, for values read inside socket callbacks — avoids
  // stale closures without having to re-subscribe listeners every render.
  const cursorRef = useRef(-1);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  // Derived reset: React re-renders this component immediately with the
  // new state, before children or effects see the old one.
  if (state.runId !== runId) {
    cursorRef.current = -1;
    setState({ runId, events: [], connectionState: 'disconnected' });
  }

  useEffect(() => {
    if (!runId) return undefined;

    const socket = getSocket();

    // Every updater below is guarded on prev.runId — a late event from a
    // run we've already moved on from can never mutate the current one.
    function setConnectionState(next) {
      setState((prev) => {
        if (prev.runId !== runIdRef.current) return prev;
        const value = typeof next === 'function' ? next(prev.connectionState) : next;
        if (value === prev.connectionState) return prev;
        return { ...prev, connectionState: value };
      });
    }

    function applyEvent(event) {
      if (event.runId !== runIdRef.current) return;
      // Defensive client-side dedup/ordering guard, mirroring the same
      // position-based filter the server uses — belt and suspenders.
      if (event.position <= cursorRef.current) return;
      cursorRef.current = event.position;

      setState((prev) => {
        if (prev.runId !== runIdRef.current) return prev;
        let connectionState = prev.connectionState;
        if (event.type === 'done') connectionState = 'completed';
        if (event.type === 'error') connectionState = 'failed';
        return { ...prev, events: [...prev.events, event], connectionState };
      });
    }

    function requestResume() {
      socket.emit('run:resume', { run_id: runIdRef.current, cursor: cursorRef.current });
    }

    function handleConnect() {
      setConnectionState((prev) => (prev === 'completed' || prev === 'failed' ? prev : 'connected'));
      requestResume();
    }

    function handleDisconnect() {
      setConnectionState((prev) => (prev === 'completed' || prev === 'failed' ? prev : 'disconnected'));
    }

    function handleReconnectAttempt() {
      setConnectionState((prev) => (prev === 'completed' || prev === 'failed' ? prev : 'reconnecting'));
    }

    function handleInvalidCursor({ run_id, reason }) {
      if (run_id !== runIdRef.current) return;
      // The server could not safely replay from our cursor (AC6). Rather
      // than pretend we're caught up, surface an explicit failed state.
      console.error(`cannot resume run ${run_id}: ${reason}`);
      setConnectionState('failed');
    }

    socket.on('run:event', applyEvent);
    socket.on('run:invalid_cursor', handleInvalidCursor);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);

    if (socket.connected) handleConnect();

    return () => {
      socket.off('run:event', applyEvent);
      socket.off('run:invalid_cursor', handleInvalidCursor);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
    };
  }, [runId]);

  // Never report another run's data, even on the render that triggered
  // the reset above.
  if (state.runId !== runId) {
    return { events: [], connectionState: 'disconnected' };
  }
  return { events: state.events, connectionState: state.connectionState };
}
