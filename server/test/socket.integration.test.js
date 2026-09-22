import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

import { createDb } from '../db/connection.js';
import { createEventStore } from '../store/eventStore.js';
import { createOrchestrator } from '../orchestrator/runOrchestrator.js';
import { registerSocketHandlers } from '../socket/socketHandlers.js';
import { simpleGenerate, createControllableGenerator } from './helpers.js';

function startTestServer(generate) {
  const db = createDb(':memory:');
  const store = createEventStore(db);
  const orchestrator = createOrchestrator({ store, generate });
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  registerSocketHandlers(io, orchestrator, store);

  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const port = httpServer.address().port;
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise((res) => { io.close(); httpServer.close(res); }),
      });
    });
  });
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

/** Waits for an array to reach a given length by yielding to the event
 *  loop repeatedly, bounded by a timeout — not a fixed-duration sleep, and
 *  resolves as soon as the condition is actually true. */
async function waitForLength(arr, n, timeoutMs = 2000) {
  const start = Date.now();
  while (arr.length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for length ${n}, got ${arr.length}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('integration: message:send streams an ordered reply to completion over a real socket', async () => {
  const { url, close } = await startTestServer(() => simpleGenerate(['a ', 'b ', 'c ']));
  const client = ioClient(url, { transports: ['websocket'] });

  const events = [];
  client.on('run:event', (e) => events.push(e));

  await waitFor(client, 'connect');
  client.emit('message:send', { conversation_id: 'conv-1', content: 'hello' });
  const { run_id } = await waitFor(client, 'run:started');
  assert.ok(run_id);

  // Client always explicitly requests streaming via run:resume — cursor
  // -1 means "from the beginning" — rather than relying on the server to
  // auto-subscribe. See socketHandlers.js for why.
  client.emit('run:resume', { run_id, cursor: -1 });

  await waitForLength(events, 4); // 3 chunks + done

  assert.deepEqual(events.map((e) => e.position), [0, 1, 2, 3]);
  assert.equal(events.at(-1).type, 'done');

  client.close();
  await close();
});

test('integration: reconnect with run:resume recovers missed events with zero duplicates', async () => {
  const ctrl = createControllableGenerator([
    { type: 'chunk', value: 'a ' },
    { type: 'chunk', value: 'b ' },
    { type: 'chunk', value: 'c ' },
  ]);
  const { url, close } = await startTestServer(() => ctrl.generate());

  const client1 = ioClient(url, { transports: ['websocket'] });
  await waitFor(client1, 'connect');

  const firstEvents = [];
  client1.on('run:event', (e) => firstEvents.push(e));
  client1.emit('message:send', { conversation_id: 'conv-1', content: 'hello' });
  const { run_id } = await waitFor(client1, 'run:started');
  client1.emit('run:resume', { run_id, cursor: -1 });

  ctrl.release(); // chunk 0
  await waitForLength(firstEvents, 1);
  ctrl.release(); // chunk 1
  await waitForLength(firstEvents, 2);

  assert.deepEqual(firstEvents.map((e) => e.position), [0, 1]);
  const cursor = firstEvents.at(-1).position;

  // Simulate a dropped connection.
  client1.close();

  ctrl.release(); // chunk 2 happens while "disconnected" — nobody is listening
  await new Promise((resolve) => setImmediate(resolve));

  const client2 = ioClient(url, { transports: ['websocket'] });
  await waitFor(client2, 'connect');
  const replayed = [];
  client2.on('run:event', (e) => replayed.push(e));
  client2.emit('run:resume', { run_id, cursor });

  await waitForLength(replayed, 2); // chunk 2 + done

  assert.deepEqual(replayed.map((e) => e.position), [2, 3]);
  assert.equal(replayed.at(-1).type, 'done');

  const allPositions = [...firstEvents, ...replayed].map((e) => e.position);
  assert.equal(new Set(allPositions).size, allPositions.length, 'no duplicates across the reconnect');

  client2.close();
  await close();
});

test('integration: an unknown run_id on run:resume gets an explicit invalid-cursor response', async () => {
  const { url, close } = await startTestServer(() => simpleGenerate([]));
  const client = ioClient(url, { transports: ['websocket'] });
  await waitFor(client, 'connect');

  client.emit('run:resume', { run_id: 'does-not-exist', cursor: -1 });
  const response = await waitFor(client, 'run:invalid_cursor');

  assert.equal(response.reason, 'unknown_run');

  client.close();
  await close();
});
