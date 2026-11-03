/**
 * The channel surface the WS5b runtime drives.
 *
 * WS5a only needed two one-shot questions (`ChannelPort`). The runtime also
 * starts subscriptions, probes authorization, sends queued messages and reads
 * health. Those shapes are declared structurally here rather than imported
 * from `src/channel`, so this module stays a plain contract and the DingTalk
 * facade is wrapped once in `dingtalk-channel.ts`.
 */
import type { InboundMessage, Outbound } from '../core/index.ts'
import type { TargetKind } from '../shared/limits.ts'
import type { TargetCandidate, TargetDraft, TargetValidation } from '../shared/models.ts'
import type { ChannelPort } from './channel-port.ts'

/** Outcome vocabulary of one delivery attempt. */
export type ChannelSendResult = 'sent' | 'unknown' | 'failed' | 'gone' | 'skipped'

/** A send result plus the detail the outbox records. */
export interface ChannelSendDetail {
  readonly result: ChannelSendResult
  readonly receipt?: string
  readonly error?: string
}

/** Read-only authorization probe; never carries a token. */
export interface ChannelAuthState {
  readonly available: boolean
  readonly version?: string
  readonly authenticated: boolean
  readonly tokenValid: boolean
  readonly expiresAt?: string
  /** Authorized account id; used only to filter the assistant's own messages. */
  readonly userId?: string
}

/** One subscription's state, as the health view reports it. */
export interface ChannelTargetHealth {
  readonly targetId: string
  readonly kind: TargetKind
  readonly label?: string
  readonly state: 'starting' | 'ready' | 'stopped' | 'failed' | 'orphaned'
  readonly subscribeId?: string
  readonly restarts: number
  readonly readyAt?: string
  readonly lastError?: string
}

/** Aggregate channel health. */
export interface ChannelHealthState {
  readonly state: 'stopped' | 'starting' | 'ready' | 'degraded'
  readonly running: boolean
  readonly targets: readonly ChannelTargetHealth[]
}

/** Receives every decoded inbound message. */
export type ChannelEventSink = (message: InboundMessage) => void

/** Everything the runtime needs from one channel adapter. */
export interface ChannelRuntime extends ChannelPort {
  start(sink: ChannelEventSink): Promise<ChannelHealthState>
  stop(): Promise<void>
  sendWithReceipt(outbound: Outbound): Promise<ChannelSendDetail>
  probeAuth(): Promise<ChannelAuthState>
  health(): ChannelHealthState
  /** The account id used for self-detection; empty when no owner is known. */
  ownerUserId(): string
}
