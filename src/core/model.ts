/**
 * Pure domain types of the Whale Chan assistant.
 *
 * Every type here is a plain value: no clocks, no I/O, no Node built-ins, and
 * no dependency on any other project layer. Times are ISO-8601 strings produced
 * by the injected clock, so a snapshot of the domain survives a restart and
 * sorts lexicographically.
 *
 * Three fields extend the WS1 review sketch for traceability, and none changes
 * the meaning of the states described in `docs/001-domain.md`:
 *
 * - `Decision.confidence` records the classifier's certainty for one message.
 * - `Task.reason` records why a person cancelled a task, so the panel does not
 *   have to reconstruct it from an event log.
 * - `InboundMessage.title` carries the channel's conversation title, which the
 *   thread uses when present and falls back from otherwise.
 */

/** ISO-8601 instant (`new Date().toISOString()` shape). */
export type IsoTime = string

/** The person who wrote an inbound message, as the channel identifies them. */
export interface Sender {
  readonly userId: string
  readonly openDingTalkId?: string
  readonly nick: string
}

/** One inbound message, already accepted by the channel and keyed by its stable event id. */
export interface InboundMessage {
  readonly id: string
  readonly targetId: string
  readonly threadKey: string
  readonly kind: 'at-me' | 'group' | 'dm'
  readonly conversationId: string
  readonly conversationType: 'group' | 'direct'
  /** Title the channel reports for the conversation, such as a group name. */
  readonly title?: string
  readonly sender: Sender
  readonly text: string
  /** Whether the message names the assistant, as the channel reported it. */
  readonly addressed: boolean
  /** When the message was sent, according to the channel. */
  readonly at: IsoTime
  /** When this host accepted the message. */
  readonly receivedAt: IsoTime
  readonly mentions: readonly string[]
}

/** Counters kept on a thread; each is incremented exactly once per domain event. */
export interface ThreadCounts {
  readonly inbound: number
  readonly replied: number
  readonly tasks: number
}

/** One conversation as the assistant sees it. */
export interface Thread {
  readonly key: string
  readonly targetId: string
  readonly kind: InboundMessage['kind']
  readonly title: string
  /** The direct peer, when the thread is a one-to-one conversation. */
  readonly peer: Sender | null
  readonly lastMessageAt: IsoTime
  readonly createdAt: IsoTime
  readonly counts: ThreadCounts
}

/** How a decision classified one message. */
export type Intent = 'chat' | 'question' | 'task' | 'ignore'

/**
 * Where a decision stands. The reply tail (`drafted` → `sending` → one of
 * `sent`, `send_unknown`, `send_failed`) and the task tail (`task_created`)
 * are mutually exclusive.
 */
export type DecisionStatus =
  | 'queued'
  | 'classified'
  | 'drafted'
  | 'sending'
  | 'sent'
  | 'send_unknown'
  | 'send_failed'
  | 'task_created'
  | 'ignored'
  | 'deferred'

/** A prepared reply, before it is queued as an outbound message. */
export interface Draft {
  readonly text: string
  readonly researched: boolean
  readonly sources: readonly string[]
}

/** What the assistant decided about one inbound message. */
export interface Decision {
  readonly id: string
  readonly messageId: string
  readonly threadKey: string
  readonly intent: Intent | null
  readonly status: DecisionStatus
  readonly draft: Draft | null
  readonly outboundId: string | null
  readonly taskId: string | null
  readonly reason: string | null
  /** Classifier confidence, when the classifier reported one. */
  readonly confidence: number | null
  /** Delivery or execution attempts recorded by later workstreams. */
  readonly attempts: number
  readonly at: IsoTime
  readonly updatedAt: IsoTime
}

/** Lifecycle of a captured task. */
export type TaskStatus =
  | 'captured'
  | 'awaiting-approval'
  | 'approved'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired'

/** The outcome an executor reports when an assignment ends. */
export type AssignmentOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timeout'

/** What a finished task produced. */
export interface TaskResult {
  readonly summary: string
  readonly sessionId?: string
  readonly artifactPaths?: readonly string[]
}

/** A unit of work captured from one message, gated by a person's approval. */
export interface Task {
  readonly id: string
  readonly threadKey: string
  readonly requester: Sender
  readonly messageId: string
  readonly title: string
  readonly brief: string
  readonly requirements: readonly string[]
  readonly status: TaskStatus
  readonly approvalId: string | null
  readonly assignmentId: string | null
  readonly result: TaskResult | null
  /** Why the task was cancelled, when it was cancelled by a person. */
  readonly reason: string | null
  readonly createdAt: IsoTime
  readonly updatedAt: IsoTime
}

/** A person's explicit authorization for one task. */
export interface Approval {
  readonly id: string
  readonly taskId: string
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired'
  readonly requestedAt: IsoTime
  readonly expiresAt: IsoTime
  readonly decidedAt: IsoTime | null
  readonly decidedBy: 'owner' | null
  readonly note: string | null
}

/** The binding of an approved task to one executor session. */
export interface Assignment {
  readonly id: string
  readonly taskId: string
  readonly state: 'pending' | 'running' | 'ended'
  readonly sessionId: string | null
  readonly workspace: string
  readonly startedAt: IsoTime | null
  readonly endedAt: IsoTime | null
  readonly outcome: AssignmentOutcome | null
  readonly error: string | null
}

/** Where an outbound message must be delivered. */
export interface OutboundTarget {
  readonly kind: InboundMessage['kind']
  readonly conversationId: string
  readonly peerUserId?: string
}

/** A message staged for delivery; `idempotencyKey` bounds it to one external message. */
export interface Outbound {
  readonly id: string
  readonly idempotencyKey: string
  readonly kind: 'reply' | 'notice'
  readonly target: OutboundTarget
  readonly text: string
  readonly status: 'pending' | 'sent' | 'unknown' | 'failed' | 'dropped'
  readonly attempts: number
  readonly lastError: string | null
  readonly sentAt: IsoTime | null
  readonly receipt: string | null
}
