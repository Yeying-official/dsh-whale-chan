/**
 * DSH implementation of `SessionHost`.
 *
 * Everything this module touches was verified against the installed
 * `@deepseek-ai/*` type declarations and the live host services, not guessed:
 *
 * - `ctx.sessionController.resolveAgent(id)` → `{ agent }` | `{ error }`, and
 *   `create({ sessionId, workspaceId, agentPreset })` → `{ sessionId }`, where
 *   the returned id may differ from the requested one when the named session
 *   cannot be reused; `rename({ sessionId, title })`.
 * - `ctx.workspaceRegistry.create(path, title?)` → `{ id }`; it rejects a path
 *   that is not an existing directory, so the host creates it first.
 * - `ctx.permissionPresets.set(session, name)` (synchronous, throws on an
 *   unknown preset).
 * - `agent.ctx.systemPrompt.section({ name, order, text, interpolate })`.
 * - `agent.followup(message)` / `agent.steer(message)` and `agent.cancel(cause,
 *   { keepInbox })`.
 * - `ctx.on('session/event', (session, event) => …)` with the durable
 *   `turn/start`, `turn/end`, `user/message` and `assistant/message` events.
 *
 * Delivery is idempotent without a side ledger: the message id is derived from
 * the request id, and a message already in the session log or in the agent's
 * inbox is not delivered again. The session log is the only authority, so a
 * restart cannot duplicate a message either.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdir } from 'node:fs/promises'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A message this plugin delivered into a session: a task assignment for a
     * worker, or one assembled model prompt for the replier. `form` is left
     * undeclared because the two uses carry no single DSH context form.
     */
    'dsh-whale-chan': { kind: 'dsh-whale-chan' }
  }
}

import { ExecutorError } from './errors.ts'
import { roleModelDeps, routeSelection, seedRoleModel } from './role-model.ts'
import {
  DELIVERY_SOURCE,
  deliveryId,
  type AwaitTurnOptions,
  type DeliverOptions,
  type EnsureSessionOptions,
  type ExecutorLogger,
  type FinalText,
  type SessionHost,
  type SessionRef,
  type TurnEndOutcome,
} from './types.ts'

/**
 * The subset of a durable session event the turn matcher reads.
 *
 * It is declared structurally so the matcher can be tested with plain objects,
 * and so it keeps working when DSH adds fields to those events.
 */
export interface TrackedSessionEvent {
  readonly type: string
  readonly data: unknown
}

function turnOf(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const turn = (data as { turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

function messageIdOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const id = (data as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/** Highest turn that already ended in `history`, or 0 when none did. */
function highestEndedTurn(history: readonly TrackedSessionEvent[]): number {
  let highest = 0
  for (const event of history) {
    if (event.type !== 'turn/end') continue
    const turn = turnOf(event.data)
    if (turn !== undefined && turn > highest) highest = turn
  }
  return highest
}

/** The `kind` of a `turn/end` reason, and the cancellation cause when there is one. */
function reasonOf(data: unknown): { kind: string; detail?: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const reason = (data as { reason?: unknown }).reason
  if (typeof reason !== 'object' || reason === null) return undefined
  const kind = (reason as { kind?: unknown }).kind
  if (typeof kind !== 'string') return undefined
  if (kind !== 'aborted') return { kind }
  const cause = (reason as { reason?: unknown }).reason
  const causeKind =
    typeof cause === 'object' && cause !== null && typeof (cause as { kind?: unknown }).kind === 'string'
      ? String((cause as { kind: string }).kind)
      : undefined
  return causeKind === undefined ? { kind } : { kind, detail: `aborted by ${causeKind}` }
}

/**
 * Matches one delivery's turn boundary in a session log.
 *
 * The delivery's own `user/message` event identifies its turn; the tracker is
 * satisfied by the `turn/end` of exactly that turn. DSH records the inbox
 * append *before* the driver opens the turn, so a message that arrives outside
 * a turn is held as `pending` and claimed by the next `turn/start` instead of
 * inheriting a stale `current`. Without a request id it is
 * satisfied by the first turn that ends after the ones already in the log at
 * construction, which is what a steering delivery into an already-running turn
 * needs.
 *
 * Constructing it over the existing log is how "the turn already ended before
 * we subscribed" is answered without a race: the live subscription is opened
 * before this scan, and any event that arrives during the scan is replayed into
 * it afterwards (see `awaitTurn`).
 */
export class TurnTracker {
  private readonly requestId: string | undefined
  /** The turn currently open between `turn/start` and its `turn/end`. */
  private current: number | undefined
  /** A matched message that queued before any turn opened; the next turn owns it. */
  private pending = false
  private claimed: number | undefined
  /** Highest turn already ended when this tracker was created. */
  private readonly baseline: number
  private endedBy: { kind: string; detail?: string } | undefined

  constructor(history: readonly TrackedSessionEvent[], requestId?: string) {
    this.requestId = requestId
    this.baseline = highestEndedTurn(history)
    for (const event of history) this.observe(event)
  }

  /** Whether the tracked turn already ended. */
  get settled(): boolean {
    return this.endedBy !== undefined
  }

  /** The reason kind of the ending `turn/end`, once settled. */
  get reason(): string | undefined {
    return this.endedBy?.kind
  }

  /** Human-readable detail of the ending reason, when DSH reported one. */
  get detail(): string | undefined {
    return this.endedBy?.detail
  }

  /** The turn this delivery entered, once its message was claimed. */
  get turn(): number | undefined {
    return this.claimed
  }

  /** The outcome a settled tracker reports: success only for a `completed` turn. */
  outcome(): TurnEndOutcome {
    const kind = this.endedBy?.kind
    const detail = this.endedBy?.detail
    if (kind === undefined) return { status: 'failed', ...(detail === undefined ? {} : { detail }) }
    if (kind === 'completed') return { status: 'completed' }
    return { status: 'failed', detail: detail ?? kind }
  }

  /** Feed one event; returns true when the tracked turn ended. */
  observe(event: TrackedSessionEvent): boolean {
    switch (event.type) {
      case 'turn/start': {
        const turn = turnOf(event.data)
        if (turn === undefined) return false
        this.current = turn
        // A message that queued before any turn opened belongs to this one.
        if (this.pending && this.claimed === undefined) {
          this.claimed = turn
          this.pending = false
        }
        return false
      }
      case 'user/message': {
        if (this.requestId === undefined || messageIdOf(event.data) !== this.requestId) return false
        // A live session records the inbox append before the driver opens the
        // turn, so `current` may still be the previous turn's number (or none).
        // Claiming it would wait for a `turn/end` that can never match, so only
        // an open turn may be claimed here; otherwise the next `turn/start` does.
        if (this.current === undefined) this.pending = true
        else {
          this.claimed = this.current
          this.pending = false
        }
        return false
      }
      case 'turn/end': {
        const turn = turnOf(event.data)
        if (turn === undefined) return false
        if (this.current === turn) this.current = undefined
        // Without a request id the boundary is the first turn that ends after
        // the ones already in the log at construction.
        const matched =
          this.requestId === undefined ? turn > this.baseline : this.claimed !== undefined && this.claimed === turn
        if (!matched) return false
        this.endedBy = reasonOf(event.data) ?? { kind: 'completed' }
        return true
      }
      default:
        return false
    }
  }
}

/** Where the awaited turn's events come from. */
export interface AwaitTurnInput {
  /** Durable events already in the session log, oldest first. */
  readonly history: readonly TrackedSessionEvent[]
  /** Open the live subscription for the same session; returns the unsubscribe. */
  readonly subscribe: (listener: (event: TrackedSessionEvent) => void) => () => void
  readonly requestId?: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/**
 * Wait for one turn boundary.
 *
 * The subscription is opened before the history is scanned, and events that
 * arrive during the scan are replayed afterwards, so a turn cannot end in the
 * gap between the two. A turn that already ended settles immediately. An
 * aborted signal settles as `aborted`; an expired budget settles as `timeout`.
 * Nothing here throws, and the timer is unref'd so a pending wait never keeps
 * the process alive.
 */
export async function awaitTurn(input: AwaitTurnInput): Promise<TurnEndOutcome> {
  if (input.signal.aborted) return { status: 'aborted' }

  return await new Promise<TurnEndOutcome>((resolve) => {
    let settled = false
    let tracker: TurnTracker | undefined
    const buffered: TrackedSessionEvent[] = []
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (outcome: TurnEndOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe?.()
      input.signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    const onAbort = (): void => finish({ status: 'aborted' })
    input.signal.addEventListener('abort', onAbort, { once: true })
    if (input.signal.aborted) {
      finish({ status: 'aborted' })
      return
    }

    unsubscribe = input.subscribe((event) => {
      if (tracker === undefined) {
        buffered.push(event)
        return
      }
      if (tracker.observe(event)) finish(tracker.outcome())
    })

    tracker = new TurnTracker(input.history, input.requestId)
    if (tracker.settled) {
      finish(tracker.outcome())
      return
    }
    for (const event of buffered.splice(0)) {
      if (tracker.observe(event)) {
        finish(tracker.outcome())
        return
      }
    }

    if (Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
      timer = setTimeout(() => finish({ status: 'timeout' }), input.timeoutMs)
      timer.unref?.()
    }
  })
}

/** What `DshSessionHost` needs from the host that mounts it. */
export interface DshSessionHostOptions {
  readonly ctx: Context
  readonly logger?: ExecutorLogger
  /** Creates the workspace directory; replaced by tests, and never by callers. */
  readonly mkdir?: (path: string) => Promise<void>
}

/**
 * `SessionHost` over one Cordis context.
 *
 * The host keeps no cross-task session table: every method is addressed by the
 * caller's `SessionRef` and resolves the live agent by session id, so two
 * concurrent runs cannot touch each other's inboxes or turn boundaries.
 */
export class DshSessionHost implements SessionHost {
  private readonly ctx: Context
  private readonly logger: ExecutorLogger | undefined
  private readonly makeDirectory: (path: string) => Promise<void>
  private readonly prompted = new WeakSet<Agent>()
  private readonly watchers = new Set<AbortController>()
  private disposed = false

  constructor(options: DshSessionHostOptions) {
    this.ctx = options.ctx
    this.logger = options.logger
    this.makeDirectory =
      options.mkdir ??
      (async (path: string): Promise<void> => {
        await mkdir(path, { recursive: true })
      })
  }

  async ensureSession(options: EnsureSessionOptions): Promise<SessionRef> {
    if (this.disposed) throw new ExecutorError('disposed')
    options.signal.throwIfAborted()

    const requested = SessionId(options.sessionId)
    let agent = options.fresh === true ? undefined : await this.resolve(requested)
    if (agent === undefined) {
      await this.makeDirectory(options.workspace)
      options.signal.throwIfAborted()
      // `workspaceRegistry.create` rejects a path that is not an existing
      // directory, which is why the directory is made first. A conversation
      // workspace may already exist (its replier was created first), in which
      // case `create` returns that record unchanged and only a stale title is
      // rewritten.
      const workspaceTitle = options.workspaceTitle ?? options.title
      const workspace = await this.ctx.workspaceRegistry.create(options.workspace, workspaceTitle)
      if (workspace.title !== workspaceTitle) await workspace.setTitle(workspaceTitle)
      const created = await this.ctx.sessionController.create({
        sessionId: requested,
        workspaceId: workspace.id,
        agentPreset: options.preset,
      })
      agent = await this.resolve(SessionId(String(created.sessionId)))
      if (agent === undefined) throw new ExecutorError('sessionUnavailable', String(created.sessionId))
    }

    // A permission preset and the title are idempotent: re-applying them to a
    // session this plugin already prepared changes nothing.
    this.ctx.permissionPresets.set(agent.session, options.permission)
    await this.ctx.sessionController.rename({ sessionId: agent.id, title: options.title })
    if (options.systemPrompt !== undefined) this.adoptSystemPrompt(agent, options.systemPrompt)
    // Seed the role's configured route before the first turn. It is skipped for
    // a resumed session, so a person's later model choice always wins.
    if (options.model !== undefined) {
      await seedRoleModel(agent, routeSelection(options.model), roleModelDeps(this.ctx, agent, this.logger))
    }
    return { sessionId: String(agent.id), workspace: options.workspace }
  }

  async deliver(ref: SessionRef, options: DeliverOptions): Promise<void> {
    if (this.disposed) throw new ExecutorError('disposed')
    const agent = this.require(ref)
    const id = MessageId(deliveryId(options.requestId))
    if (this.holds(agent, id)) {
      this.logger?.debug?.(`dsh-whale-chan: message ${options.requestId} is already in session ${ref.sessionId}`)
      return
    }
    const message = freezeMessage({
      id,
      role: 'user' as const,
      content: [{ type: 'text' as const, text: options.text }],
      source: { kind: DELIVERY_SOURCE },
    })
    if (options.mode === 'steer') agent.steer(message)
    else agent.followup(message)
  }

  async awaitTurnEnd(ref: SessionRef, options: AwaitTurnOptions): Promise<TurnEndOutcome> {
    const agent = this.require(ref)
    const session = agent.session
    const watcher = new AbortController()
    this.watchers.add(watcher)
    try {
      const signal = AbortSignal.any([options.signal, watcher.signal])
      return await awaitTurn({
        history: session.snapshotEvents(),
        requestId: options.requestId,
        timeoutMs: options.timeoutMs,
        signal,
        subscribe: (listener) =>
          this.ctx.on('session/event', (eventSession, event) => {
            if (eventSession === session) listener(event)
          }),
      })
    } finally {
      this.watchers.delete(watcher)
    }
  }

  async readFinalText(ref: SessionRef): Promise<FinalText> {
    const agent = this.require(ref)
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined || event.type !== 'assistant/message') continue
      const text = event.data.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim()
      return { text, found: true }
    }
    // No assistant message is a fact, not an error: the caller reports it as an
    // empty summary instead of inventing one.
    return { text: '', found: false }
  }

  async cancel(ref: SessionRef, reason?: string): Promise<void> {
    const agent = this.ctx.agents.get(SessionId(ref.sessionId))
    if (agent === undefined) return
    // `keepInbox: false` clears queued and steering work as well, so a cancelled
    // task cannot restart itself from a message queued before the cancel.
    agent.cancel({ kind: 'hook', reason: reason ?? 'dsh-whale-chan cancelled the run' }, { keepInbox: false })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const watcher of this.watchers) watcher.abort()
    this.watchers.clear()
  }

  private async resolve(sessionId: SessionId): Promise<Agent | undefined> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('agent' in result) return result.agent
    return undefined
  }

  private require(ref: SessionRef): Agent {
    const agent = this.ctx.agents.get(SessionId(ref.sessionId))
    if (agent === undefined) throw new ExecutorError('sessionUnavailable', ref.sessionId)
    return agent
  }

  private holds(agent: Agent, id: MessageId): boolean {
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    if (pending.some((message) => message.id === id)) return true
    return agent.session.snapshotEvents().some((event) => event.type === 'user/message' && event.data.id === id)
  }

  /**
   * Register this plugin's system prompt section once per agent.
   *
   * It is not `complete`: the preset's persona and instruction sections stay in
   * place and this section is appended after them. `interpolate: false` keeps
   * any literal `{{…}}` an owner typed into the persona out of DSH's variable
   * substitution.
   */
  private adoptSystemPrompt(agent: Agent, text: string): void {
    if (this.prompted.has(agent)) return
    this.prompted.add(agent)
    agent.ctx.systemPrompt.section({ name: 'dsh-whale-chan-task', order: 900, interpolate: false, text })
  }
}
