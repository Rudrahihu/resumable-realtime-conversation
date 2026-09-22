import { useEffect, useState } from 'react';
import { getSocket } from '../lib/socketClient.js';

/** Connection state before/between runs — 'connected' | 'reconnecting' |
 *  'disconnected'. useRun takes over (and can report 'completed'/'failed')
 *  once a run is active; App picks whichever is relevant to show. */
export function useSocketConnection() {
  const [state, setState] = useState('disconnected');

  useEffect(() => {
    const socket = getSocket();

    const handleConnect = () => setState('connected');
    const handleDisconnect = () => setState('disconnected');
    const handleReconnectAttempt = () => setState('reconnecting');

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);

    if (socket.connected) setState('connected');

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
    };
  }, []);

  return state;
}
