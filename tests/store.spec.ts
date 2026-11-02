import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/core/index.ts'
import { Kv } from '../src/app/kv.ts'
import { SCHEMA_VERSION, Store, StoreCorruptionError } from '../src/app/store.ts'
import { createClock, createIds, inboundMessage } from './fixtures/domain.ts'

let root = ''
let store: Store | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-store-'))
})

afterEach(async () => {
  store?.close()
  store = undefined
  await rm(root, { recursive: true, force: true })
})

function open(): Store {
  store?.close()
  store = Store.open(root)
  return store
}

function harnessOn(database: Store): { engine: Engine; clock: ReturnType<typeof createClock> } {
  const clock = createClock()
  return { engine: new Engine({ repos: database, ids: createIds(), clock }), clock }
}

function value(row: Record<string, unknown> | undefined, key: string): unknown {
  return row?.[key]
}

describe('store schema', () => {
  it('opens a WAL database with foreign keys, a busy timeout and the current schema', () => {
    const database = open()
    expect(database.file).toBe(join(root, 'state.db'))
    expect(existsSync(database.file)).toBe(true)
    expect(value(database.db.prepare('PRAGMA journal_mode').get(), 'journal_mode')).toBe('wal')
    expect(Number(value(database.db.prepare('PRAGMA user_version').get(), 'user_version'))).toBe(SCHEMA_VERSION)
    expect(Number(value(database.db.prepare('PRAGMA foreign_keys').get(), 'foreign_keys'))).toBe(1)
    expect(Number(value(database.db.prepare('PRAGMA busy_timeout').get(), 'timeout'))).toBe(5000)
  })

  it('creates every index the queries rely on', () => {
    const database = open()
    const names = database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => String(row['name']))
    for (const name of [
      'messages_thread_at',
      'decisions_thread_at',
      'tasks_status_updated',
      'approvals_status_expires',
      'outbound_status',
      'effects_due',
      'effects_active',
    ]) {
      expect(names).toContain(name)
    }
    const partial = database.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'effects_active'")
      .get()
    expect(String(partial?.['sql'])).toContain("WHERE state IN ('waiting', 'running')")
  })

  it('migrates idempotently and refuses a newer schema', () => {
    const first = open()
    expect(Number(value(first.db.prepare('PRAGMA user_version').get(), 'user_version'))).toBe(SCHEMA_VERSION)
    first.migrate()
    expect(Number(value(first.db.prepare('PRAGMA user_version').get(), 'user_version'))).toBe(SCHEMA_VERSION)
    first.close()

    const second = Store.open(root)
    expect(Number(value(second.db.prepare('PRAGMA user_version').get(), 'user_version'))).toBe(SCHEMA_VERSION)
    second.close()

    const raw = new DatabaseSync(join(root, 'state.db'))
    raw.exec('PRAGMA user_version = 2')
    raw.close()
    expect(() => Store.open(root)).toThrow(/newer/)
    store = undefined
  })
})

describe('store aggregates', () => {
  it('roundtrips every aggregate through a full engine flow and a reopen', () => {
    const database = open()
    const { engine } = harnessOn(database)

    const replyMessage = inboundMessage({ id: 'message-reply', at: '2026-11-02T08:58:00.000Z' })
    const reply = engine.receive(replyMessage).decision
    engine.classify(reply.id, { intent: 'chat', confidence: 0.7 })
    engine.draft(reply.id, { text: '好的', researched: true, sources: ['https://example.test'] })
    const outbound = engine.queueReply(reply.id, {
      outboundId: 'outbound-1',
      idempotencyKey: 'reply:message-reply',
      text: '好的',
      target: { kind: 'at-me', conversationId: 'conv-1', peerUserId: 'user-1' },
    })
    const sent = engine.replySent(reply.id, 'receipt-1')

    const taskMessage = inboundMessage({ id: 'message-task', at: '2026-11-02T08:59:00.000Z' })
    const decision = engine.receive(taskMessage).decision
    const classified = engine.classify(decision.id, {
      intent: 'task',
      reason: 'asks for a document',
      task: { title: '写发布说明', brief: '整理本周变更', requirements: ['中文'] },
      approvalTtlMs: 3_600_000,
    })
    const taskId = classified.taskId as string
    const approved = engine.approveTask(taskId, {
      by: 'owner',
      note: 'ok',
      at: '2026-11-02T09:00:10.000Z',
      workspace: '/workspace/task-1',
    })
    const approval = database.approvals.byTaskId(taskId)
    engine.assignmentStarted(taskId, approved.assignment.id)
    engine.assignmentEnded(taskId, approved.assignment.id, {
      outcome: 'succeeded',
      result: { summary: '完成', sessionId: 'session-1', artifactPaths: ['/tmp/a.md'] },
    })

    const thread = engine.thread('at-me:target-1:conv-1')
    const storedDecision = engine.decision(decision.id)
    const storedTask = engine.task(taskId)
    const storedOutbound = database.outbound.get(outbound.id)
    const storedAssignment = database.assignments.get(approved.assignment.id)
    database.close()

    const reopened = Store.open(root)
    store = reopened
    expect(reopened.messages.get('message-reply')).toEqual(replyMessage)
    expect(reopened.decisions.get(reply.id)).toEqual(sent)
    expect(reopened.threads.get('at-me:target-1:conv-1')).toEqual(thread)
    expect(reopened.decisions.get(decision.id)).toEqual(storedDecision)
    expect(reopened.tasks.get(taskId)).toEqual(storedTask)
    expect(reopened.approvals.byTaskId(taskId)).toEqual(approval)
    expect(reopened.assignments.get(approved.assignment.id)).toEqual(storedAssignment)
    expect(reopened.outbound.get(outbound.id)).toEqual(storedOutbound)
    expect(storedTask?.result).toEqual({ summary: '完成', sessionId: 'session-1', artifactPaths: ['/tmp/a.md'] })
    expect(storedOutbound?.receipt).toBe('receipt-1')
    expect(storedAssignment?.outcome).toBe('succeeded')
  })

  it('rolls back every write of a failed transaction', () => {
    const database = open()
    const thread = {
      key: 'at-me:target-1:conv-1',
      targetId: 'target-1',
      kind: 'at-me' as const,
      title: 'target-1',
      peer: null,
      lastMessageAt: '2026-11-02T08:59:00.000Z',
      createdAt: '2026-11-02T09:00:00.000Z',
      counts: { inbound: 1, replied: 0, tasks: 0 },
    }
    expect(() =>
      database.atomic(() => {
        database.threads.save(thread)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(database.threads.get(thread.key)).toBeUndefined()
  })

  it('refuses a nested transaction', () => {
    const database = open()
    expect(() => database.atomic(() => database.atomic(() => 1))).toThrow(/Nested transactions/)
  })

  it('enforces message and outbound uniqueness', () => {
    const database = open()
    const message = inboundMessage({ id: 'message-unique' })
    database.messages.save(message)
    expect(() => database.messages.save(message)).toThrow()

    const outbound = {
      id: 'outbound-1',
      idempotencyKey: 'reply:message-unique',
      kind: 'reply' as const,
      target: { kind: 'at-me' as const, conversationId: 'conv-1' },
      text: '一次',
      status: 'pending' as const,
      attempts: 0,
      lastError: null,
      sentAt: null,
      receipt: null,
    }
    database.outbound.save(outbound)
    expect(() => database.outbound.save({ ...outbound, id: 'outbound-2' })).toThrow()
  })

  it('raises StoreCorruptionError without leaking SQL or paths', () => {
    const database = open()
    database.db
      .prepare(
        `INSERT INTO threads (key, target_id, kind, title, peer_json, last_message_at, created_at, counts_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'broken',
        'target-1',
        'at-me',
        'broken',
        null,
        '2026-11-02T09:00:00.000Z',
        '2026-11-02T09:00:00.000Z',
        'not-json',
      )
    const error = capture(() => database.threads.get('broken'))
    expect(error).toBeInstanceOf(StoreCorruptionError)
    expect(error).toMatchObject({ table: 'threads', column: 'counts_json', id: 'broken' })
    const message = (error as Error).message
    expect(message).not.toContain('SELECT')
    expect(message).not.toContain(root)
  })
})

describe('store read queries', () => {
  it('pages threads and filters tasks by status', () => {
    const database = open()
    const { engine } = harnessOn(database)
    for (const [index, key] of ['thread-a', 'thread-b', 'thread-c'].entries()) {
      engine.receive(
        inboundMessage({
          id: `message-${index}`,
          threadKey: key,
          at: `2026-11-02T0${index}:00:00.000Z`,
        }),
      )
    }
    const firstPage = database.read.listThreads({ limit: 2 })
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.items.map((thread) => thread.key)).toEqual(['thread-c', 'thread-b'])
    expect(firstPage.nextOffset).toBe(2)
    const secondPage = database.read.listThreads({ limit: 2, offset: 2 })
    expect(secondPage.items.map((thread) => thread.key)).toEqual(['thread-a'])
    expect(secondPage.nextOffset).toBeNull()

    engine.receive(inboundMessage({ id: 'message-task', threadKey: 'thread-task' }))
    const taskDecision = engine.receive(inboundMessage({ id: 'message-task-2', threadKey: 'thread-task' })).decision
    const created = engine.classify(taskDecision.id, {
      intent: 'task',
      task: { title: 'task', requirements: [] },
      approvalTtlMs: 60_000,
    })
    engine.rejectTask(created.taskId as string, { by: 'owner', at: '2026-11-02T09:00:05.000Z' })
    expect(database.read.listTasks({ status: 'rejected' }).items.map((task) => task.id)).toEqual([created.taskId])
    expect(database.read.listTasks({ status: 'awaiting-approval' }).items).toEqual([])
    expect(database.read.listTasks({ status: ['rejected', 'cancelled'] }).items).toHaveLength(1)
  })

  it('pages thread messages before a cursor and pages the audit log', () => {
    const database = open()
    const { engine } = harnessOn(database)
    for (const [index, at] of [
      '2026-11-02T09:00:00.000Z',
      '2026-11-02T09:01:00.000Z',
      '2026-11-02T09:02:00.000Z',
    ].entries()) {
      engine.receive(inboundMessage({ id: `message-${index}`, at }))
    }
    const latest = database.read.threadMessages('at-me:target-1:conv-1', { limit: 2 })
    expect(latest.items.map((message) => message.id)).toEqual(['message-1', 'message-2'])
    expect(latest.nextBefore).toBe('2026-11-02T09:01:00.000Z')
    const older = database.read.threadMessages('at-me:target-1:conv-1', {
      limit: 2,
      before: latest.nextBefore as string,
    })
    expect(older.items.map((message) => message.id)).toEqual(['message-0'])
    expect(older.nextBefore).toBeNull()

    database.appendEvent('reply.sent', '2026-11-02T09:03:00.000Z', { decisionId: 'decision-1' })
    database.appendEvent('task.created', '2026-11-02T09:04:00.000Z', { taskId: 'task-1' })
    const audit = database.read.audit({ limit: 1 })
    expect(audit.items).toHaveLength(1)
    expect(audit.items[0]).toMatchObject({ type: 'task.created', data: { taskId: 'task-1' } })
    expect(audit.nextOffset).toBe(1)
    const rest = database.read.audit({ limit: 1, offset: 1 })
    expect(rest.items[0]?.type).toBe('reply.sent')
    expect(rest.nextOffset).toBeNull()
  })

  it('lists only actionable approvals and pending outbound messages', () => {
    const database = open()
    const { engine } = harnessOn(database)
    const decision = engine.receive(inboundMessage({ id: 'message-t' })).decision
    const created = engine.classify(decision.id, {
      intent: 'task',
      task: { title: 'task' },
      approvalTtlMs: 1_000,
    })
    expect(database.read.pendingApprovals('2026-11-02T09:00:00.500Z').map((item) => item.taskId)).toEqual([
      created.taskId,
    ])
    expect(database.read.pendingApprovals('2026-11-02T09:00:02.000Z')).toEqual([])

    const reply = engine.receive(inboundMessage({ id: 'message-r' })).decision
    engine.classify(reply.id, { intent: 'chat' })
    engine.draft(reply.id, { text: '好', researched: false, sources: [] })
    engine.queueReply(reply.id, {
      outboundId: 'outbound-r',
      idempotencyKey: 'reply:message-r',
      text: '好',
      target: { kind: 'at-me', conversationId: 'conv-1' },
    })
    expect(database.read.pendingOutbound().map((item) => item.id)).toEqual(['outbound-r'])
    engine.replySent(reply.id)
    expect(database.read.pendingOutbound()).toEqual([])
  })

  it('trims old messages without touching decisions or tasks', () => {
    const database = open()
    const { engine } = harnessOn(database)
    for (const [index, at] of [
      '2026-11-02T09:00:00.000Z',
      '2026-11-02T09:01:00.000Z',
      '2026-11-02T09:02:00.000Z',
    ].entries()) {
      engine.receive(inboundMessage({ id: `message-${index}`, at }))
    }
    const decision = engine.receive(inboundMessage({ id: 'message-task', at: '2026-11-02T09:03:00.000Z' })).decision
    const created = engine.classify(decision.id, {
      intent: 'task',
      task: { title: 'task' },
      approvalTtlMs: 60_000,
    })
    expect(database.read.listTasks({}).items).toHaveLength(1)

    expect(database.trimThread('at-me:target-1:conv-1', 2)).toBe(2)
    expect(database.read.threadMessages('at-me:target-1:conv-1', {}).items.map((message) => message.id)).toEqual([
      'message-2',
      'message-task',
    ])
    expect(database.decisions.get(decision.id)?.taskId).toBe(created.taskId)
    expect(database.tasks.get(created.taskId as string)?.status).toBe('awaiting-approval')
    expect(database.read.listTasks({}).items).toHaveLength(1)
  })
})

describe('key-value store', () => {
  it('roundtrips typed values and reports unreadable ones', () => {
    const database = open()
    const kv = new Kv(database)
    expect(kv.get('missing')).toBeUndefined()
    kv.set('settings:revision', 3)
    kv.set('settings:block:monitor', { enabled: true })
    expect(kv.get('settings:revision')).toBe(3)
    expect(kv.get('settings:block:monitor')).toEqual({ enabled: true })
    expect(kv.keys('settings:')).toEqual(['settings:block:monitor', 'settings:revision'])
    expect(kv.delete('settings:revision')).toBe(true)
    expect(kv.delete('settings:revision')).toBe(false)
    expect(kv.get('settings:revision')).toBeUndefined()

    database.db.prepare('INSERT INTO kv (k, v_json) VALUES (?, ?)').run('broken', '{')
    expect(() => kv.get('broken')).toThrow(StoreCorruptionError)
  })
})

function capture(work: () => unknown): unknown {
  try {
    work()
    return undefined
  } catch (error) {
    return error
  }
}
