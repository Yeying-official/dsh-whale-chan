/**
 * Forward-only SQLite migrations of the assistant state database.
 *
 * The schema version lives in `PRAGMA user_version`, not in a table, so a fresh
 * database and a migrated one are indistinguishable once they hold the same
 * shape. A database newer than this build is refused instead of downgraded.
 *
 * Domain aggregates keep their nested values in JSON columns and expose the
 * columns that queries filter or sort on. JSON is the source of truth for the
 * aggregate; the scalar columns are derived at write time by the store.
 */
import type { DatabaseSync } from 'node:sqlite'

/** Schema this build writes and reads. */
export const SCHEMA_VERSION = 2

/** Oldest schema a migration exists for; a version below it cannot be upgraded. */
export const OLDEST_SCHEMA_VERSION = 0

/** One forward step; it must be safe to run on an empty database. */
export type Migration = (db: DatabaseSync) => void

/**
 * Schema 1: the first durable shape.
 *
 * `effects` belongs here rather than to `effects.ts`, so the queue table is
 * versioned with everything else and `Effects` stays a consumer of the schema.
 * Its partial unique index admits at most one active row per `(kind, key)`;
 * see `docs/007-architecture.md` for how a re-enqueue during a running attempt
 * is kept instead of dropped.
 */
const schema1: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      target_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      conversation_type TEXT NOT NULL,
      title TEXT,
      sender_id TEXT NOT NULL,
      sender_nick TEXT NOT NULL,
      sender_open_id TEXT,
      text TEXT NOT NULL,
      addressed INTEGER NOT NULL,
      at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      mentions_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      key TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      peer_json TEXT,
      last_message_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      counts_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      thread_key TEXT NOT NULL,
      intent TEXT,
      status TEXT NOT NULL,
      draft_json TEXT,
      outbound_id TEXT,
      task_id TEXT,
      reason TEXT,
      confidence REAL,
      attempts INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      requester_json TEXT NOT NULL,
      message_id TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      requirements_json TEXT NOT NULL,
      status TEXT NOT NULL,
      approval_id TEXT,
      assignment_id TEXT,
      result_json TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      session_id TEXT,
      workspace TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      outcome TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS outbound (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      peer_user_id TEXT,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_at TEXT,
      receipt TEXT
    );

    CREATE TABLE IF NOT EXISTS effects (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('waiting', 'running', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS messages_thread_at ON messages(thread_key, at);
    CREATE INDEX IF NOT EXISTS decisions_thread_at ON decisions(thread_key, at);
    CREATE INDEX IF NOT EXISTS tasks_status_updated ON tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS approvals_status_expires ON approvals(status, expires_at);
    CREATE INDEX IF NOT EXISTS outbound_status ON outbound(status);
    CREATE INDEX IF NOT EXISTS effects_due ON effects(state, due_at);
    CREATE UNIQUE INDEX IF NOT EXISTS effects_active ON effects(kind, key) WHERE state IN ('waiting', 'running');
    CREATE INDEX IF NOT EXISTS events_at ON events(at);
  `)
}

/**
 * Schema 2: durable, versioned settings.
 *
 * One row per settings block, a revision per block for optimistic concurrency,
 * a single global revision row, and an append-only history that records who
 * wrote which value. The migration is safe to run twice: every statement is
 * idempotent and the meta row is inserted with `INSERT OR IGNORE`.
 */
const schema2: Migration = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      block TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block TEXT NOT NULL,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      saved_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS settings_history_block ON settings_history(block, id);
  `)
  db.prepare('INSERT OR IGNORE INTO settings_meta (id, revision, updated_at) VALUES (1, 0, ?)').run(
    new Date().toISOString(),
  )
}

/** Every migration this build knows, indexed by the version it upgrades from. */
export const MIGRATIONS: readonly Migration[] = [schema1, schema2]
