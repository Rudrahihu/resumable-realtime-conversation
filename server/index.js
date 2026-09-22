import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

import { createDb } from './db/connection.js';
import { createEventStore } from './store/eventStore.js';
import { createOrchestrator } from './orchestrator/runOrchestrator.js';
import { fakeGenerate } from './generator/fakeGenerator.js';
import { registerSocketHandlers } from './socket/socketHandlers.js';

const db = createDb(process.env.DB_FILE ?? 'data.sqlite');
const store = createEventStore(db);

// STREAM_DELAY_MS: 0 in normal dev/prod (instant, matches tests/benchmark).
// Set it when you want to slow the fake stream down — e.g. for a demo
// recording where you need time to actually kill the connection mid-reply.
const streamDelayMs = Number(process.env.STREAM_DELAY_MS ?? 0);
const orchestrator = createOrchestrator({
  store,
  generate: (input) => fakeGenerate(input, { delayMs: streamDelayMs }),
});

// AC4 restart policy: reconcile any run left 'running' by a previous
// process before accepting new connections.
const orphaned = orchestrator.reconcileAfterRestart();
if (orphaned.length > 0) {
  console.log(`reconciled ${orphaned.length} orphaned run(s) from a previous process:`, orphaned);
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

registerSocketHandlers(io, orchestrator, store);

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT ?? 3001;
httpServer.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
