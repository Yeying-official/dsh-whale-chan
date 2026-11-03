/**
 * Reply-path effects: classify one message, optionally research it, compose a
 * draft and deliver it.
 *
 * Every handler is re-entrant: it re-reads the domain row and returns quietly
 * when another attempt already advanced it. That is what makes the queue safe
 * to retry after a crash and why an effect is enqueued only after the command
 * that created its input committed.
 *
 * No handler ever sends a message itself. `send` is the only delivery path, and
 * it maps the channel result onto the domain one-to-one:
 *
 * - `sent`    → `replySent` / `outboundSent`, then one rate-counter hit;
 * - `unknown` → `replyUnknown` / `outboundUnknown` and a notice. Never resent;
 * - `failed`  → `replyFailed` / `outboundFailed` and a notice;
 * - `skipped` → nothing at all (dry run leaves the outbox row pending);
 * - `gone`    → recorded as a failure, because the conversation no longer exists.
 */
import type { Clock, Decision, Outbound, OutboundTarget } from '../core/index.ts'
import { UserError } from '../core/index.ts'
import {
  HOUR_MS,
  composeReply,
  gateReply,
  isEcho,
  research as runResearch,
  ResearchCache,
  type ClassifySuccess,
  type GateCounters,
  type ModelPort,
  type ResearchResult,
  type ThreadWindow,
} from '../brain/index.ts'
import { classify } from '../brain/index.ts'
import type { Effects } from './effects.ts'
import type { KvCounterStore } from './counters.ts'
import { counterKey, readGateCounters } from './counters.ts'
import type { BrainModelFactory } from './brain-ports.ts'
import type { ChannelRuntime } from './channel-runtime.ts'
import type { SettingsService } from './settings.ts'
import type { Store } from './store.ts'
import {
  consecutiveAiReplies,
  recentOutboundTexts,
  threadTarget,
  threadWindow,
  toBrainMessage,
} from './thread-state.ts'
import type { Engine } from '../core/index.ts'
import type { ResearchPort } from '../brain/index.ts'
import type { PromptSource } from '../brain/index.ts'

/** Payload every decision-scoped effect carries. */
interface DecisionPayload {
  readonly decisionId: string
}

/** Payload the research handler hands to compose. */
interface ComposePayload extends DecisionPayload {
  readonly research?: ResearchResult
}

/** Payload the compose handler hands to the outbox. */
interface SendPayload {
  readonly outboundId: string
  readonly decisionId?: string
  readonly threadKey?: string
}

/** Payload of a v1 notice; ids only, never message text. */
export interface NoticePayload {
  readonly kind: string
  readonly threadKey?: string
  readonly decisionId?: string
  readonly outboundId?: string
  readonly taskId?: string
  readonly reason?: string
}

export interface ChatEffectDeps {
  readonly engine: Engine
  readonly store: Store
  readonly settings: SettingsService
  readonly effects: Effects
  readonly clock: Clock
  readonly counters: KvCounterStore
  readonly model: BrainModelFactory
  readonly research: ResearchPort
  readonly prompts: PromptSource
  readonly ownerUserId: () => string
  readonly channel: () => ChannelRuntime | undefined
  readonly channelRunning: () => boolean
  readonly lifetime: AbortSignal
  /** Mint an id such as `outbound-…`; supplied by the composition root. */
  readonly ids: { next(prefix: string): string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function decisionPayload(payload: unknown, key: string): string {
  return readString(payload, 'decisionId') ?? key
}

function isResearchResult(value: unknown): value is ResearchResult {
  if (!isRecord(value)) return false
  return typeof value.query === 'string' && Array.isArray(value.facts) && Array.isArray(value.sources)
}

/** A degraded result for a disabled or failed lookup: facts and citations empty. */
function degraded(query: string, includeCitations: boolean, reason: ResearchResult['reason']): ResearchResult {
  return {
    query,
    facts: [],
    sources: [],
    degraded: true,
    cached: false,
    includeCitations,
    ...(reason ? { reason } : {}),
  }
}

/** Map the channel's normalized thread key from an outbound target. */
export function threadKeyOf(target: OutboundTarget): string {
  if (target.kind === 'dm') return `dm:${target.peerUserId ?? target.conversationId}`
  return `group:${target.conversationId}`
}

/** The decision a reply outbound belongs to, when there is one. */
export function decisionForOutbound(store: Store, outboundId: string): Decision | undefined {
  const row = store.db.prepare('SELECT id FROM decisions WHERE outbound_id = ?').get(outboundId) as
    | Record<string, unknown>
    | undefined
  if (row === undefined) return undefined
  return store.decisions.get(String(row['id']))
}

/** Ignore a domain refusal that only means another attempt already advanced the row. */
function ignoreRefusal(error: unknown): void {
  if (!(error instanceof UserError)) throw error
}

/** Copy the persisted classification into the shape `composeReply` expects. */
function classificationOf(decision: Decision, researched: boolean): ClassifySuccess {
  return {
    ok: true,
    intent: decision.intent === 'question' ? 'question' : 'chat',
    confidence: decision.confidence ?? 1,
    reason: decision.reason ?? '',
    needSearch: decision.intent === 'question' && researched,
    task: null,
  }
}

/** Register every reply-path handler on the shared queue. */
export class ChatEffects {
  private readonly cache = new ResearchCache(50)

  constructor(private readonly deps: ChatEffectDeps) {}

  register(): void {
    this.deps.effects.handle('classify', (payload, key) => this.classify(decisionPayload(payload, key)))
    this.deps.effects.handle('research', (payload, key) => this.research(decisionPayload(payload, key)))
    this.deps.effects.handle('compose', (payload, key) => this.compose(payload, decisionPayload(payload, key)))
    this.deps.effects.handle('send', (payload, key) => this.send(payload, key))
  }

  /** Classify one queued decision and enqueue its next step. */
  private async classify(decisionId: string): Promise<void> {
    const decision = this.deps.engine.decision(decisionId)
    if (!decision || decision.status !== 'queued') return
    const message = this.deps.store.messages.get(decision.messageId)
    const thread = this.deps.engine.thread(decision.threadKey)
    if (!message || !thread) {
      this.defer(decisionId, 'context_missing')
      return
    }
    const settings = this.deps.settings.current()
    // Do not spend a model call while the owner asked for silence.
    if (!settings.monitor.enabled) {
      this.defer(decisionId, 'monitor_disabled')
      return
    }
    if (settings.monitor.paused) {
      this.defer(decisionId, 'monitor_paused')
      return
    }

    const model = this.deps.model.forThread(thread.key, thread.title)
    const result = await classifyMessage({
      message: toBrainMessage(message),
      threadWindow: threadWindow(this.deps.store, thread.key, this.deps.ownerUserId()),
      settings: this.deps.settings,
      prompts: this.deps.prompts,
      model,
      threadTitle: thread.title,
      now: this.deps.clock.now(),
      signal: this.deps.lifetime,
    })
    if (!result.ok) {
      this.defer(decisionId, `classify:${result.reason}`)
      return
    }

    if (result.intent === 'task') {
      if (!settings.tasks.enabled) {
        this.defer(decisionId, 'tasks_disabled')
        return
      }
      const task = result.task
      if (task === null) {
        this.defer(decisionId, 'classify:invalid')
        return
      }
      const created = this.deps.engine.classify(decisionId, {
        intent: 'task',
        confidence: result.confidence,
        reason: result.reason,
        task: { title: task.title, brief: task.brief, requirements: task.requirements },
        approvalTtlMs: settings.tasks.approvalTtlHours * 3_600_000,
      })
      // v1 has no DSH inbox conversation; the audit trail is where a person sees it.
      this.notice({
        kind: 'task_captured',
        threadKey: decision.threadKey,
        decisionId,
        ...(created.taskId === null ? {} : { taskId: created.taskId }),
      })
      return
    }

    this.deps.engine.classify(decisionId, {
      intent: result.intent,
      confidence: result.confidence,
      reason: result.reason,
    })
    if (result.intent === 'chat') {
      this.deps.effects.enqueue('compose', decisionId, { decisionId })
    } else if (result.intent === 'question') {
      this.deps.effects.enqueue(result.needSearch ? 'research' : 'compose', decisionId, { decisionId })
    }
  }

  /** Bound one lookup by the owner's research budget; a failure degrades to no facts. */
  private async research(decisionId: string): Promise<void> {
    const decision = this.deps.engine.decision(decisionId)
    if (!decision || decision.status !== 'classified' || decision.intent !== 'question') return
    const message = this.deps.store.messages.get(decision.messageId)
    if (!message) {
      this.defer(decisionId, 'context_missing')
      return
    }
    const settings = this.deps.settings.current()
    const includeCitations = settings.research.includeCitations
    let result: ResearchResult
    if (!settings.research.enabled) {
      result = degraded(message.text, includeCitations, 'disabled')
    } else {
      try {
        result = await runResearch(message.text, settings.research, this.deps.research, this.deps.lifetime, {
          cache: this.cache,
          now: () => this.deps.clock.now().getTime(),
        })
      } catch {
        result = degraded(message.text, includeCitations, 'error')
      }
    }
    this.deps.effects.enqueue('compose', decisionId, { decisionId, research: result })
  }

  /** Apply the gate, then draft and (only for `auto`) queue a reply. */
  private async compose(payload: unknown, decisionId: string): Promise<void> {
    const decision = this.deps.engine.decision(decisionId)
    if (!decision || decision.status !== 'classified') return
    const message = this.deps.store.messages.get(decision.messageId)
    const thread = this.deps.engine.thread(decision.threadKey)
    if (!message || !thread) {
      this.defer(decisionId, 'context_missing')
      return
    }
    const settings = this.deps.settings.current()
    const researchResult = isRecord(payload) && isResearchResult(payload['research']) ? payload['research'] : undefined

    // The assistant's own reply can come back through the event stream; that is
    // an echo, not a new question.
    if (isEcho(message.text, recentOutboundTexts(this.deps.store, thread.key))) {
      this.defer(decisionId, 'echo')
      return
    }

    const now = this.deps.clock.now()
    const at = now.getTime()
    const counters: GateCounters = readGateCounters(this.deps.counters, thread.key, at)
    const target = threadTarget(thread, message)
    if (!target) {
      this.defer(decisionId, 'target_missing')
      return
    }
    const gate = gateReply({
      settings,
      message: toBrainMessage(message),
      thread: { key: thread.key, targetId: thread.targetId, kind: thread.kind },
      now,
      counters,
      loop: { consecutiveAiReplies: consecutiveAiReplies(this.deps.store, thread.key) },
    })
    if (!gate.act) {
      this.defer(decisionId, gate.reason)
      return
    }

    const model = this.deps.model.forThread(thread.key, thread.title)
    const composed = await composeReply(
      {
        persona: settings.persona,
        classification: classificationOf(decision, researchResult !== undefined),
        message: toBrainMessage(message),
        threadWindow: threadWindow(this.deps.store, thread.key, this.deps.ownerUserId()),
        ...(researchResult === undefined ? {} : { research: researchResult }),
        options: {
          prompts: this.deps.prompts,
          targetLabel: thread.title,
          now,
        },
      },
      model,
      this.deps.lifetime,
    )
    if (!composed.ok) {
      this.defer(decisionId, `compose:${composed.reason}`)
      return
    }

    const drafted = this.deps.engine.draft(decisionId, {
      text: composed.text,
      researched: researchResult !== undefined && !researchResult.degraded,
      sources: composed.sources,
    })
    if (gate.mode === 'review') return
    if (drafted.status !== 'drafted') return

    const outbound = this.deps.engine.queueReply(decisionId, {
      outboundId: this.deps.ids.next('outbound'),
      idempotencyKey: `reply:${decisionId}`,
      text: composed.text,
      target,
    })
    this.deps.effects.enqueue('send', outbound.id, {
      outboundId: outbound.id,
      decisionId,
      threadKey: thread.key,
    })
  }

  /** Deliver one outbox row and record exactly the outcome the channel reported. */
  private async send(payload: unknown, key: string): Promise<void> {
    const outboundId = readString(payload, 'outboundId') ?? key
    const outbound = this.deps.store.outbound.get(outboundId)
    if (!outbound || outbound.status !== 'pending') return

    // A stopped channel keeps the row pending; the resume pass enqueues it when
    // a channel is running again. This is a deferral, not a failure.
    const channel = this.deps.channel()
    if (!channel || !this.deps.channelRunning()) return

    const decisionId = readString(payload, 'decisionId')
    const threadKey = readString(payload, 'threadKey')
    const decision = decisionId === undefined ? decisionForOutbound(this.deps.store, outbound.id) : undefined
    const detail = await channel.sendWithReceipt(outbound)
    const replyDecisionId = decisionId ?? decision?.id
    const reply = replyDecisionId !== undefined && this.deps.engine.decision(replyDecisionId)?.status === 'sending'
    const conversation = threadKey ?? (decision ? decision.threadKey : threadKeyOf(outbound.target))

    switch (detail.result) {
      case 'sent': {
        this.recordSent(outbound, replyDecisionId, detail.receipt)
        this.deps.counters.hit(counterKey(conversation), this.deps.clock.now().getTime(), HOUR_MS)
        return
      }
      case 'skipped':
        return
      case 'unknown': {
        this.recordOutcome(outbound, replyDecisionId, 'unknown', detail.error ?? 'delivery could not be proven')
        this.notice({
          kind: 'send_unknown',
          threadKey: conversation,
          outboundId: outbound.id,
          ...(replyDecisionId === undefined ? {} : { decisionId: replyDecisionId }),
          reason: detail.error ?? 'delivery could not be proven',
        })
        return
      }
      case 'failed':
      case 'gone':
      default: {
        const reason =
          detail.error ?? (detail.result === 'gone' ? 'the conversation no longer exists' : 'delivery failed')
        this.recordOutcome(outbound, replyDecisionId, 'failed', reason)
        this.notice({
          kind: 'send_failed',
          threadKey: conversation,
          outboundId: outbound.id,
          ...(replyDecisionId === undefined ? {} : { decisionId: replyDecisionId }),
          reason,
        })
        return
      }
    }
  }

  private recordSent(outbound: Outbound, decisionId: string | undefined, receipt: string | undefined): void {
    if (decisionId !== undefined) {
      try {
        this.deps.engine.replySent(decisionId, receipt)
        return
      } catch (error) {
        ignoreRefusal(error)
      }
    }
    try {
      this.deps.engine.outboundSent(outbound.id, receipt)
    } catch (error) {
      ignoreRefusal(error)
    }
  }

  private recordOutcome(
    outbound: Outbound,
    decisionId: string | undefined,
    outcome: 'unknown' | 'failed',
    reason: string,
  ): void {
    if (decisionId !== undefined) {
      try {
        if (outcome === 'unknown') this.deps.engine.replyUnknown(decisionId, reason)
        else this.deps.engine.replyFailed(decisionId, reason)
        return
      } catch (error) {
        ignoreRefusal(error)
      }
    }
    try {
      if (outcome === 'unknown') this.deps.engine.outboundUnknown(outbound.id, reason)
      else this.deps.engine.outboundFailed(outbound.id, reason)
    } catch (error) {
      ignoreRefusal(error)
    }
  }

  private defer(decisionId: string, reason: string): void {
    try {
      this.deps.engine.defer(decisionId, reason)
    } catch (error) {
      ignoreRefusal(error)
    }
  }

  private notice(payload: NoticePayload): void {
    this.deps.effects.enqueue(
      'notify',
      `${payload.kind}:${payload.outboundId ?? payload.decisionId ?? payload.taskId ?? 'x'}`,
      payload,
    )
  }
}

interface ClassifyMessageInput {
  readonly message: ReturnType<typeof toBrainMessage>
  readonly threadWindow: ThreadWindow
  readonly settings: SettingsService
  readonly prompts: PromptSource
  readonly model: ModelPort
  readonly threadTitle: string
  readonly now: Date
  readonly signal: AbortSignal
}

/** Call the brain classifier with the settings and templates the runtime owns. */
async function classifyMessage(input: ClassifyMessageInput) {
  return await classify(
    {
      message: input.message,
      threadWindow: input.threadWindow,
      persona: input.settings.current().persona,
      model: input.model,
      options: {
        prompts: input.prompts,
        targetLabel: input.threadTitle,
        now: input.now,
      },
    },
    input.signal,
  )
}
