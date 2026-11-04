/**
 * Contracts of the reply brain: the ports it may call, the values it produces
 * and the settings-derived shapes it accepts.
 *
 * Everything here is a plain type or a frozen string table. Model access,
 * retrieval and rate limiting are ports (`ModelPort`, `ResearchPort`,
 * `CounterStore`), so the brain layer never opens a socket, never starts a
 * process and never imports a host package. Tests replace the ports with stubs.
 *
 * The brain does not import `src/core`. It speaks to the app layer through the
 * narrow message/thread shapes below, which the app maps from `InboundMessage`
 * and `Thread`; that keeps classifier tests free of domain fixtures.
 */
import type { Settings } from '../shared/settings.ts'

/** What one model call is asked to do. `maxChars` is a hint, not a guarantee. */
export interface ModelRequest {
  readonly system: string
  readonly messages: ModelMessage[]
  readonly maxChars?: number
}

/** One turn of a model conversation; the brain sends user turns only. */
export interface ModelMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** The only way the brain reaches a model. Implementations own routing and retries. */
export interface ModelPort {
  complete(req: ModelRequest, signal: AbortSignal): Promise<string>
}

/** Budget a retrieval call is allowed to spend. */
export interface ResearchSearchOptions {
  limit: number
  timeoutMs: number
}

/** Raw retrieval result, before the brain applies its budget and deduplication. */
export interface ResearchHit {
  facts: string[]
  sources: { title: string; url: string }[]
}

/** The only way the brain reaches retrieval. */
export interface ResearchPort {
  search(query: string, opts: ResearchSearchOptions, signal: AbortSignal): Promise<ResearchHit>
}

/** A read-only sliding-window counter; the gate consumes its numbers, not the store. */
export interface CounterStore {
  hit(key: string, at: number, windowMs: number): number
}

/** How the channel classifies the conversation a message arrived in. */
export type BrainMessageKind = 'at-me' | 'group' | 'dm'

/**
 * One inbound message as the brain sees it.
 *
 * It carries only what the reply decision needs: who wrote it, what it says,
 * whether it addresses the assistant, and whether the channel marked it as a
 * broadcast. The channel is responsible for filtering non-human and system
 * messages before they reach the brain.
 */
export interface BrainMessage {
  readonly id: string
  readonly text: string
  readonly senderId: string
  readonly senderName: string
  readonly kind: BrainMessageKind
  readonly conversationType: 'group' | 'direct'
  readonly addressed: boolean
  readonly broadcast: boolean
  /** ISO-8601 instant of the message, as the channel reported it. */
  readonly at: string
}

/** One earlier message offered to the model as context. */
export interface ThreadWindowEntry {
  readonly author: string
  readonly text: string
  readonly at?: string
  /** True when the assistant (acting as the owner) wrote this entry. */
  readonly self: boolean
}

/** Recent history, oldest first; every model prompt and the gate read it bounded. */
export type ThreadWindow = readonly ThreadWindowEntry[]

/** What the classifier decided a message is. Mirrors `src/core/model.ts#Intent`. */
export type Intent = 'chat' | 'question' | 'task' | 'ignore'

/** The captured task a classifier proposes for `intent: 'task'`. */
export interface ClassifiedTask {
  readonly title: string
  readonly brief: string
  readonly requirements: readonly string[]
}

/** A validated classification. */
export interface ClassifySuccess {
  readonly ok: true
  readonly intent: Intent
  readonly confidence: number
  readonly reason: string
  /** True only for `question`; every other intent is forced to false. */
  readonly needSearch: boolean
  /** Present only for `task`, and always with a non-empty title. */
  readonly task: ClassifiedTask | null
}

/** Why a classification did not produce a result; the caller defers the message. */
export type ClassifyFailureReason = 'invalid' | 'timeout' | 'low_confidence'

export interface ClassifyFailure {
  readonly ok: false
  readonly reason: ClassifyFailureReason
  /** Short diagnostic; never the message text or the model's raw output. */
  readonly detail?: string
}

export type ClassifyResult = ClassifySuccess | ClassifyFailure

/** One citation the retrieval layer vouched for. */
export interface ResearchSource {
  readonly title: string
  readonly url: string
}

/** Why retrieval could not produce facts; callers reply as if nothing was found. */
export type ResearchFailureReason = 'disabled' | 'empty' | 'timeout' | 'aborted' | 'error'

/** A bounded retrieval result. `degraded` means "reply without facts". */
export interface ResearchResult {
  readonly query: string
  readonly facts: readonly string[]
  readonly sources: readonly ResearchSource[]
  readonly degraded: boolean
  readonly cached: boolean
  /** `research.includeCitations`: whether the reply may show the sources. */
  readonly includeCitations: boolean
  readonly reason?: ResearchFailureReason
}

/** A reply that passed every post-check. */
export interface ComposeSuccess {
  readonly ok: true
  readonly text: string
  /** URLs from `research` that survived in the text, in research order. */
  readonly sources: readonly string[]
}

/** Why a reply was discarded; the caller defers instead of sending. */
export type ComposeFailureReason = 'timeout' | 'empty' | 'echoes_system_prompt' | 'model_error'

export interface ComposeFailure {
  readonly ok: false
  readonly reason: ComposeFailureReason
  readonly detail?: string
}

export type ComposeResult = ComposeSuccess | ComposeFailure

/** The message subset the reply gate reads. */
export interface GateMessage {
  readonly senderId: string
  readonly senderName: string
  readonly text: string
  /**
   * How the channel classified the event that carried this message. A group
   * thread is shared by at-me and group subscriptions, so this is the only
   * signal that tells an at-me event from an ordinary group message.
   */
  readonly kind: BrainMessageKind
  readonly conversationType: 'group' | 'direct'
  readonly addressed: boolean
  readonly broadcast: boolean
}

/** The thread subset the reply gate reads; `targetId` selects the target row. */
export interface GateThread {
  readonly key: string
  readonly targetId: string
  readonly kind: BrainMessageKind
}

/**
 * Numbers the caller read from its counter store before calling the gate.
 * `hour` counts replies in the last hour for this conversation; `gapMs` is the
 * time since the last reply there (`Number.POSITIVE_INFINITY` when none).
 */
export interface GateCounters {
  readonly hour: number
  readonly gapMs: number
}

/** How many assistant messages in a row already went out in this conversation. */
export interface LoopState {
  readonly consecutiveAiReplies: number
}

/** Everything the gate needs; all times are injected so the matrix is testable. */
export interface GateInput {
  readonly settings: Settings
  readonly message: GateMessage
  readonly thread: GateThread
  readonly now: Date
  readonly counters: GateCounters
  readonly loop: LoopState
}

/**
 * Stable reason codes. They are the only text the panel has to translate, and
 * they are stable across releases, so a locale file can key on them.
 */
export const GATE_REASONS = [
  'allowed',
  'target_review',
  'quiet_hours',
  'auto_reply_off',
  'rate_limited',
  'min_gap',
  'monitor_disabled',
  'monitor_paused',
  'target_missing',
  'target_disabled',
  'target_off',
  'sender_blocked',
  'sender_not_allowed',
  'not_addressed',
  'broadcast',
  'loop_guard',
] as const

export type GateReason = (typeof GATE_REASONS)[number]

/** The gate may only ever produce an auto send, a review draft, or nothing. */
export interface GateAllow {
  readonly act: true
  readonly mode: 'auto' | 'review'
  readonly reason: GateReason
}

export interface GateDeny {
  readonly act: false
  readonly reason: GateReason
}

export type GateDecision = GateAllow | GateDeny

/** The five prompt templates the brain loads; the order is the shipped file order. */
export const PROMPT_NAMES = ['classifier', 'reply', 'research', 'safety', 'persona'] as const

export type PromptName = (typeof PROMPT_NAMES)[number]

/** Anything that can serve prompt templates, so callers can inject a fake. */
export interface PromptSource {
  get(name: PromptName): string
}

/** Values a `{{variable}}` may be replaced with; arrays join with newlines. */
export type PromptVars = Record<string, string | number | boolean | readonly string[]>
