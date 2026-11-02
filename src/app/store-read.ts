/**
 * Read-only projections of the state database, plus the row mappers shared with
 * the writable store.
 *
 * Nothing here writes: `Store` owns every mutation and transaction, and the
 * panel, the passes and the tools read through these queries. A JSON column
 * that no longer parses raises `StoreCorruptionError`, which names the table,
 * the column and the row id; it never leaks SQL text or filesystem paths.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type {
  Approval,
  Assignment,
  AssignmentOutcome,
  Decision,
  DecisionStatus,
  InboundMessage,
  Intent,
  IsoTime,
  Outbound,
  Sender,
  Task,
  TaskResult,
  TaskStatus,
  Thread,
  ThreadCounts,
} from '../core/index.ts'

/** One decoded row. */
export type Row = Record<string, SQLOutputValue>

/** Stored JSON that cannot be read; the caller's only recovery is to repair or drop the row. */
export class StoreCorruptionError extends Error {
  readonly code = 'store_corruption'

  constructor(
    readonly table: string,
    readonly column: string,
    readonly id: string,
  ) {
    super(`Stored ${table}.${column} for ${id} is not readable JSON`)
    this.name = 'StoreCorruptionError'
  }
}

function text(value: SQLOutputValue | undefined): string {
  if (typeof value === 'string') return value
  return value === null || value === undefined ? '' : String(value)
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value)
}

function integer(value: SQLOutputValue | undefined): number {
  return value === null || value === undefined ? 0 : Number(value)
}

/** Decode a JSON column that must hold a value. */
export function decodeJson<T>(table: string, column: string, id: string, value: SQLOutputValue | undefined): T {
  if (value === null || value === undefined) throw new StoreCorruptionError(table, column, id)
  try {
    return JSON.parse(String(value)) as T
  } catch {
    throw new StoreCorruptionError(table, column, id)
  }
}

/** Decode a JSON column that may be SQL `NULL`. */
export function decodeNullableJson<T>(
  table: string,
  column: string,
  id: string,
  value: SQLOutputValue | undefined,
): T | null {
  if (value === null || value === undefined) return null
  return decodeJson<T>(table, column, id, value)
}

export function messageFromRow(row: Row): InboundMessage {
  const id = text(row['id'])
  const openDingTalkId = nullableText(row['sender_open_id'])
  const title = nullableText(row['title'])
  const sender: Sender = {
    userId: text(row['sender_id']),
    nick: text(row['sender_nick']),
    ...(openDingTalkId === null ? {} : { openDingTalkId }),
  }
  return {
    id,
    targetId: text(row['target_id']),
    threadKey: text(row['thread_key']),
    kind: text(row['kind']) as InboundMessage['kind'],
    conversationId: text(row['conversation_id']),
    conversationType: text(row['conversation_type']) as InboundMessage['conversationType'],
    ...(title === null ? {} : { title }),
    sender,
    text: text(row['text']),
    addressed: integer(row['addressed']) === 1,
    at: text(row['at']),
    receivedAt: text(row['received_at']),
    mentions: decodeJson<string[]>('messages', 'mentions_json', id, row['mentions_json']),
  }
}

export function threadFromRow(row: Row): Thread {
  const key = text(row['key'])
  return {
    key,
    targetId: text(row['target_id']),
    kind: text(row['kind']) as Thread['kind'],
    title: text(row['title']),
    peer: decodeNullableJson<Sender>('threads', 'peer_json', key, row['peer_json']),
    lastMessageAt: text(row['last_message_at']),
    createdAt: text(row['created_at']),
    counts: decodeJson<ThreadCounts>('threads', 'counts_json', key, row['counts_json']),
  }
}

export function decisionFromRow(row: Row): Decision {
  const id = text(row['id'])
  return {
    id,
    messageId: text(row['message_id']),
    threadKey: text(row['thread_key']),
    intent: nullableText(row['intent']) as Intent | null,
    status: text(row['status']) as DecisionStatus,
    draft: decodeNullableJson<Decision['draft']>('decisions', 'draft_json', id, row['draft_json']),
    outboundId: nullableText(row['outbound_id']),
    taskId: nullableText(row['task_id']),
    reason: nullableText(row['reason']),
    confidence: row['confidence'] === null || row['confidence'] === undefined ? null : Number(row['confidence']),
    attempts: integer(row['attempts']),
    at: text(row['at']),
    updatedAt: text(row['updated_at']),
  }
}

export function taskFromRow(row: Row): Task {
  const id = text(row['id'])
  return {
    id,
    threadKey: text(row['thread_key']),
    requester: decodeJson<Sender>('tasks', 'requester_json', id, row['requester_json']),
    messageId: text(row['message_id']),
    title: text(row['title']),
    brief: text(row['brief']),
    requirements: decodeJson<string[]>('tasks', 'requirements_json', id, row['requirements_json']),
    status: text(row['status']) as TaskStatus,
    approvalId: nullableText(row['approval_id']),
    assignmentId: nullableText(row['assignment_id']),
    result: decodeNullableJson<TaskResult>('tasks', 'result_json', id, row['result_json']),
    reason: nullableText(row['reason']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
  }
}

export function approvalFromRow(row: Row): Approval {
  return {
    id: text(row['id']),
    taskId: text(row['task_id']),
    status: text(row['status']) as Approval['status'],
    requestedAt: text(row['requested_at']),
    expiresAt: text(row['expires_at']),
    decidedAt: nullableText(row['decided_at']),
    decidedBy: nullableText(row['decided_by']) as Approval['decidedBy'],
    note: nullableText(row['note']),
  }
}

export function assignmentFromRow(row: Row): Assignment {
  return {
    id: text(row['id']),
    taskId: text(row['task_id']),
    state: text(row['state']) as Assignment['state'],
    sessionId: nullableText(row['session_id']),
    workspace: text(row['workspace']),
    startedAt: nullableText(row['started_at']),
    endedAt: nullableText(row['ended_at']),
    outcome: nullableText(row['outcome']) as AssignmentOutcome | null,
    error: nullableText(row['error']),
  }
}

export function outboundFromRow(row: Row): Outbound {
  const peerUserId = nullableText(row['peer_user_id'])
  return {
    id: text(row['id']),
    idempotencyKey: text(row['idempotency_key']),
    kind: text(row['kind']) as Outbound['kind'],
    target: {
      kind: text(row['target_kind']) as Outbound['target']['kind'],
      conversationId: text(row['conversation_id']),
      ...(peerUserId === null ? {} : { peerUserId }),
    },
    text: text(row['text']),
    status: text(row['status']) as Outbound['status'],
    attempts: integer(row['attempts']),
    lastError: nullableText(row['last_error']),
    sentAt: nullableText(row['sent_at']),
    receipt: nullableText(row['receipt']),
  }
}

/** One audit record: the durable event log written by the app layer. */
export interface AuditRecord {
  readonly seq: number
  readonly type: string
  readonly at: IsoTime
  readonly data: unknown
}

/** A page of rows plus the offset of the next page, or null at the end. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly nextOffset: number | null
}

export interface ListOptions {
  readonly limit?: number
  readonly offset?: number
}

export interface ThreadMessageOptions {
  readonly limit?: number
  /** Exclusive ISO time cursor: return messages strictly older than it. */
  readonly before?: IsoTime
}

export interface ThreadMessagesPage {
  readonly items: readonly InboundMessage[]
  /** Cursor for the next older page, or null at the start of the thread. */
  readonly nextBefore: IsoTime | null
}

export interface TaskListOptions extends ListOptions {
  readonly status?: TaskStatus | readonly TaskStatus[]
}

export interface ReadQueries {
  listThreads(options?: ListOptions): Page<Thread>
  threadMessages(key: string, options?: ThreadMessageOptions): ThreadMessagesPage
  listTasks(options?: TaskListOptions): Page<Task>
  /** Pending approvals whose `expiresAt` is still in the future at `now`. */
  pendingApprovals(now: IsoTime | Date): readonly Approval[]
  pendingOutbound(): readonly Outbound[]
  audit(options?: ListOptions): Page<AuditRecord>
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function pageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(value), MAX_LIMIT)
}

function pageOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

function isoCutoff(now: IsoTime | Date): IsoTime {
  return now instanceof Date ? now.toISOString() : now
}

export function storeReads(db: DatabaseSync): ReadQueries {
  const rows = (sql: string, ...parameters: (string | number)[]): Row[] =>
    db.prepare(sql).all(...parameters) as unknown as Row[]
  return {
    listThreads(options = {}) {
      const limit = pageSize(options.limit)
      const offset = pageOffset(options.offset)
      const found = rows('SELECT * FROM threads ORDER BY last_message_at DESC, key LIMIT ? OFFSET ?', limit + 1, offset)
      const items = found.slice(0, limit).map(threadFromRow)
      return { items, nextOffset: found.length > limit ? offset + limit : null }
    },
    threadMessages(key, options = {}) {
      const limit = pageSize(options.limit)
      const before = options.before
      const found =
        before === undefined
          ? rows('SELECT * FROM messages WHERE thread_key = ? ORDER BY at DESC, rowid DESC LIMIT ?', key, limit + 1)
          : rows(
              'SELECT * FROM messages WHERE thread_key = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?',
              key,
              before,
              limit + 1,
            )
      const items = found.slice(0, limit).map(messageFromRow).reverse()
      const oldest = items[0]
      return { items, nextBefore: found.length > limit && oldest ? oldest.at : null }
    },
    listTasks(options = {}) {
      const limit = pageSize(options.limit)
      const offset = pageOffset(options.offset)
      const statuses =
        options.status === undefined
          ? []
          : Array.isArray(options.status)
            ? [...(options.status as readonly TaskStatus[])]
            : [options.status as TaskStatus]
      const filter = statuses.length ? `WHERE status IN (${statuses.map(() => '?').join(', ')})` : ''
      const found = rows(
        `SELECT * FROM tasks ${filter} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
        ...statuses,
        limit + 1,
        offset,
      )
      const items = found.slice(0, limit).map(taskFromRow)
      return { items, nextOffset: found.length > limit ? offset + limit : null }
    },
    pendingApprovals(now) {
      return rows(
        "SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY expires_at, id",
        isoCutoff(now),
      ).map(approvalFromRow)
    },
    pendingOutbound() {
      return rows("SELECT * FROM outbound WHERE status = 'pending' ORDER BY rowid").map(outboundFromRow)
    },
    audit(options = {}) {
      const limit = pageSize(options.limit)
      const offset = pageOffset(options.offset)
      const found = rows('SELECT * FROM events ORDER BY seq DESC LIMIT ? OFFSET ?', limit + 1, offset)
      const items = found.slice(0, limit).map((row) => {
        const seq = integer(row['seq'])
        return {
          seq,
          type: text(row['type']),
          at: text(row['at']),
          data: decodeJson<unknown>('events', 'data_json', String(seq), row['data_json']),
        }
      })
      return { items, nextOffset: found.length > limit ? offset + limit : null }
    },
  }
}
