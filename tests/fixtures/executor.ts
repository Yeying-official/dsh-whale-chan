/**
 * Test doubles for the executor layer.
 *
 * `FakeSessionHost` mirrors the contract of `DshSessionHost` — including
 * idempotent delivery and abort-aware turn waits — so a test verifies the
 * executor and the model, not the fake. The real DSH adapter is verified by
 * `tsc` against the shipped `@deepseek-ai/*` declarations plus the service
 * signatures recorded in `docs/test-reports/WS4.md`.
 */
import type { Approval, Task } from '../../src/core/model.ts'
import { SettingsSchema, type Settings } from '../../src/shared/settings.ts'
import type {
  AwaitTurnOptions,
  DeliverOptions,
  EnsureSessionOptions,
  ExecutorLogger,
  FinalText,
  SessionHost,
  SessionRef,
  TurnEndOutcome,
} from '../../src/executor/index.ts'
import type { WebSearchLike, WebSearchResultLike } from '../../src/executor/research.ts'

/** A promise with its resolver exposed, so a test can open a gate explicitly. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn
    reject = rejectFn
  })
  return { promise, resolve, reject }
}

/** One recorded delivery, with the session it went to. */
export interface DeliverRecord extends DeliverOptions {
  readonly sessionId: string
}

/** Scripted DSH host. */
export class FakeSessionHost implements SessionHost {
  readonly ensured: EnsureSessionOptions[] = []
  readonly deliveries: DeliverRecord[] = []
  readonly awaited: Array<{ sessionId: string; options: AwaitTurnOptions }> = []
  readonly cancellations: Array<{ sessionId: string; reason: string | undefined }> = []
  disposeCalls = 0

  /** Answer of the next turn waits; replaced per test. */
  turnOutcome: TurnEndOutcome = { status: 'completed' }
  /** Text `readFinalText` reports. */
  finalText: FinalText = { text: '已完成，改了 a.txt。', found: true }
  /** When set, `ensureSession` throws it. */
  ensureError: Error | undefined
  /** When set, `deliver` throws it. */
  deliverError: Error | undefined
  /** When set, `cancel` throws it. */
  cancelError: Error | undefined
  /** A `fresh` rebuild reports this id instead of the requested one, as DSH may. */
  rebuiltSessionId: string | undefined

  private readonly seen = new Map<string, Set<string>>()
  private held = false
  private readonly waiters: Array<(outcome: TurnEndOutcome) => void> = []
  private readonly turnCountWaiters: Array<{ count: number; resolve: () => void }> = []
  private entered: (() => void) | undefined
  private readonly enteredPromise: Promise<void>

  constructor() {
    this.enteredPromise = new Promise<void>((resolve) => {
      this.entered = resolve
    })
  }

  /** Resolves the first time `awaitTurnEnd` is called. */
  waitForTurnEntry(): Promise<void> {
    return this.enteredPromise
  }

  /** Resolves once `awaitTurnEnd` was called at least `count` times. */
  waitForTurns(count: number): Promise<void> {
    if (this.awaited.length >= count) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.turnCountWaiters.push({ count, resolve })
    })
  }

  /** Keep every later turn wait open until `releaseTurn()`. */
  holdTurns(): void {
    this.held = true
  }

  /** Resolve every open turn wait with `outcome`. */
  releaseTurn(outcome: TurnEndOutcome = this.turnOutcome): void {
    for (const waiter of this.waiters.splice(0)) waiter(outcome)
  }

  async ensureSession(options: EnsureSessionOptions): Promise<SessionRef> {
    this.ensured.push(options)
    if (this.ensureError !== undefined) throw this.ensureError
    const sessionId =
      options.fresh === true && this.rebuiltSessionId !== undefined ? this.rebuiltSessionId : options.sessionId
    return { sessionId, workspace: options.workspace }
  }

  async deliver(ref: SessionRef, options: DeliverOptions): Promise<void> {
    if (this.deliverError !== undefined) throw this.deliverError
    const key = `${ref.sessionId}\u0000${options.requestId}`
    const perSession = this.seen.get(ref.sessionId) ?? new Set<string>()
    this.seen.set(ref.sessionId, perSession)
    if (perSession.has(options.requestId)) return
    perSession.add(options.requestId)
    this.deliveries.push({ ...options, sessionId: ref.sessionId })
    void key
  }

  async awaitTurnEnd(ref: SessionRef, options: AwaitTurnOptions): Promise<TurnEndOutcome> {
    this.awaited.push({ sessionId: ref.sessionId, options })
    this.entered?.()
    this.entered = undefined
    for (const waiter of this.turnCountWaiters.splice(0)) {
      if (this.awaited.length >= waiter.count) waiter.resolve()
      else this.turnCountWaiters.push(waiter)
    }
    if (options.signal.aborted) return { status: 'aborted' }
    if (!this.held) return { ...this.turnOutcome }
    return await new Promise<TurnEndOutcome>((resolve) => {
      const onAbort = (): void => {
        options.signal.removeEventListener('abort', onAbort)
        resolve({ status: 'aborted' })
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push((outcome) => {
        options.signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      })
    })
  }

  async readFinalText(): Promise<FinalText> {
    return { ...this.finalText }
  }

  async cancel(ref: SessionRef, reason?: string): Promise<void> {
    this.cancellations.push({ sessionId: ref.sessionId, reason })
    if (this.cancelError !== undefined) throw this.cancelError
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1
  }

  /** Requests delivered to one session, in order. */
  requestIds(): string[] {
    return this.deliveries.map((delivery) => delivery.requestId)
  }
}

/** Scripted `ctx.web`. */
export class FakeWeb implements WebSearchLike {
  readonly requests: Array<{ query: string; maxResults?: number }> = []
  result: WebSearchResultLike = { sources: [] }
  error: Error | undefined
  /** When true the call never settles on its own and must be aborted. */
  hang = false

  async search(
    request: { readonly query: string; readonly maxResults?: number },
    signal?: AbortSignal,
  ): Promise<WebSearchResultLike> {
    this.requests.push({ query: request.query, maxResults: request.maxResults })
    if (this.hang) {
      return await new Promise<WebSearchResultLike>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (this.error !== undefined) throw this.error
    return this.result
  }
}

/** A logger that keeps every line, so a test can assert nothing was logged. */
export class RecordingLogger implements ExecutorLogger {
  readonly lines: string[] = []
  debug(message: string): void {
    this.lines.push(`debug: ${message}`)
  }
  info(message: string): void {
    this.lines.push(`info: ${message}`)
  }
  warn(message: string): void {
    this.lines.push(`warn: ${message}`)
  }
  error(message: string): void {
    this.lines.push(`error: ${message}`)
  }
}

/** Complete default settings, optionally overridden per block. */
export function makeSettings(overrides: Record<string, Record<string, unknown>> = {}): Settings {
  return SettingsSchema.parse(overrides)
}

const ISO = '2026-11-03T01:00:00.000Z'

/** One captured task in the state a test needs. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    threadKey: 'dm:u1',
    requester: { userId: 'u1', nick: '小明' },
    messageId: 'msg-1',
    title: '整理会议纪要',
    brief: '把今天的会议录音整理成三点纪要。',
    requirements: ['三点以内', '用中文'],
    status: 'approved',
    approvalId: 'approval-1',
    assignmentId: 'assignment-1',
    result: null,
    reason: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

/** The approval that authorizes `task`. */
export function makeApproval(task: Task, overrides: Partial<Approval> = {}): Approval {
  return {
    id: task.approvalId ?? 'approval-1',
    taskId: task.id,
    status: 'approved',
    requestedAt: ISO,
    expiresAt: '2026-11-04T01:00:00.000Z',
    decidedAt: ISO,
    decidedBy: 'owner',
    note: null,
    ...overrides,
  }
}
