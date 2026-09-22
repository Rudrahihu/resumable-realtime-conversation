import { useCallback, useEffect, useRef, useState } from 'react';
import Chat from './components/Chat.jsx';
import { getSocket } from './lib/socketClient.js';
import { useRun } from './hooks/useRun.js';
import { useSocketConnection } from './hooks/useSocketConnection.js';

export default function App() {
  // One conversation per page load — out of scope to persist across
  // reloads (see README's out-of-scope list: no auth, no multi-session).
  const conversationIdRef = useRef(crypto.randomUUID());
  const [messages, setMessages] = useState([]); // { id, role, content, failed? }
  const [currentRunId, setCurrentRunId] = useState(null);

  const baselineConnection = useSocketConnection();
  const { events, connectionState: runConnectionState } = useRun(currentRunId);

  // While a run is active, its own connection state (which can also read
  // 'completed'/'failed') takes over; otherwise show baseline connectivity.
  const connectionState = currentRunId ? runConnectionState : baselineConnection;

  const streamingText = events
    .filter((e) => e.type === 'chunk')
    .map((e) => e.payload.text)
    .join('');

  const isStreaming = currentRunId !== null && connectionState !== 'completed' && connectionState !== 'failed';

  // Runs already folded into `messages`. Guards against a terminal state
  // being observed twice (StrictMode double-invokes effects in dev) and
  // is the reason a run can never be appended to the transcript twice.
  const foldedRunsRef = useRef(new Set());
  // Pending 'run:started' listeners, so an unmount (or a send that never
  // gets a reply) can't leave a handler attached to the shared socket.
  const pendingStartersRef = useRef(new Set());

  const sendMessage = useCallback((content) => {
    const socket = getSocket();
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content }]);

    function handleRunStarted({ run_id, conversation_id }) {
      if (conversation_id !== conversationIdRef.current) return;
      socket.off('run:started', handleRunStarted);
      pendingStartersRef.current.delete(handleRunStarted);
      setCurrentRunId(run_id);
      // Explicitly request streaming from the beginning — the same
      // resume() path used for every later reconnect (see useRun.js).
      socket.emit('run:resume', { run_id, cursor: -1 });
    }
    socket.on('run:started', handleRunStarted);
    pendingStartersRef.current.add(handleRunStarted);

    socket.emit('message:send', { conversation_id: conversationIdRef.current, content });
  }, []);

  useEffect(() => {
    const starters = pendingStartersRef.current;
    return () => {
      const socket = getSocket();
      starters.forEach((fn) => socket.off('run:started', fn));
      starters.clear();
    };
  }, []);

  // Once a run reaches a terminal state, fold it into the message list
  // and free currentRunId so the next send starts a fresh run.
  //
  // useRun now resets its state during render when currentRunId changes,
  // so `streamingText`/`connectionState` read here always belong to
  // `currentRunId` — never to the run before it.
  useEffect(() => {
    if (!currentRunId) return;
    if (connectionState !== 'completed' && connectionState !== 'failed') return;
    if (foldedRunsRef.current.has(currentRunId)) return;
    foldedRunsRef.current.add(currentRunId);

    const failed = connectionState === 'failed';
    setMessages((prev) => {
      if (prev.some((m) => m.id === currentRunId)) return prev;
      return [
        ...prev,
        {
          id: currentRunId,
          role: 'assistant',
          content: failed ? streamingText || '(no response)' : streamingText,
          ...(failed ? { failed: true } : {}),
        },
      ];
    });
    setCurrentRunId(null);
    // streamingText intentionally omitted: we only want this to fire on
    // connectionState transitions, reading whatever streamingText is at
    // that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState, currentRunId]);

  return (
    <Chat
      messages={messages}
      streamingText={streamingText}
      connectionState={connectionState}
      isStreaming={isStreaming}
      onSend={sendMessage}
    />
  );
}
