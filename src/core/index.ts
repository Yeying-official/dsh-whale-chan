/**
 * Pure domain skeleton for the future assistant.
 *
 * This layer contains no I/O, timers, environment access or imports from other
 * project layers. WS0 deliberately declares only the concepts that later work
 * will implement; adding behaviour here starts with the domain document and the
 * approved design in `docs/010-design.md`.
 */

export type ThreadKey = string
export type MessageId = string
export type TaskId = string
export type ApprovalId = string

export type ThreadKind = 'at-me' | 'group' | 'dm'
export type MessageDirection = 'incoming' | 'outgoing'
export type DecisionKind = 'ignore' | 'reply' | 'capture-task' | 'research'

/** One conversation as the assistant sees it. */
export interface Thread {
  readonly key: ThreadKey
  readonly kind: ThreadKind
  readonly title: string
  readonly lastMessageAt: string
}

/** One inbound or outbound message. */
export interface Message {
  readonly id: MessageId
  readonly threadKey: ThreadKey
  readonly direction: MessageDirection
  readonly senderId: string
  readonly senderName: string
  readonly text: string
  readonly sentAt: string
}

/** Why one message did or did not cause work. */
export interface Decision {
  readonly messageId: MessageId
  readonly kind: DecisionKind
  readonly reason: string
  readonly decidedAt: string
}

export type TaskStatus =
  | 'captured'
  | 'awaiting-approval'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired'

/** An executable unit captured from a message. */
export interface Task {
  readonly id: TaskId
  readonly title: string
  readonly status: TaskStatus
  readonly threadKey: ThreadKey
  readonly createdAt: string
  readonly updatedAt: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** Human authorization required before a Task may enter execution. */
export interface Approval {
  readonly id: ApprovalId
  readonly taskId: TaskId
  readonly status: ApprovalStatus
  readonly requestedAt: string
  readonly expiresAt: string
  readonly decidedAt?: string
  readonly decidedBy?: string
}

/** Handoff of an approved Task to an executor Session. */
export interface Assignment {
  readonly id: string
  readonly taskId: TaskId
  readonly sessionId: string
  readonly state: 'pending' | 'running' | 'ended'
  readonly createdAt: string
}

/** Kinds of side effects the app layer will stage through its Outbox. */
export type EffectKind = 'send-message' | 'notify' | 'start-assignment'

/** A serialized side effect awaiting an idempotent commit. */
export interface Effect {
  readonly id: string
  readonly kind: EffectKind
  readonly taskId?: TaskId
  readonly payload: Readonly<Record<string, string>>
}
