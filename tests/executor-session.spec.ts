/**
 * The turn-boundary matcher and the wait around it.
 *
 * `DshSessionHost.awaitTurnEnd` is these two pieces plus a `ctx.on(
 * 'session/event')` subscription, so this file verifies the behaviour that
 * matters — matching the right turn, surviving a turn that ended before the
 * subscription, closing the subscribe/scan race, the timeout and the abort —
 * against a fake event source instead of a live DSH session.
 *
 * The DSH adapter itself (`DshSessionHost`) is verified by the type checker
 * against the shipped `@deepseek-ai/*` declarations; every call it makes is
 * recorded with its signature in `docs/test-reports/WS4.md`, because a real
 * session cannot be created in a unit test without starting a model call.
 */
import { describe, expect, it } from 'vitest'
import {
  TurnTracker,
  awaitTurn,
  deliveryId,
  ensureWorkspace,
  type TrackedSessionEvent,
  type WorkspaceTitleRecord,
} from '../src/executor/index.ts'

function start(turn: number): TrackedSessionEvent {
  return { type: 'turn/start', data: { turn } }
}

function end(turn: number, kind = 'completed', cause?: string): TrackedSessionEvent {
  return {
    type: 'turn/end',
    data: { turn, reason: cause === undefined ? { kind } : { kind, reason: { kind: cause } } },
  }
}

function userMessage(id: string): TrackedSessionEvent {
  return { type: 'user/message', data: { id } }
}

/** A fake session event source: durable history plus live subscription. */
class FakeEventLog {
  readonly events: TrackedSessionEvent[] = []
  unsubscribed = 0
  /** Called synchronously when a listener subscribes, which reproduces the subscribe/scan race. */
  onSubscribe: (() => void) | undefined
  private readonly listeners = new Set<(event: TrackedSessionEvent) => void>()

  history(): readonly TrackedSessionEvent[] {
    return [...this.events]
  }

  readonly subscribe = (listener: (event: TrackedSessionEvent) => void): (() => void) => {
    this.listeners.add(listener)
    const onSubscribe = this.onSubscribe
    this.onSubscribe = undefined
    onSubscribe?.()
    return () => {
      this.listeners.delete(listener)
      this.unsubscribed += 1
    }
  }

  push(event: TrackedSessionEvent): void {
    this.events.push(event)
    for (const listener of [...this.listeners]) listener(event)
  }
}

describe('TurnTracker', () => {
  it('settles on the turn end of the turn that carried the delivery', () => {
    const tracker = new TurnTracker(
      [start(1), end(1), start(2), userMessage('dsh-whale-chan:task:task-1'), start(3), end(3)],
      'dsh-whale-chan:task:task-1',
    )
    // The message was recorded inside turn 2; the turn 3 end is somebody else's turn.
    expect(tracker.settled).toBe(false)
    expect(tracker.observe(end(2))).toBe(true)
    expect(tracker.settled).toBe(true)
    expect(tracker.outcome()).toEqual({ status: 'completed' })
  })

  it('ignores a turn end that arrives before the delivery was claimed', () => {
    const tracker = new TurnTracker([start(1), end(1)], 'dsh-whale-chan:task:task-1')
    expect(tracker.observe(end(2))).toBe(false)
    expect(tracker.observe(start(2))).toBe(false)
    expect(tracker.observe(userMessage('dsh-whale-chan:task:task-1'))).toBe(false)
    expect(tracker.turn).toBe(2)
    expect(tracker.observe(end(2))).toBe(true)
  })

  it('settles a message that was queued before its turn started', () => {
    // T3: the inbox append records `user/message` before the driver opens the
    // turn, so a reused session's `current` is still the previous turn's number.
    const tracker = new TurnTracker([start(1), end(1)], 'dsh-whale-chan:task:task-1')
    expect(tracker.observe(userMessage('dsh-whale-chan:task:task-1'))).toBe(false)
    expect(tracker.observe(start(2))).toBe(false)
    expect(tracker.observe(end(2))).toBe(true)
    expect(tracker.turn).toBe(2)
    expect(tracker.outcome()).toEqual({ status: 'completed' })
  })

  it('does not settle on the end of the turn that was open when the message queued', () => {
    const tracker = new TurnTracker([start(1)], 'm')
    // The message is recorded between turns: it must not be claimed as turn 1.
    expect(tracker.observe(end(1))).toBe(false)
    expect(tracker.observe(userMessage('m'))).toBe(false)
    expect(tracker.observe(end(1))).toBe(false)
    expect(tracker.settled).toBe(false)
    expect(tracker.observe(start(2))).toBe(false)
    expect(tracker.observe(end(2))).toBe(true)
  })

  it('settles when the whole exchange is already in the log', () => {
    const tracker = new TurnTracker([start(1), end(1), userMessage('m'), start(2), end(2)], 'm')
    expect(tracker.settled).toBe(true)
    expect(tracker.turn).toBe(2)
    expect(tracker.outcome()).toEqual({ status: 'completed' })
  })

  it('ignores a user message with another id', () => {
    const tracker = new TurnTracker([start(1), end(1)], 'm')
    expect(tracker.observe(userMessage('other'))).toBe(false)
    expect(tracker.observe(start(2))).toBe(false)
    expect(tracker.observe(end(2))).toBe(false)
    expect(tracker.settled).toBe(false)
  })

  it('claims the delivery whose log id carries the delivery prefix', () => {
    // The message id in the log is `dsh-whale-chan:<requestId>`; a tracker opened
    // with the bare id would never match and would wait out the timeout.
    const raw = 'whale-reply-abc123:1700000000000:1'
    const tracker = new TurnTracker([], deliveryId(raw))
    expect(tracker.observe({ type: 'user/message', data: { id: deliveryId(raw) } })).toBe(false)
    expect(tracker.observe({ type: 'turn/start', data: { turn: 1 } })).toBe(false)
    expect(tracker.observe({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })).toBe(true)
    expect(tracker.turn).toBe(1)
  })

  it('does not claim a message whose log id has no delivery prefix', () => {
    const raw = 'whale-reply-abc123:1700000000000:1'
    const tracker = new TurnTracker([], deliveryId(raw))
    tracker.observe({ type: 'user/message', data: { id: raw } })
    tracker.observe({ type: 'turn/start', data: { turn: 1 } })
    expect(tracker.observe({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })).toBe(false)
    expect(tracker.settled).toBe(false)
  })

  it('is settled when the history already ends the turn', () => {
    const tracker = new TurnTracker(
      [start(1), userMessage('dsh-whale-chan:task:task-1'), end(1)],
      'dsh-whale-chan:task:task-1',
    )
    expect(tracker.settled).toBe(true)
    expect(tracker.outcome()).toEqual({ status: 'completed' })
  })

  it('reports an aborted turn as a failure with its cancellation cause', () => {
    const tracker = new TurnTracker([start(1), userMessage('id'), end(1, 'aborted', 'hook')], 'id')
    expect(tracker.outcome()).toEqual({ status: 'failed', detail: 'aborted by hook' })
  })

  it('reports a failed turn as a failure with its reason kind', () => {
    const tracker = new TurnTracker([start(1), userMessage('id'), end(1, 'failed')], 'id')
    expect(tracker.outcome()).toEqual({ status: 'failed', detail: 'failed' })
  })

  it('waits for the next observed turn end when no request id is given', () => {
    const tracker = new TurnTracker([start(1), end(1)])
    expect(tracker.settled).toBe(false)
    expect(tracker.observe(end(2))).toBe(true)
  })
})

describe('awaitTurn', () => {
  it('resolves on the live turn end that belongs to the delivery', async () => {
    const log = new FakeEventLog()
    log.events.push(start(1))
    const waiting = awaitTurn({
      history: log.history(),
      subscribe: log.subscribe,
      requestId: 'msg-1',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    log.push(start(1))
    log.push(userMessage('other'))
    log.push(start(1))
    log.push(userMessage('msg-1'))
    log.push(end(1))
    expect(await waiting).toEqual({ status: 'completed' })
  })

  it('returns immediately when the turn already ended before the subscription', async () => {
    const log = new FakeEventLog()
    log.events.push(start(1), userMessage('msg-1'), end(1))
    const outcome = await awaitTurn({
      history: log.history(),
      subscribe: log.subscribe,
      requestId: 'msg-1',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ status: 'completed' })
    expect(log.unsubscribed).toBe(1)
  })

  it('replays an event that arrived between subscribing and scanning the history', async () => {
    const log = new FakeEventLog()
    log.events.push(start(1), userMessage('msg-1'))
    log.onSubscribe = () => log.push(end(1))
    const outcome = await awaitTurn({
      history: log.history(),
      subscribe: log.subscribe,
      requestId: 'msg-1',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ status: 'completed' })
  })

  it('reports a timeout when the turn never ends', async () => {
    const log = new FakeEventLog()
    log.events.push(start(1), userMessage('msg-1'))
    const outcome = await awaitTurn({
      history: log.history(),
      subscribe: log.subscribe,
      requestId: 'msg-1',
      timeoutMs: 20,
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ status: 'timeout' })
    expect(log.unsubscribed).toBe(1)
  })

  it('reports an abort and unsubscribes', async () => {
    const log = new FakeEventLog()
    log.events.push(start(1), userMessage('msg-1'))
    const controller = new AbortController()
    const waiting = awaitTurn({
      history: log.history(),
      subscribe: log.subscribe,
      requestId: 'msg-1',
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    controller.abort()
    expect(await waiting).toEqual({ status: 'aborted' })
    expect(log.unsubscribed).toBe(1)
  })

  it('does not subscribe when the signal is already aborted', async () => {
    const log = new FakeEventLog()
    const controller = new AbortController()
    controller.abort()
    const outcome = await awaitTurn({
      history: [],
      subscribe: log.subscribe,
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    expect(outcome).toEqual({ status: 'aborted' })
    expect(log.unsubscribed).toBe(0)
  })

  it('ignores unrelated event types', async () => {
    const log = new FakeEventLog()
    log.events.push(start(1), userMessage('msg-1'))
    const waiting = awaitTurn({
      history: log.history(),
      subscribe: log.subscribe,
      requestId: 'msg-1',
      timeoutMs: 20,
      signal: new AbortController().signal,
    })
    log.push({ type: 'assistant/message', data: { turn: 1, step: 1 } })
    log.push({ type: 'tool/call', data: { turn: 1, step: 1 } })
    expect(await waiting).toEqual({ status: 'timeout' })
  })
})

class FakeWorkspaceRecord implements WorkspaceTitleRecord {
  readonly retitles: string[] = []
  title: string

  constructor(title: string) {
    this.title = title
  }

  async setTitle(title: string): Promise<void> {
    this.retitles.push(title)
    this.title = title
  }
}

/** A registry whose single record is reused, as `workspaceRegistry.create` does by canonical path. */
function fakeRegistry(existing?: FakeWorkspaceRecord): {
  calls: Array<{ path: string; title: string | undefined }>
  record: FakeWorkspaceRecord
  create(path: string, title?: string): Promise<FakeWorkspaceRecord>
} {
  const record = existing ?? new FakeWorkspaceRecord('')
  const calls: Array<{ path: string; title: string | undefined }> = []
  return {
    calls,
    record,
    async create(path: string, title?: string): Promise<FakeWorkspaceRecord> {
      calls.push({ path, title })
      return record
    },
  }
}

describe('ensureWorkspace', () => {
  it('keeps an existing conversation title when a task joins without its own title', async () => {
    const record = new FakeWorkspaceRecord('钉钉 · AI工程师孵化中心')
    const registry = fakeRegistry(record)
    const workspace = await ensureWorkspace(
      registry,
      '/state/workspaces/conversation-0d7a92c2f345eead',
      '任务 · 在测试工作区创建 ws-check.txt',
    )
    // `create` only names a new record; it must not be followed by a rewrite.
    expect(registry.calls).toEqual([
      { path: '/state/workspaces/conversation-0d7a92c2f345eead', title: '任务 · 在测试工作区创建 ws-check.txt' },
    ])
    expect(workspace.title).toBe('钉钉 · AI工程师孵化中心')
    expect(record.retitles).toEqual([])
  })

  it('rewrites the title only when an explicit workspace title is supplied', async () => {
    const record = new FakeWorkspaceRecord('旧标题')
    const registry = fakeRegistry(record)
    const workspace = await ensureWorkspace(registry, '/state/workspaces/conversation-a', '任务 · x', '钉钉 · 新标题')
    expect(workspace.title).toBe('钉钉 · 新标题')
    expect(record.retitles).toEqual(['钉钉 · 新标题'])
  })

  it('does not rewrite an already matching explicit title', async () => {
    const record = new FakeWorkspaceRecord('钉钉 · 新标题')
    const registry = fakeRegistry(record)
    await ensureWorkspace(registry, '/state/workspaces/conversation-a', '任务 · x', '钉钉 · 新标题')
    expect(record.retitles).toEqual([])
  })

  it('lets the session title name a brand-new record when no workspace title is given', async () => {
    const registry = fakeRegistry()
    registry.record.title = '任务 · x'
    const workspace = await ensureWorkspace(registry, '/state/workspaces/tasks/task-1', '任务 · x')
    expect(workspace.title).toBe('任务 · x')
    expect(registry.record.retitles).toEqual([])
  })
})
