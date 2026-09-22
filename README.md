# Resumable Realtime Conversation

A chat service that streams generated replies over Socket.io and survives
disconnects: reconnecting clients resume from a cursor with zero missing and
zero duplicate events.

## Layout

```
server/
  db/              SQLite schema + connection setup
  store/           Event store — the ONLY thing that talks to the DB
  generator/        Deterministic fake response generator (no real model)
  orchestrator/     Owns run lifecycle: policy → generator → store → emit
  socket/           Socket.io wiring — transport only, no business logic
  test/             Automated tests (deterministic, no sleeps, no live model)
  index.js          Wires everything together, starts the HTTP+socket server

client/
  src/
    components/     Chat UI (message list, composer, connection indicator)
    hooks/           useRun (subscribes to a run, tracks cursor, reconnects)
    lib/             socket client wrapper (shared connection, reconnect policy)

scripts/
  benchmark.js       Verification benchmark (30+ events, forced reconnect,
                      asserts zero missing / zero duplicate events)

SUBMISSION.md         The written decisions doc — architecture, technology
                      choices, important decisions, assumptions, production
                      notes, AI usage, and the credibility note.
```

## Design principle

`socket/` is dumb — it only moves bytes. `orchestrator/` is the only place
that decides what's true about a run. `store/` is the only place that talks
to SQLite. This separation is what makes the replay/live merge testable
without a real socket connection.

## Running it

```
npm install && npm --prefix client install

npm run dev         # starts the server (default :3001)
npm --prefix client run dev   # starts the Vite client (default :5173)

npm test            # backend test suite (23 tests, no sleeps, no live model)
npm run benchmark    # verification benchmark: 30+ events, one forced
                      # interruption, asserts zero missing / zero duplicates
npm run build        # builds the client for production (delegates to client/)
```

Set `STREAM_DELAY_MS` (e.g. `STREAM_DELAY_MS=300 npm run dev`) to add an
artificial per-chunk delay to the fake generator — useful for manually
triggering and observing the reconnect/recovery behaviour. Defaults to `0`
(instant); tests and the benchmark never set it.

## Status

Complete. Core recovery behaviour is implemented and passing: ordered live
delivery, resume from a client cursor, replay/live merge with zero
duplicates, restart reconciliation, generator-failure handling, and
rejection of an unknown/stale cursor — each covered by an automated test
named after its acceptance criterion (`npm test`), plus the standalone
verification benchmark (`npm run benchmark`).

Reconnect behaviour on the client is explicitly configured (unlimited
attempts, capped exponential backoff with jitter) rather than left to
library defaults — see the comment in `client/src/lib/socketClient.js`.

`SUBMISSION.md` (the written decisions doc) and the demo video are both
complete — see `SUBMISSION.md` for the video link and full write-up.
