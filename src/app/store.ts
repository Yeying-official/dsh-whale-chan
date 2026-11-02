/**
 * SQLite persistence of the domain.
 *
 * `Store` opens `<stateDir>/state.db`, applies the forward schema migration,
 * and implements the core `Repositories` port on top of one `DatabaseSync`
 * handle. Every engine command runs inside `atomic`, a single
 * `BEGIN IMMEDIATE` transaction: a command that throws rolls back completely, so
 * no half task, half approval or half outbound row can be observed.
 *
 * Nested transactions are refused on purpose. A command must be the only
 * transaction of its unit of work; a caller that needs two commands issues two
 * transactions instead of composing them silently.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import type {
  Approval,
  Assignment,
  Decision,
  InboundMessage,
  IsoTime,
  Outbound,
  Repositories,
  Task,
  Thread,
} from '../core/index.ts'
import { MIGRATIONS, SCHEMA_VERSION } from './migration.ts'
import {
  approvalFromRow,
  assignmentFromRow,
  decisionFromRow,
  messageFromRow,
  outboundFromRow,
  StoreCorruptionError,
  storeReads,
  taskFromRow,
  threadFromRow,
  type ReadQueries,
  type Row,
} from './store-read.ts'

export { SCHEMA_VERSION } from './migration.ts'
export { StoreCorruptionError } from './store-read.ts'

export interface StoreOptions {
  /** Override the database file; defaults to `<stateDir>/state.db`. */
  readonly file?: string
}

/** The durable state database. */
export class Store implements Repositories {
  readonly file: string
  readonly db: DatabaseSync
  readonly read: ReadQueries
  readonly messages: Repositories['messages']
  readonly threads: Repositories['threads']
  readonly decisions: Repositories['decisions']
  readonly tasks: Repositories['tasks']
  readonly approvals: Repositories['approvals']
  readonly assignments: Repositories['assignments']
  readonly outbound: Repositories['outbound']
  private readonly statements = new Map<string, StatementSync>()
  private depth = 0

  /**
   * Open, configure and migrate the database of a state directory.
   *
   * The database file is created when missing. A schema newer than this build is
   * refused, and a failed migration closes the handle so a later attempt can
   * retry instead of inheriting a half-migrated file.
   */
  static open(stateDir: string, options: StoreOptions = {}): Store {
    const file = options.file ?? join(stateDir, 'state.db')
    mkdirSync(dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = FULL')
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('PRAGMA busy_timeout = 5000')
      return new Store(file, db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  private constructor(file: string, db: DatabaseSync) {
    this.file = file
    this.db = db
    this.migrate()
    this.read = storeReads(db)
    const maybe = <T>(row: Row | undefined, map: (row: Row) => T): T | undefined =>
      row === undefined ? undefined : map(row)

    this.messages = {
      get: (id) => maybe(this.row('SELECT * FROM messages WHERE id = ?', id), messageFromRow),
      save: (message) => {
        this.statement(
          `INSERT INTO messages (id, thread_key, target_id, kind, conversation_id, conversation_type, title,
            sender_id, sender_nick, sender_open_id, text, addressed, at, received_at, mentions_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          message.id,
          message.threadKey,
          message.targetId,
          message.kind,
          message.conversationId,
          message.conversationType,
          message.title ?? null,
          message.sender.userId,
          message.sender.nick,
          message.sender.openDingTalkId ?? null,
          message.text,
          message.addressed ? 1 : 0,
          message.at,
          message.receivedAt,
          JSON.stringify(message.mentions),
        )
      },
    }

    this.threads = {
      get: (key) => maybe(this.row('SELECT * FROM threads WHERE key = ?', key), threadFromRow),
      save: (thread) => {
        this.statement(
          `INSERT INTO threads (key, target_id, kind, title, peer_json, last_message_at, created_at, counts_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             target_id = excluded.target_id,
             kind = excluded.kind,
             title = excluded.title,
             peer_json = excluded.peer_json,
             last_message_at = excluded.last_message_at,
             counts_json = excluded.counts_json`,
        ).run(
          thread.key,
          thread.targetId,
          thread.kind,
          thread.title,
          JSON.stringify(thread.peer),
          thread.lastMessageAt,
          thread.createdAt,
          JSON.stringify(thread.counts),
        )
      },
    }

    this.decisions = {
      get: (id) => maybe(this.row('SELECT * FROM decisions WHERE id = ?', id), decisionFromRow),
      byMessageId: (messageId) =>
        maybe(this.row('SELECT * FROM decisions WHERE message_id = ?', messageId), decisionFromRow),
      save: (decision) => {
        this.statement(
          `INSERT INTO decisions (id, message_id, thread_key, intent, status, draft_json, outbound_id, task_id,
            reason, confidence, attempts, at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             intent = excluded.intent,
             status = excluded.status,
             draft_json = excluded.draft_json,
             outbound_id = excluded.outbound_id,
             task_id = excluded.task_id,
             reason = excluded.reason,
             confidence = excluded.confidence,
             attempts = excluded.attempts,
             updated_at = excluded.updated_at`,
        ).run(
          decision.id,
          decision.messageId,
          decision.threadKey,
          decision.intent,
          decision.status,
          decision.draft === null ? null : JSON.stringify(decision.draft),
          decision.outboundId,
          decision.taskId,
          decision.reason,
          decision.confidence,
          decision.attempts,
          decision.at,
          decision.updatedAt,
        )
      },
    }

    this.tasks = {
      get: (id) => maybe(this.row('SELECT * FROM tasks WHERE id = ?', id), taskFromRow),
      save: (task) => {
        this.statement(
          `INSERT INTO tasks (id, thread_key, requester_json, message_id, title, brief, requirements_json,
            status, approval_id, assignment_id, result_json, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             approval_id = excluded.approval_id,
             assignment_id = excluded.assignment_id,
             result_json = excluded.result_json,
             reason = excluded.reason,
             updated_at = excluded.updated_at`,
        ).run(
          task.id,
          task.threadKey,
          JSON.stringify(task.requester),
          task.messageId,
          task.title,
          task.brief,
          JSON.stringify(task.requirements),
          task.status,
          task.approvalId,
          task.assignmentId,
          task.result === null ? null : JSON.stringify(task.result),
          task.reason,
          task.createdAt,
          task.updatedAt,
        )
      },
      open: () =>
        this.rows(
          "SELECT * FROM tasks WHERE status IN ('captured', 'awaiting-approval', 'approved', 'running') ORDER BY updated_at, id",
        ).map(taskFromRow),
    }

    this.approvals = {
      get: (id) => maybe(this.row('SELECT * FROM approvals WHERE id = ?', id), approvalFromRow),
      byTaskId: (taskId) => maybe(this.row('SELECT * FROM approvals WHERE task_id = ?', taskId), approvalFromRow),
      save: (approval) => {
        this.statement(
          `INSERT INTO approvals (id, task_id, status, requested_at, expires_at, decided_at, decided_by, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             decided_at = excluded.decided_at,
             decided_by = excluded.decided_by,
             note = excluded.note`,
        ).run(
          approval.id,
          approval.taskId,
          approval.status,
          approval.requestedAt,
          approval.expiresAt,
          approval.decidedAt,
          approval.decidedBy,
          approval.note,
        )
      },
      listPending: () =>
        this.rows("SELECT * FROM approvals WHERE status = 'pending' ORDER BY expires_at, id").map(approvalFromRow),
    }

    this.assignments = {
      get: (id) => maybe(this.row('SELECT * FROM assignments WHERE id = ?', id), assignmentFromRow),
      save: (assignment) => {
        this.statement(
          `INSERT INTO assignments (id, task_id, state, session_id, workspace, started_at, ended_at, outcome, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             state = excluded.state,
             session_id = excluded.session_id,
             started_at = excluded.started_at,
             ended_at = excluded.ended_at,
             outcome = excluded.outcome,
             error = excluded.error`,
        ).run(
          assignment.id,
          assignment.taskId,
          assignment.state,
          assignment.sessionId,
          assignment.workspace,
          assignment.startedAt,
          assignment.endedAt,
          assignment.outcome,
          assignment.error,
        )
      },
    }

    this.outbound = {
      get: (id) => maybe(this.row('SELECT * FROM outbound WHERE id = ?', id), outboundFromRow),
      byIdempotencyKey: (key) =>
        maybe(this.row('SELECT * FROM outbound WHERE idempotency_key = ?', key), outboundFromRow),
      save: (outbound) => {
        this.statement(
          `INSERT INTO outbound (id, idempotency_key, kind, target_kind, conversation_id, peer_user_id, text,
            status, attempts, last_error, sent_at, receipt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             attempts = excluded.attempts,
             last_error = excluded.last_error,
             sent_at = excluded.sent_at,
             receipt = excluded.receipt`,
        ).run(
          outbound.id,
          outbound.idempotencyKey,
          outbound.kind,
          outbound.target.kind,
          outbound.target.conversationId,
          outbound.target.peerUserId ?? null,
          outbound.text,
          outbound.status,
          outbound.attempts,
          outbound.lastError,
          outbound.sentAt,
          outbound.receipt,
        )
      },
      pending: () => this.rows("SELECT * FROM outbound WHERE status = 'pending' ORDER BY rowid").map(outboundFromRow),
    }
  }

  /** Apply every migration this build has not applied yet; safe to call again. */
  migrate(): void {
    const current = Number(this.db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0)
    if (current > SCHEMA_VERSION) {
      throw new Error(`Store schema ${current} is newer than this build supports (${SCHEMA_VERSION})`)
    }
    if (current === SCHEMA_VERSION) return
    this.atomic(() => {
      for (let version = current; version < SCHEMA_VERSION; version += 1) {
        const step = MIGRATIONS[version]
        if (!step) throw new Error(`No migration from store schema ${version}`)
        step(this.db)
        this.db.exec(`PRAGMA user_version = ${version + 1}`)
      }
    })
  }

  /**
   * Run `work` in one `BEGIN IMMEDIATE` transaction. A throw rolls the whole
   * transaction back; a nested call is refused instead of silently joining the
   * outer transaction.
   */
  atomic<T>(work: () => T): T {
    if (this.depth !== 0) throw new Error('Nested transactions are not supported; run one command per transaction')
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction is already gone; the original error is the useful one.
      }
      throw error
    } finally {
      this.depth = 0
    }
  }

  /**
   * Keep only the newest `keep` messages of a thread. Decisions and tasks are
   * never touched: they are the audit trail, not the chat log.
   * @returns the number of deleted message rows.
   */
  trimThread(key: string, keep = 200): number {
    if (!Number.isInteger(keep) || keep < 0) throw new Error('keep must be a non-negative integer')
    return this.atomic(() => {
      const result = this.statement(
        `DELETE FROM messages WHERE thread_key = ? AND id NOT IN (
           SELECT id FROM messages WHERE thread_key = ? ORDER BY at DESC, rowid DESC LIMIT ?
         )`,
      ).run(key, key, keep)
      return Number(result.changes)
    })
  }

  /** Append one durable audit record; the app layer wires domain events here. */
  appendEvent(type: string, at: IsoTime, data: unknown): void {
    this.statement('INSERT INTO events (type, at, data_json) VALUES (?, ?, ?)').run(type, at, JSON.stringify(data))
  }

  /** Close the database handle. */
  close(): void {
    this.statements.clear()
    this.db.close()
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private rows(sql: string, ...parameters: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...parameters) as unknown as Row[]
  }

  private row(sql: string, ...parameters: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...parameters) as unknown as Row | undefined
  }
}
