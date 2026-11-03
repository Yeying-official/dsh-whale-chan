/**
 * `SessionModel`: the brain's `ModelPort` backed by one long-lived DSH session
 * per DingTalk conversation.
 *
 * A stateless API call would rebuild the whole conversation on every message.
 * Reusing a session instead lets the replier keep its own DSH history, tools
 * and system prompt, which is what makes short replies cheap and consistent.
 * The trade-off is bounded: one session serves at most `MAX_TURNS` turns or
 * `IDLE_RESET_MS` of inactivity, and is then rebuilt so a long-lived
 * conversation cannot grow without limit.
 *
 * What this module guarantees to the brain:
 *
 * - **One turn at a time per thread.** `complete` calls are serialized; a
 *   second call queues behind the first instead of interleaving prompts into
 *   the same session.
 * - **Bounded prompt.** System text plus messages are assembled into one user
 *   message under `MAX_PROMPT_CHARS`, dropping the oldest messages first.
 * - **Identifiable failures.** A timeout, a caller abort and a failed turn each
 *   raise their own error class carrying a brain-facing `reason`, so the caller
 *   maps them to `timeout`/`model_error` instead of re-deriving the cause.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { clip, codePointLength } from '../brain/format.ts'
import type { ModelMessage, ModelPort, ModelRequest } from '../brain/types.ts'
import type { ModelRoute } from '../shared/settings.ts'
import { ExecutorError, ModelAbortedError, ModelFailedError, ModelTimeoutError } from './errors.ts'
import {
  MODEL_TURN_TIMEOUT_MS,
  REPLIER_PRESET,
  replySessionId,
  type ExecutorLogger,
  type SessionHost,
  type SessionRef,
} from './types.ts'

/** Longest assembled prompt, in Unicode code points, sent as one user message. */
export const MAX_PROMPT_CHARS = 12_000

/**
 * Wall-clock budget of one replier turn.
 *
 * It is the shared single-turn ceiling (`MODEL_TURN_TIMEOUT_MS`): a local model
 * may take 15-30 seconds before its first token, so 90 seconds keeps a slow but
 * healthy turn from being reported as a timeout.
 */
export const REPLY_TIMEOUT_MS = MODEL_TURN_TIMEOUT_MS

/** Turns one session may serve before it is rebuilt. */
export const MAX_TURNS = 20

/** Inactivity after which a session is rebuilt. */
export const IDLE_RESET_MS = 30 * 60_000

/** Workspace every replier session runs in, relative to the state directory. */
export const REPLY_WORKSPACE = 'workspace'

/** Marker placed before the truncated conversation when old messages were dropped. */
export const DROPPED_MARKER = '〔较早的 {n} 条对话已省略〕'

/** One assembled prompt and what was cut from it. */
export interface PromptAssembly {
  readonly text: string
  /** How many of the oldest messages were dropped to fit the budget. */
  readonly dropped: number
  /** Whether any text was clipped, which happens only when the system text alone exceeds the budget. */
  readonly clipped: boolean
}

/**
 * Assemble one user message from a system text and a conversation.
 *
 * The system text is always kept (clipped only when it alone exceeds the
 * budget) because it carries the persona and the safety rules; the *messages*
 * are what get dropped, oldest first, and a marker records how many. The caller
 * sees the count so a test can assert the window rather than the exact string.
 */
export function assemblePrompt(
  system: string,
  messages: readonly ModelMessage[],
  maxChars = MAX_PROMPT_CHARS,
): PromptAssembly {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_PROMPT_CHARS
  const systemText = system.trim()
  const kept: string[] = []
  let dropped = 0

  const header = systemText.length === 0 ? '' : `## 系统指示\n${systemText}`
  const body = (lines: readonly string[]): string => {
    const marker = dropped === 0 ? '' : `${DROPPED_MARKER.replace('{n}', String(dropped))}\n\n`
    const conversation = lines.length === 0 ? '' : `${marker}## 对话\n${lines.join('\n\n')}`
    return [header, conversation].filter((part) => part.length > 0).join('\n\n')
  }

  // Keep the newest messages that fit after the system text.
  const rendered = messages.map(
    (message, index) => `【${message.role === 'user' ? '用户' : '助手'} ${index + 1}】\n${message.content.trim()}`,
  )
  const systemCost = codePointLength(header)
  let used = systemCost
  let clipped = false
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const block = rendered[index] ?? ''
    const cost = codePointLength(block) + 2 // the blank line between blocks
    if (used + cost > budget) {
      if (kept.length > 0) {
        dropped += 1
        continue
      }
      // A single message on its own is too large: clip it rather than dropping
      // everything, so the newest turn always reaches the model.
      const room = Math.max(0, budget - used - 2)
      const shortened = clip(block, room)
      if (shortened.length === 0) {
        dropped += 1
        continue
      }
      kept.unshift(shortened)
      used = budget
      clipped = true
      continue
    }
    kept.unshift(block)
    used += cost
  }

  let text = body(kept)
  if (codePointLength(text) > budget) {
    text = clip(text, budget)
    clipped = true
  }
  return { text, dropped, clipped }
}

/** One conversation's replier session and its reuse counters. */
interface ThreadState {
  readonly key: string
  title: string
  session: SessionRef | undefined
  turns: number
  lastUsedAt: number
  sequence: number
  disposed: boolean
  /** Tail of the per-thread mutex; every call chains onto it. */
  chain: Promise<unknown>
}

/** Everything `SessionModel` needs from its composition root. */
export interface SessionModelOptions {
  readonly host: SessionHost
  readonly logger?: ExecutorLogger
  /** Conversation key `complete` serves; defaults to `'default'`. */
  readonly threadKey?: string
  /** Conversation title used in the DSH session title. */
  readonly title?: string
  /** State directory used for the shared replier workspace; defaults to `~/.dsh-whale-chan`. */
  readonly stateDir?: string
  /** Workspace override, when the composition root wants one shared directory. */
  readonly workspace?: string
  /** Route from `settings.models.reply`; an empty route uses the deployment default. */
  readonly model?: ModelRoute
  readonly homeDir?: string
  readonly timeoutMs?: number
  readonly maxTurns?: number
  readonly idleResetMs?: number
  readonly maxChars?: number
  /** Monotonic clock in milliseconds; replaced by tests. */
  readonly now?: () => number
}

/**
 * `ModelPort` over one DSH session per conversation.
 *
 * `complete` serves the default thread; `forThread` returns a port bound to one
 * conversation, which is what the app layer hands to the brain per message.
 * Both share the same session objects, so alternating between them cannot open
 * two sessions for one thread.
 */
export class SessionModel implements ModelPort {
  private readonly host: SessionHost
  private readonly logger: ExecutorLogger | undefined
  private readonly workspace: string
  private readonly timeoutMs: number
  private readonly maxTurns: number
  private readonly idleResetMs: number
  private readonly maxChars: number
  private readonly model: ModelRoute | undefined
  private readonly now: () => number
  private readonly threads = new Map<string, ThreadState>()
  private readonly defaultKey: string
  private readonly defaultTitle: string
  private disposed = false

  constructor(options: SessionModelOptions) {
    this.host = options.host
    this.logger = options.logger
    const home = options.homeDir ?? homedir()
    const stateDir = options.stateDir ?? '~/.dsh-whale-chan'
    this.workspace = options.workspace ?? join(expandStateDir(stateDir, home), REPLY_WORKSPACE)
    this.timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS
    this.maxTurns = options.maxTurns ?? MAX_TURNS
    this.idleResetMs = options.idleResetMs ?? IDLE_RESET_MS
    this.maxChars = options.maxChars ?? MAX_PROMPT_CHARS
    this.model = options.model
    this.now = options.now ?? (() => Date.now())
    this.defaultKey = options.threadKey ?? 'default'
    this.defaultTitle = options.title ?? this.defaultKey
  }

  /** A port bound to one conversation, sharing this model's sessions and mutex. */
  forThread(threadKey: string, title?: string): ModelPort {
    return {
      complete: async (request, signal) => await this.completeFor(threadKey, title ?? threadKey, request, signal),
    }
  }

  /** Serve the default thread. */
  async complete(request: ModelRequest, signal: AbortSignal): Promise<string> {
    return await this.completeFor(this.defaultKey, this.defaultTitle, request, signal)
  }

  /** Rebuild every session on its next use and drop the cached state. */
  async dispose(): Promise<void> {
    this.disposed = true
    const states = [...this.threads.values()]
    this.threads.clear()
    for (const state of states) {
      state.disposed = true
      if (state.session === undefined) continue
      try {
        await this.host.cancel(state.session, 'replier session disposed')
      } catch (error) {
        this.logger?.warn?.(`dsh-whale-chan: disposing replier session failed: ${describe(error)}`)
      }
    }
  }

  private async completeFor(
    threadKey: string,
    title: string,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.disposed) throw new ExecutorError('disposed')
    if (signal.aborted) throw new ModelAbortedError('the model call was aborted before it started')
    const state = this.thread(threadKey, title)
    return await this.serialize(state, async () => await this.runTurn(state, request, signal))
  }

  /** Chain one call behind the previous one for the same thread. */
  private async serialize<T>(state: ThreadState, work: () => Promise<T>): Promise<T> {
    const previous = state.chain
    const current = previous.then(work, work)
    state.chain = current.then(
      () => undefined,
      () => undefined,
    )
    return await current
  }

  private thread(threadKey: string, title: string): ThreadState {
    const existing = this.threads.get(threadKey)
    if (existing !== undefined) {
      existing.title = title
      return existing
    }
    const created: ThreadState = {
      key: threadKey,
      title,
      session: undefined,
      turns: 0,
      lastUsedAt: this.now(),
      sequence: 0,
      disposed: false,
      chain: Promise.resolve(),
    }
    this.threads.set(threadKey, created)
    return created
  }

  private async runTurn(state: ThreadState, request: ModelRequest, signal: AbortSignal): Promise<string> {
    if (state.disposed) throw new ExecutorError('disposed')
    if (signal.aborted) throw new ModelAbortedError('the model call was aborted before its turn')
    const session = await this.sessionFor(state, signal)
    const prompt = assemblePrompt(request.system, request.messages, this.maxChars)
    const requestId = `${replySessionId(threadDigest(state.key))}:${this.now()}:${state.sequence}`
    state.sequence += 1

    await this.host.deliver(session, { requestId, text: prompt.text })
    const end = await this.host.awaitTurnEnd(session, { requestId, timeoutMs: this.timeoutMs, signal })
    if (end.status === 'timeout') throw new ModelTimeoutError(`replier turn exceeded ${this.timeoutMs}ms`)
    if (end.status === 'aborted') throw new ModelAbortedError('the replier turn was aborted')
    if (end.status === 'failed') throw new ModelFailedError(end.detail ?? 'the replier turn failed')

    const final = await this.host.readFinalText(session)
    state.turns += 1
    state.lastUsedAt = this.now()
    if (!final.found) {
      this.logger?.warn?.(`dsh-whale-chan: replier session ${session.sessionId} produced no assistant message`)
    }
    return final.text
  }

  /** Return the reusable session, or rebuild it once it is stale. */
  private async sessionFor(state: ThreadState, signal: AbortSignal): Promise<SessionRef> {
    const stale = state.session !== undefined && this.isStale(state)
    if (state.session !== undefined && !stale) return state.session
    if (state.session !== undefined) {
      // Close the old conversation before rebuilding: an aborted turn would
      // otherwise keep running while the next prompt goes to a new session.
      await this.host.cancel(state.session, 'replier session rotated')
      state.session = undefined
    }
    const session = await this.host.ensureSession({
      sessionId: replySessionId(threadDigest(state.key)),
      workspace: this.workspace,
      title: `钉钉 · ${state.title}`,
      preset: REPLIER_PRESET,
      permission: 'workspace-write',
      ...(this.model === undefined ? {} : { model: this.model }),
      // A rebuild must not resume the conversation that just went stale.
      fresh: state.turns > 0,
      signal,
    })
    state.session = session
    state.turns = 0
    state.lastUsedAt = this.now()
    return session
  }

  private isStale(state: ThreadState): boolean {
    if (state.turns >= this.maxTurns) return true
    if (this.idleResetMs > 0 && this.now() - state.lastUsedAt >= this.idleResetMs) return true
    return false
  }
}

function expandStateDir(path: string, home: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return trimmed
}

/** Short stable id of a conversation, used in the DSH session id. */
export function threadDigest(threadKey: string): string {
  return createHash('sha1').update(threadKey, 'utf8').digest('hex').slice(0, 12)
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300)
  return String(error).slice(0, 300)
}
