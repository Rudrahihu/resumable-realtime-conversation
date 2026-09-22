# Product Engineering Challenge Submission

## Candidate

- **Name:** Rudra Pratap Singh
- **Email:** rudrapratapsingh1801@gmail.com
- **GitHub:** https://github.com/Rudrahihu
- **Selected problem:** Problem 1, Resumable Realtime Conversation
- **Demo video:** https://drive.google.com/file/d/15Nr035o2HxTWdaadjROwHDVVDkSfhnV1/view?usp=sharing

## Run the project

Prerequisites: Node.js 20 or 22 LTS (native module `better-sqlite3` needs a
prebuilt binary, very new Node versions like 24.x may not have one yet and
will try to compile from source, which needs Visual Studio Build Tools on
Windows).

```text
# Terminal 1, backend
npm install
npm run dev            # starts the server on :3001

# Terminal 2, frontend
cd client
npm install
npm run dev            # starts the Vite client on :5173
```

Open http://localhost:5173.

**Environment variables:**
- `PORT`, server port (default `3001`)
- `DB_FILE`, SQLite file path (default `data.sqlite`)
- `STREAM_DELAY_MS`, artificial per-chunk delay in the fake generator,
  default `0` (instant). Set this to slow the stream down enough to
  actually interrupt it by hand, e.g.:
  ```
  STREAM_DELAY_MS=300 npm run dev
  ```
  Tests and the benchmark never set this, they use the generator directly
  at zero delay, so they stay instant and deterministic.

No secrets are used, there is no real model provider, no API keys.

**To trigger the successful scenario:** send any message; the reply
streams in over the socket and the status pill reads "Live" until it
completes.

**To trigger the recovery scenario:** with `STREAM_DELAY_MS` set high
enough to give yourself time, send a message, and while it's streaming,
kill the backend process (Ctrl+C in the server's terminal) or just turn
off networking briefly. The status pill switches to "Reconnecting" and
the composer disables itself rather than pretending to be caught up.
Restart the backend (`npm run dev` again) or restore the connection, the
client reconnects automatically (socket.io's own retry, configured with
unlimited attempts and capped exponential backoff, see
`client/src/lib/socketClient.js`) and the reply resumes from the last
position it saw, with no missing or duplicated text.

## Run the tests

```text
npm test              # 23 automated tests, event store, orchestrator
                       # (every AC1–AC6), and real Socket.io integration
                       # tests. No sleeps, no live model, all deterministic.

npm run benchmark      # verification benchmark (see below)
```

## Acceptance scenarios and verification

All six acceptance criteria are implemented and covered by a named
automated test:

| AC | Behaviour | Test |
|---|---|---|
| AC1 | Ordered live stream, reaches completed | `orchestrator.test.js`, "AC1: ordered live event delivery reaching completed state" |
| AC2 | Missed-event recovery after reconnect | `orchestrator.test.js`, "AC2: reconnect receives every event after cursor..." + a real-socket version in `socket.integration.test.js` |
| AC3 | Replay/live overlap, zero duplicates | `orchestrator.test.js`, "AC3: reconnect mid-generation yields one correctly ordered stream..." |
| AC4 | Service restart recovery | `orchestrator.test.js`, "AC4: restart reconciliation marks orphaned running runs as failed..." (+ AC4b for the untouched-completed-run case) |
| AC5 | Generation failure after partial output | `orchestrator.test.js`, "AC5: generator failure after partial output marks the run failed, never completed" |
| AC6 | Unknown/stale cursor rejected explicitly | `orchestrator.test.js`, AC6a (unknown run), AC6b (cursor ahead of history), AC6c (negative cursor) |

**Restart policy (documented per the README's requirement):** an
in-progress generator does **not** resume after a process restart. On
startup, `reconcileAfterRestart()` finds any run still marked `running`
from a previous process, appends an inspectable `error` event
(`process_restart`), and marks it `failed`. I chose this over silently
resuming generation because the in-memory generator loop that was
producing that run no longer exists after a crash, resuming it risks a
diverged or duplicated reply, and an explicit, inspectable failure is
safer than a run stuck in limbo forever.

**Verification benchmark:**

```text
npm run benchmark
```

Runs directly against the orchestrator (no live sockets, no real model, fully deterministic). It generates 35 ordered events for one run
(exceeds the 30 required), forces a real interrupt-and-reconnect midway
through generation, reconstructs the full reply from both the
pre-interrupt and post-reconnect event streams, and reports the result.

Observed result from a real run:
```json
{
  "chunkCount": 35,
  "interruptedAtPosition": 16,
  "observedEventCount": 36,
  "expectedEventCount": 36,
  "missingPositions": [],
  "duplicateEventCount": 0,
  "finalRunState": "completed",
  "reconstructedTextLength": 235,
  "reconstructedTextPreview": "word0 word1 word2 word3 word4 word5 word6 word7 word8 word9 …"
}
BENCHMARK PASSED
```

I also sanity-checked that the benchmark actually catches a regression:
I temporarily broke the replay cursor math (an off-by-one in
`resume()`), reran it, and it correctly reported
`duplicateEventCount: 1` and exited non-zero, then I reverted the
change and confirmed a clean pass again.

**Failure/recovery scenario shown in the demo video:** I sent a message,
and while the reply was streaming (with `STREAM_DELAY_MS` set so the
stream is slow enough to interrupt by hand), I killed the backend process
with Ctrl+C. The UI status pill switched to "Reconnecting," a banner
confirmed the reply would resume from where it stopped, and the composer
disabled itself rather than pretending to still be connected. I then
restarted the backend, the client reconnected automatically, and the
reply resumed from the exact position it had reached, with no duplicated
or missing text and all prior messages in the conversation still intact.
A reviewer can reproduce this by starting the backend with
`STREAM_DELAY_MS=300 npm run dev`, sending a message, and killing/
restarting the server process while the reply streams.

## Architecture and data flow

Three layers, each with exactly one responsibility:

```
Client (React)          →  chat UI, cursor tracking, connection state
Transport (Socket.io)   →  thin, moves bytes only, zero business logic
Run Orchestrator (Node) →  owns run lifecycle: policy → generator → store → emit
Fake Generator          →  deterministic, no real model
Event Store (SQLite)    →  durable, append-only log of events per run
```

**Data flow for a message:**
1. Client sends `message:send`. Server ensures the conversation exists,
   records the user message, creates a `run` row, and starts the
   generator, all independent of the sending socket's lifetime.
2. Client explicitly emits `run:resume` with `cursor: -1`, the *same*
   mechanism used for every later reconnect, not a separate "start
   streaming" path (see Important decisions below).
3. The orchestrator persists each chunk to `run_events` and *then* emits
   it live, in that order, never the reverse.
4. On reconnect, the client resends its last-seen cursor. The server
   replays everything after that cursor from SQLite, then hands off to
   live events, filtering out anything the replay already covered.

**Event/cursor model:** an event is one row in `run_events`
(`run_id, position, type, payload`), where `position` is a monotonic
integer scoped to one run, assigned by the orchestrator, never by the
client or wall-clock time. A cursor is simply the highest `position` a
client has already applied for that run. `UNIQUE(run_id, position)` in
the schema is a database-enforced backstop against duplicate writes,
independent of the application-level dedup logic.

## Technology choices

**Node.js + Socket.io + SQLite (`better-sqlite3`) + React**, chosen
primarily because it maps directly onto my existing stack
(React/Node/Express/Socket.io/SQLite), so the exercise tests real
judgment rather than me fighting unfamiliar tooling.

Alternatives considered:
- **SSE instead of Socket.io**, would have worked for the one-directional
  stream, but Socket.io's built-in reconnection/backoff machinery and
  room-style event routing saved implementing that layer by hand, and I
  already had experience with it from a previous project (see Credibility
  note below).
- **An in-memory queue instead of SQLite**, rejected immediately, since
  the entire point of the exercise is surviving a process restart; an
  in-memory store can't do that by definition.
- **Postgres instead of SQLite**, overkill for a single-process prototype
  with no concurrent-writer requirement; `better-sqlite3`'s synchronous
  API also simplified reasoning about ordering guarantees (see the
  orchestrator's `resume()` comments on why the replay/live merge is
  race-safe without an explicit lock).

Trade-off accepted: SQLite's synchronous API means this doesn't scale to
multiple server processes sharing one database file without further
work, acceptable for this prototype's stated scope, called out below
under Production and scale.

## Important decisions

1. **One resume mechanism, not two.** I initially had `message:send`
   auto-subscribe the sending socket to live events, with `run:resume`
   as a separate reconnect path. I removed the auto-subscribe and made
   the client *always* explicitly call `run:resume`, with `cursor: -1`
   for a brand-new run, so there's exactly one code path for "start
   watching" and "reconnect," instead of two mechanisms that could drift
   out of sync over time. Any events emitted in the gap before the
   client's resume request arrives are safely covered by replay, exactly
   like any other reconnect.

2. **Restart does not resume in-flight generation.** Documented above
   under Acceptance scenarios, an explicit, inspectable `failed` state
   with a `process_restart` reason beats silently continuing (or
   silently losing) a run whose generator no longer exists.

3. **Client-side state resets during render, not inside an effect.**
   During development I found a real race: when one run's `useRun` hook
   state hadn't yet reset before the next run's data started arriving, a
   finished run's text could momentarily get attributed to a new run.
   The fix follows React's own documented pattern, deriving the reset
   synchronously during render (`if (state.runId !== runId) { ...;
   setState(...) }`) rather than in a `useEffect`, so no render ever
   pairs a new `runId` with another run's leftover data. Every state
   update inside the hook's effect is also guarded against a stale
   `runId`, as defense in depth.

## Assumptions and limitations

- Single server process, no coordination between multiple backend
  instances sharing one SQLite file (see Production and scale).
- No authentication; conversation IDs are client-generated UUIDs, one
  per page load, with no persistence across reloads, matches the
  README's out-of-scope list.
- The fake generator has no real language-model behavior; it
  deterministically echoes the input for testability, as required.
- `STREAM_DELAY_MS` is a demo/testing convenience only, it's not
  something a real deployment would ever set for actual traffic.
- No user-initiated cancellation (explicitly listed as optional stretch
  work in the README; not implemented, to keep scope inside the
  6–8 hour target).

## Production and scale

What the submitted implementation does now: single process, single
SQLite file, in-memory `EventEmitter` for live fan-out within that one
process. To state it explicitly (this is what "survives a service
restart" in the README's own words means for this implementation):
everything in `run_events` and `runs` (SQLite) survives a restart; the
in-memory `liveBus` used for live fan-out does not, and isn't meant to —
any client that was connected mid-stream reconnects and replays from the
durable log instead, exactly like any other interruption.

What I'd change first for production or multi-instance scale:
- **Move the durable event log to something multiple processes can share
  safely** (Postgres, or a proper log/queue), `better-sqlite3` is
  single-process by design.
- **Replace the in-memory `liveBus` with a pub/sub layer** (Redis, or
  the target datastore's own notify mechanism) so live events fan out
  across server instances, not just within one process, otherwise a
  client connected to server B would never see live events generated by
  a run started on server A.
- **Add a retention/compaction policy** for `run_events`, right now
  history is kept forever; production would want to expire old runs and
  return an explicit "cannot replay, too old" response (the same
  `run:invalid_cursor` mechanism already used for an unknown/ahead
  cursor) rather than growing the table unbounded.

## AI usage

I used Claude (Anthropic) throughout, architecture discussion, writing
the initial implementation collaboratively, and reviewing/verifying two
rounds of changes I made afterward (a client-side race-condition fix in
`useRun.js`, an explicit socket.io reconnection policy, and the
`STREAM_DELAY_MS` demo knob). Every claim in this document about tests
passing and the benchmark's output was independently re-run and verified
before being reported here, not just asserted, including a deliberate
regression test where I broke the dedup logic on purpose and confirmed
both the benchmark and the test suite caught it before reverting.

## Credibility note

One product I previously built and shipped: a full-stack real-time chat
application (React + Vite on the frontend, Node.js/Express/Socket.io on
the backend, SQLite for persistence), pushed to my GitHub.

- **The problem it solved:** gave users a working real-time messaging
  experience, not just message delivery, but the surrounding presence
  and feedback signals people expect from chat apps: typing indicators,
  online/offline status, and delivery ticks.
- **My personal contribution:** built solo, end to end, frontend, backend,
  and the persistence layer.
- **Scale/complexity:** the operationally hard part wasn't message
  delivery itself, it was keeping several pieces of *transient, per-user
  state* (typing status, online presence) correctly synchronized in real
  time across connected clients, on top of a Socket.io layer, while still
  persisting the durable message history reliably to SQLite.
- **A difficult decision:** deciding how to separate durable state (the
  messages themselves) from ephemeral, fast-changing state (typing/online
  status) so that a reconnect or a page reload never showed stale
  presence information, a smaller-scale version of the same
  durable-vs-transient-state question this Resumable Realtime
  Conversation exercise centers on, which is part of why Problem 1 felt
  like the most natural fit for me among the five options.
- **Evidence:** available on my GitHub at https://github.com/Rudrahihu.

<!-- If you have the specific repo name/link for this project, add it
     here directly instead of just the profile link. -->
