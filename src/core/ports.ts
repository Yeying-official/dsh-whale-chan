/**
 * Ports the pure domain depends on.
 *
 * `Repositories` is synchronous on purpose: one engine command is one
 * transaction, so every read and write of that command happens inside the
 * caller-owned `atomic` block. The store implements this port; tests use an
 * in-memory implementation with snapshot rollback.
 *
 * `Ids` and `Clock` are injected seams. Production uses random ids and the wall
 * clock; tests use deterministic sequences so ids and `updatedAt` values are
 * assertable.
 */
import type {
  Approval,
  Assignment,
  AssignmentOutcome,
  Decision,
  InboundMessage,
  IsoTime,
  Outbound,
  Task,
  Thread,
} from './model.ts'

export interface MessageRepository {
  get(id: string): InboundMessage | undefined
  /** Inserts a message once; saving the same id twice is a store error, not an upsert. */
  save(message: InboundMessage): void
}

export interface ThreadRepository {
  get(key: string): Thread | undefined
  save(thread: Thread): void
}

export interface DecisionRepository {
  get(id: string): Decision | undefined
  /** The decision that already owns a message, which makes `receive` idempotent per message id. */
  byMessageId(messageId: string): Decision | undefined
  save(decision: Decision): void
}

export interface TaskRepository {
  get(id: string): Task | undefined
  save(task: Task): void
  /** Tasks that are not yet terminal: awaiting approval, approved or running. */
  open(): readonly Task[]
}

export interface ApprovalRepository {
  get(id: string): Approval | undefined
  byTaskId(taskId: string): Approval | undefined
  save(approval: Approval): void
  /**
   * Every approval whose status is still `pending`, including one whose
   * `expiresAt` has passed: expiry is decided by `Engine.expireTasks`, not by
   * this query, so a sweep can see the overdue rows.
   */
  listPending(): readonly Approval[]
}

export interface AssignmentRepository {
  get(id: string): Assignment | undefined
  save(assignment: Assignment): void
}

export interface OutboundRepository {
  get(id: string): Outbound | undefined
  /** The message already queued under this idempotency key, which bounds delivery to one external message. */
  byIdempotencyKey(key: string): Outbound | undefined
  save(outbound: Outbound): void
  pending(): readonly Outbound[]
}

/** Durable state of the domain, one transaction per command. */
export interface Repositories {
  atomic<T>(work: () => T): T
  readonly messages: MessageRepository
  readonly threads: ThreadRepository
  readonly decisions: DecisionRepository
  readonly tasks: TaskRepository
  readonly approvals: ApprovalRepository
  readonly assignments: AssignmentRepository
  readonly outbound: OutboundRepository
}

/** Stable identifier source; `prefix` names the aggregate being minted. */
export interface Ids {
  next(prefix: string): string
}

/** Wall-clock seam of the engine. */
export interface Clock {
  now(): Date
}

/** Event data by type; only ids and the status the event reports, never payload text. */
export interface DomainEvents {
  'message.received': { messageId: string; threadKey: string }
  'decision.queued': { decisionId: string; threadKey: string }
  'decision.classified': { decisionId: string; intent: 'chat' | 'question' | 'task' | 'ignore' }
  'reply.drafted': { decisionId: string }
  'reply.queued': { decisionId: string; outboundId: string; idempotencyKey: string }
  'reply.sent': { decisionId: string; outboundId: string }
  'reply.unknown': { decisionId: string; outboundId: string; error: string }
  'reply.failed': { decisionId: string; outboundId: string; error: string }
  'task.created': { taskId: string; decisionId: string; threadKey: string }
  'task.approved': { taskId: string; approvalId: string; assignmentId: string }
  'task.rejected': { taskId: string; approvalId: string }
  'task.cancelled': { taskId: string; reason: string }
  'task.expired': { taskId: string; approvalId: string }
  'assignment.started': { taskId: string; assignmentId: string }
  'assignment.ended': { taskId: string; assignmentId: string; outcome: AssignmentOutcome }
}

/** One domain event, stamped with the command's clock reading. */
export type DomainEvent = {
  [K in keyof DomainEvents]: { readonly type: K; readonly at: IsoTime; readonly data: DomainEvents[K] }
}[keyof DomainEvents]

/** Optional observer of committed domain events. */
export type Emit = (event: DomainEvent) => void

export interface EngineOptions {
  readonly repos: Repositories
  readonly ids: Ids
  readonly clock: Clock
  /**
   * Observes events after their command committed. A throwing listener cannot
   * undo the command, so listener errors are contained by the engine.
   */
  readonly emit?: Emit
}
