/**
 * Values the dws channel shares with its callers.
 *
 * Everything here is a plain value or a narrow function type: the channel
 * adapter never imports the app layer or `@deepseek-ai/*`, so the host can
 * compose it directly. Domain types come from `src/core`, which stays free of
 * Node built-ins.
 */
import type { InboundMessage } from '../core/model.ts'
import type { TargetKind } from '../shared/limits.ts'

/**
 * One explicit subscription target.
 *
 * `id` is the conversation identifier the `dws` contract names for the kind:
 * the `openConversationId` of a group, the `userId` of a one-to-one peer (or
 * `open:<openDingTalkId>` when only the open id is known), and a stable
 * operator-chosen key for the global at-me subscription.
 */
export interface DwsTarget {
  readonly kind: TargetKind
  readonly id: string
  readonly label?: string
  /** Whether the decision layer should require an explicit mention before replying. */
  readonly mentionOnly: boolean
  readonly enabled: boolean
}

/** One accepted inbound message; the channel emits exactly the core model. */
export type ChannelEvent = InboundMessage

/** Outcome of one delivery attempt: `sent`, `failed`, `gone`, `unknown` or `skipped`. */
export type SendResult = 'sent' | 'unknown' | 'failed' | 'gone' | 'skipped'

/** Lifecycle of one per-target subscription process. */
export type ProcessState = 'starting' | 'ready' | 'stopped' | 'failed' | 'orphaned'

/** Health of one target subscription, safe to show in a panel. */
export interface TargetHealth {
  readonly targetId: string
  readonly kind: TargetKind
  readonly label?: string
  readonly state: ProcessState
  /** `subscribe_id` reported by the ready line, when the process reported one. */
  readonly subscribeId?: string
  /** Consecutive restart attempts since the last successful ready. */
  readonly restarts: number
  readonly readyAt?: string
  /** Redacted, single-line description of the last failure. */
  readonly lastError?: string
  /** Accepted messages waiting for the sink, and lines rejected by normalization. */
  readonly pending: number
  readonly malformed: number
  /** Executable actually spawned; a Windows shim is resolved here, never a secret. */
  readonly command?: string
}

/** Aggregate channel health. */
export interface ChannelHealth {
  readonly state: 'stopped' | 'starting' | 'ready' | 'degraded'
  readonly running: boolean
  readonly targets: readonly TargetHealth[]
}

/** One conversation the discovery commands found. */
export interface TargetCandidate {
  readonly kind: 'group' | 'dm'
  readonly id: string
  readonly label: string
  readonly source: 'chat-search' | 'chat-list'
}

/** Result of a non-destructive `--dry-run` validation. */
export interface ValidateResult {
  readonly valid: boolean
  readonly error?: string
}

/** Read-only authentication probe; never carries a token or an account id. */
export interface AuthState {
  readonly available: boolean
  readonly version?: string
  readonly authenticated: boolean
  readonly tokenValid: boolean
  readonly expiresAt?: string
  /**
   * The authorized account id, when `auth status` reports one.
   *
   * This is the only value in this module that identifies a person. It is
   * returned to the host so it can be passed back as `ownerUserId`; it is never
   * logged, persisted by the channel, or written into documentation.
   */
  readonly userId?: string
  /**
   * The authorized account's display name, when reported.
   *
   * Used only to recognize the owner's `@nick` in flattened group text; it is
   * returned to the host so it can be passed back as `ownerNick`, and is never
   * logged or persisted by the channel.
   */
  readonly userName?: string
}

/** Minimal logger seam; every message is expected to be already redacted. */
export interface ChannelLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Why a raw line was not turned into an event. */
export type SkipReason = 'self' | 'broadcast' | 'empty' | 'malformed' | 'unsupported'

/** One completed one-shot dws invocation. */
export interface CommandResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /** Spawn-level failure such as a missing executable, already redacted. */
  readonly error?: string
}

/** Runs one dws command with an argument array; the only seam tests replace. */
export interface CommandRunner {
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<CommandResult>
}
