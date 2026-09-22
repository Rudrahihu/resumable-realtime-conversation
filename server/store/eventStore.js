/**
 * The only module that reads/writes conversations, messages, runs, and
 * run_events. Orchestrator calls this; nothing else touches the DB
 * directly (see README's separation-of-concerns rule).
 *
 * All statements are prepared once per store instance (better-sqlite3
 * convention) rather than per call.
 */

/** Thrown when appendEvent hits the UNIQUE(run_id, position) constraint —
 *  i.e. the orchestrator tried to write the same position twice for the
 *  same run. Callers can catch this specifically instead of parsing
 *  SQLite's raw error message. */
export class DuplicateEventError extends Error {
  constructor(runId, position) {
    super(`duplicate event at run ${runId} position ${position}`);
    this.name = 'DuplicateEventError';
    this.runId = runId;
    this.position = position;
  }
}

export function createEventStore(db) {
  const stmts = {
    insertConversation: db.prepare(
      `INSERT INTO conversations (id) VALUES (?)`
    ),

    ensureConversation: db.prepare(
      `INSERT OR IGNORE INTO conversations (id) VALUES (?)`
    ),

    insertMessage: db.prepare(
      `INSERT INTO messages (id, conversation_id, client_message_id, role, content)
       VALUES (?, ?, ?, ?, ?)`
    ),

    insertRun: db.prepare(
      `INSERT INTO runs (id, conversation_id, message_id) VALUES (?, ?, ?)`
    ),

    insertEvent: db.prepare(
      `INSERT INTO run_events (run_id, position, type, payload)
       VALUES (?, ?, ?, ?)`
    ),

    eventsAfter: db.prepare(
      `SELECT run_id, position, type, payload, created_at
       FROM run_events
       WHERE run_id = ? AND position > ?
       ORDER BY position ASC`
    ),

    highestPosition: db.prepare(
      `SELECT MAX(position) AS maxPos FROM run_events WHERE run_id = ?`
    ),

    getRun: db.prepare(
      `SELECT id, conversation_id, message_id, status, created_at, updated_at
       FROM runs WHERE id = ?`
    ),

    // The whole safety story for "exactly one terminal transition" lives in
    // this WHERE clause: it only ever matches a row that is still running.
    updateRunStatus: db.prepare(
      `UPDATE runs
       SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'running'`
    ),

    // Used on process startup to reconcile runs that were mid-flight when
    // the previous process died (AC4 restart policy: don't silently resume
    // generation — mark them failed with a distinguishable reason).
    listRunningRuns: db.prepare(
      `SELECT id FROM runs WHERE status = 'running'`
    ),
  };

  function rowToEvent(row) {
    return {
      runId: row.run_id,
      position: row.position,
      type: row.type,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
    };
  }

  return {
    createConversation(id) {
      stmts.insertConversation.run(id);
    },

    /** Idempotent version of createConversation — used by the socket layer
     *  when a client sends a conversation_id that may or may not already
     *  exist (first message vs. a later message in the same thread). */
    ensureConversation(id) {
      stmts.ensureConversation.run(id);
    },

    createMessage({ id, conversationId, role, content, clientMessageId = null }) {
      stmts.insertMessage.run(id, conversationId, clientMessageId, role, content);
    },

    createRun({ id, conversationId, messageId }) {
      stmts.insertRun.run(id, conversationId, messageId);
    },

    appendEvent({ runId, position, type, payload }) {
      try {
        stmts.insertEvent.run(runId, position, type, JSON.stringify(payload));
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          throw new DuplicateEventError(runId, position);
        }
        throw err;
      }
    },

    getEventsAfter(runId, cursor) {
      return stmts.eventsAfter.all(runId, cursor).map(rowToEvent);
    },

    getHighestPosition(runId) {
      const row = stmts.highestPosition.get(runId);
      return row?.maxPos ?? -1;
    },

    getRun(runId) {
      const row = stmts.getRun.get(runId);
      if (!row) return null;
      return {
        id: row.id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    /** Returns true if this call actually performed the transition
     *  (i.e. the run was still 'running'); false if some earlier call
     *  already moved it to a terminal state. Callers use this to decide
     *  whether they "won" the race and should act on it (e.g. only the
     *  winner should append the corresponding done/error event). */
    setRunStatus(runId, status) {
      const info = stmts.updateRunStatus.run(status, runId);
      return info.changes === 1;
    },

    /** For the startup reconciliation sweep described in the restart
     *  policy: any run still 'running' from a previous process is dead. */
    listRunningRuns() {
      return stmts.listRunningRuns.all().map((r) => r.id);
    },
  };
}
