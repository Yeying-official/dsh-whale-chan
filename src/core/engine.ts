/**
 * The domain engine: the only place that mutates the aggregates.
 *
 * Every public command runs inside exactly one `Repositories.atomic` block.
 * Validation happens before or during that block and throws `UserError`, which
 * rolls the whole command back, so a refused command never leaves half a task,
 * half an approval or a stray decision behind. Commands are synchronous and
 * return the aggregate they changed; read queries do not open a transaction.
 *
 * Domain events are collected during the transaction and delivered only after
 * it commits, so an observer never sees a rolled-back state and a throwing
 * observer cannot undo a committed command.
 */
import { UserError } from './errors.ts'
import type {
  Approval,
  Assignment,
  AssignmentOutcome,
  Decision,
  Draft,
  InboundMessage,
  Intent,
  IsoTime,
  Outbound,
  OutboundTarget,
  Task,
  TaskResult,
  Thread,
} from './model.ts'
import type { DomainEvent, Emit, EngineOptions, Repositories } from './ports.ts'

export type { DomainEvent, EngineOptions } from './ports.ts'
export type { AssignmentOutcome } from './model.ts'

/** The captured task a classifier proposes with an `intent: 'task'` decision. */
export interface TaskSpec {
  readonly title: string
  readonly brief?: string
  readonly requirements?: readonly string[]
}

export interface ClassifyOptions {
  readonly intent: Intent
  /** Classifier certainty, recorded for audit; no state machine reads it. */
  readonly confidence?: number
  readonly reason?: string
  /** Required when `intent` is `task`. */
  readonly task?: TaskSpec
  /** How long the approval stays actionable; required when `intent` is `task`. */
  readonly approvalTtlMs?: number
}

export interface ReceiveResult {
  readonly decision: Decision
  /** True when this message id already produced a decision; nothing new was written. */
  readonly duplicate: boolean
}

export interface QueueReplyOptions {
  readonly outboundId: string
  readonly idempotencyKey: string
  readonly text: string
  readonly target: OutboundTarget
}

/**
 * One follow-up message, queued without a Decision.
 *
 * A task result has no inbound message to classify, so it cannot ride the
 * reply chain. It still needs the same delivery guarantees, which is why it is
 * a full `Outbound` bounded by its own idempotency key.
 */
export interface QueueFollowupOptions {
  readonly threadKey: string
  readonly target: OutboundTarget
  readonly text: string
  readonly idempotencyKey: string
  readonly kind: 'reply' | 'notice'
  readonly outboundId: string
}

export interface FollowupTimingOptions {
  /** Instant the queue command is stamped with; defaults to the engine clock. */
  readonly at?: IsoTime
}

export interface ApproveOptions {
  readonly by: 'owner'
  readonly note?: string
  /** When the person approved, as the panel recorded it. */
  readonly at: IsoTime
  /** Workspace the pending assignment must run in, chosen by the approver. */
  readonly workspace: string
}

export interface RejectOptions {
  readonly by: 'owner'
  readonly note?: string
  readonly at: IsoTime
}

export interface CancelOptions {
  readonly by: 'owner'
  readonly reason?: string
  readonly at: IsoTime
}

export interface RetryOptions {
  readonly by: 'owner'
  readonly note?: string
  /** When the person asked for the retry, as the panel recorded it. */
  readonly at: IsoTime
  /** Workspace the new assignment must run in. */
  readonly workspace: string
}

export interface EndAssignmentOptions {
  readonly outcome: AssignmentOutcome
  readonly result?: TaskResult
}

export interface AssignmentStartOptions {
  /**
   * Session the executor started for this assignment. Omitted (or blank) keeps
   * `sessionId` null; a bound session survives the end of the assignment.
   */
  readonly sessionId?: string
}

export class Engine {
  private readonly repos: Repositories

  constructor(private readonly options: EngineOptions) {
    this.repos = options.repos
  }

  // Inbound

  /**
   * Accept one inbound message exactly once: the message, its thread counters
   * and one `queued` decision are written in a single transaction. A message
   * whose id already has a decision returns that decision and writes nothing.
   */
  receive(message: InboundMessage): ReceiveResult {
    return this.command((emit) => {
      const existing = this.repos.decisions.byMessageId(message.id)
      if (existing) return { decision: existing, duplicate: true }
      const at = this.now()
      this.repos.messages.save(message)
      const thread = this.repos.threads.get(message.threadKey)
      this.repos.threads.save(thread ? advanceThread(thread, message) : newThread(message, at))
      const decision: Decision = {
        id: this.options.ids.next('decision'),
        messageId: message.id,
        threadKey: message.threadKey,
        intent: null,
        status: 'queued',
        draft: null,
        outboundId: null,
        taskId: null,
        reason: null,
        confidence: null,
        attempts: 0,
        at,
        updatedAt: at,
      }
      this.repos.decisions.save(decision)
      emit({ type: 'message.received', at, data: { messageId: message.id, threadKey: message.threadKey } })
      emit({ type: 'decision.queued', at, data: { decisionId: decision.id, threadKey: decision.threadKey } })
      return { decision, duplicate: false }
    })
  }

  /**
   * Classify one queued decision.
   *
   * `task` creates the task, its pending approval and the decision's link to it
   * in the same transaction; the task therefore never exists without either its
   * approval or a rollback. `ignore` closes the decision, `chat` and `question`
   * move it to `classified` for drafting.
   */
  classify(decisionId: string, options: ClassifyOptions): Decision {
    return this.command((emit) => {
      const at = this.now()
      const decision = this.requireDecision(decisionId)
      if (decision.status !== 'queued') throw new UserError('notQueued')

      if (options.intent !== 'task') {
        const classified: Decision = {
          ...decision,
          intent: options.intent,
          status: options.intent === 'ignore' ? 'ignored' : 'classified',
          reason: options.reason ?? null,
          confidence: options.confidence ?? null,
          updatedAt: at,
        }
        this.repos.decisions.save(classified)
        emit({ type: 'decision.classified', at, data: { decisionId, intent: options.intent } })
        return classified
      }

      const spec = options.task
      if (!spec || spec.title.trim().length === 0) throw new UserError('missingTaskDetail')
      const ttl = options.approvalTtlMs
      if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new UserError('missingApprovalTtl')
      const message = this.repos.messages.get(decision.messageId)
      if (!message) throw new UserError('unknownMessage')

      const thread = this.repos.threads.get(decision.threadKey)
      if (!thread) throw new UserError('unknownThread')

      const taskId = this.options.ids.next('task')
      const approvalId = this.options.ids.next('approval')
      const task: Task = {
        id: taskId,
        threadKey: decision.threadKey,
        requester: message.sender,
        messageId: message.id,
        title: spec.title.trim(),
        brief: spec.brief ?? message.text,
        requirements: [...(spec.requirements ?? [])],
        status: 'awaiting-approval',
        approvalId,
        assignmentId: null,
        result: null,
        reason: null,
        createdAt: at,
        updatedAt: at,
      }
      const approval: Approval = {
        id: approvalId,
        taskId,
        status: 'pending',
        requestedAt: at,
        expiresAt: new Date(this.options.clock.now().getTime() + ttl).toISOString(),
        decidedAt: null,
        decidedBy: null,
        note: null,
      }
      const created: Decision = {
        ...decision,
        intent: 'task',
        status: 'task_created',
        taskId,
        reason: options.reason ?? null,
        confidence: options.confidence ?? null,
        updatedAt: at,
      }
      this.repos.tasks.save(task)
      this.repos.approvals.save(approval)
      this.repos.decisions.save(created)
      this.repos.threads.save({ ...thread, counts: { ...thread.counts, tasks: thread.counts.tasks + 1 } })
      emit({ type: 'decision.classified', at, data: { decisionId, intent: 'task' } })
      emit({ type: 'task.created', at, data: { taskId, decisionId, threadKey: decision.threadKey } })
      return created
    })
  }

  /** Attach the prepared reply to a classified decision. */
  draft(decisionId: string, draft: Draft): Decision {
    return this.command((emit) => {
      const at = this.now()
      const decision = this.requireDecision(decisionId)
      if (decision.status !== 'classified') throw new UserError('notClassified')
      const drafted: Decision = {
        ...decision,
        status: 'drafted',
        draft: { text: draft.text, researched: draft.researched, sources: [...draft.sources] },
        updatedAt: at,
      }
      this.repos.decisions.save(drafted)
      emit({ type: 'reply.drafted', at, data: { decisionId } })
      return drafted
    })
  }

  /**
   * Queue the drafted reply as an outbound message and move the decision to
   * `sending`. The same `idempotencyKey` always returns the message queued the
   * first time, so a retried command cannot stage a second external message.
   */
  queueReply(decisionId: string, options: QueueReplyOptions): Outbound {
    return this.command((emit) => {
      const at = this.now()
      const decision = this.requireDecision(decisionId)
      const existing = this.repos.outbound.byIdempotencyKey(options.idempotencyKey)
      if (existing) {
        if (decision.outboundId !== existing.id || decision.status === 'drafted') {
          this.repos.decisions.save({
            ...decision,
            status: decision.status === 'drafted' ? 'sending' : decision.status,
            outboundId: existing.id,
            updatedAt: at,
          })
        }
        return existing
      }
      if (decision.status !== 'drafted') throw new UserError('notDrafted')
      const outbound: Outbound = {
        id: options.outboundId,
        idempotencyKey: options.idempotencyKey,
        kind: 'reply',
        target: {
          kind: options.target.kind,
          conversationId: options.target.conversationId,
          ...(options.target.peerUserId ? { peerUserId: options.target.peerUserId } : {}),
        },
        text: options.text,
        status: 'pending',
        attempts: 0,
        lastError: null,
        sentAt: null,
        receipt: null,
      }
      this.repos.outbound.save(outbound)
      this.repos.decisions.save({ ...decision, status: 'sending', outboundId: outbound.id, updatedAt: at })
      emit({
        type: 'reply.queued',
        at,
        data: { decisionId, outboundId: outbound.id, idempotencyKey: outbound.idempotencyKey },
      })
      return outbound
    })
  }

  /**
   * Queue a follow-up message that is not part of a reply decision.
   *
   * Task results and v1 notices need an outbox entry but no Decision: nothing
   * classified them and no inbound message owns them. The thread must exist and
   * the target must address that same kind of conversation, so a follow-up
   * cannot be silently delivered to someone else. The idempotency key is the
   * delivery bound: queueing the same key twice returns the message staged the
   * first time, with no second external message.
   */
  queueFollowup(options: QueueFollowupOptions, timing: FollowupTimingOptions = {}): Outbound {
    return this.command((emit) => {
      const at = timing.at === undefined ? this.now() : this.stamped(timing.at)
      const thread = this.repos.threads.get(options.threadKey)
      if (!thread) throw new UserError('unknownThread')
      const text = options.text
      if (text.trim().length === 0) throw new UserError('emptyOutbound')
      const key = options.idempotencyKey.trim()
      if (key.length === 0) throw new UserError('emptyIdempotencyKey')
      if (options.target.kind !== thread.kind) throw new UserError('outboundTargetMismatch')

      const existing = this.repos.outbound.byIdempotencyKey(key)
      if (existing) return existing

      const outbound: Outbound = {
        id: options.outboundId,
        idempotencyKey: key,
        kind: options.kind,
        target: {
          kind: options.target.kind,
          conversationId: options.target.conversationId,
          ...(options.target.peerUserId ? { peerUserId: options.target.peerUserId } : {}),
        },
        text,
        status: 'pending',
        attempts: 0,
        lastError: null,
        sentAt: null,
        receipt: null,
      }
      this.repos.outbound.save(outbound)
      emit({
        type: 'outbound.queued',
        at,
        data: { outboundId: outbound.id, threadKey: thread.key, outboundKind: outbound.kind },
      })
      return outbound
    })
  }

  /**
   * Record a confirmed delivery of a follow-up.
   *
   * Only a `pending` row changes: a terminal row keeps its first outcome, so a
   * duplicate report after a restart cannot rewrite delivery history.
   */
  outboundSent(id: string, receipt?: string): Outbound {
    return this.command((emit) => {
      const outbound = this.requireOutbound(id)
      if (outbound.status !== 'pending') return outbound
      const at = this.now()
      const sent: Outbound = { ...outbound, status: 'sent', sentAt: at, receipt: receipt ?? null, lastError: null }
      this.repos.outbound.save(sent)
      emit({ type: 'outbound.sent', at, data: { outboundId: id } })
      return sent
    })
  }

  /** Delivery could not be proven. Terminal, and never retried automatically. */
  outboundUnknown(id: string, error: string): Outbound {
    return this.command((emit) => {
      const outbound = this.requireOutbound(id)
      if (outbound.status !== 'pending') return outbound
      const at = this.now()
      const unknown: Outbound = {
        ...outbound,
        status: 'unknown',
        attempts: outbound.attempts + 1,
        lastError: error,
      }
      this.repos.outbound.save(unknown)
      emit({ type: 'outbound.unknown', at, data: { outboundId: id, error } })
      return unknown
    })
  }

  /** Delivery definitely failed. Terminal until a person decides what to do. */
  outboundFailed(id: string, error: string): Outbound {
    return this.command((emit) => {
      const outbound = this.requireOutbound(id)
      if (outbound.status !== 'pending') return outbound
      const at = this.now()
      const failed: Outbound = {
        ...outbound,
        status: 'failed',
        attempts: outbound.attempts + 1,
        lastError: error,
      }
      this.repos.outbound.save(failed)
      emit({ type: 'outbound.failed', at, data: { outboundId: id, error } })
      return failed
    })
  }

  /** Drop a follow-up that can never be delivered, such as one whose thread is gone. */
  outboundDropped(id: string, reason: string): Outbound {
    return this.command((emit) => {
      const outbound = this.requireOutbound(id)
      if (outbound.status !== 'pending') return outbound
      const at = this.now()
      const dropped: Outbound = { ...outbound, status: 'dropped', lastError: reason }
      this.repos.outbound.save(dropped)
      emit({ type: 'outbound.dropped', at, data: { outboundId: id, reason } })
      return dropped
    })
  }

  /** The channel confirmed delivery: the decision is `sent` and the thread counts one reply. */
  replySent(decisionId: string, receipt?: string): Decision {
    return this.command((emit) => {
      const at = this.now()
      const decision = this.requireDecision(decisionId)
      if (decision.status !== 'sending') throw new UserError('notSending')
      const outbound = this.requireOutboundOf(decision)
      const thread = this.repos.threads.get(decision.threadKey)
      if (!thread) throw new UserError('unknownThread')
      this.repos.outbound.save({ ...outbound, status: 'sent', sentAt: at, receipt: receipt ?? null, lastError: null })
      this.repos.threads.save({
        ...thread,
        counts: { ...thread.counts, replied: thread.counts.replied + 1 },
      })
      const sent: Decision = { ...decision, status: 'sent', updatedAt: at }
      this.repos.decisions.save(sent)
      emit({ type: 'reply.sent', at, data: { decisionId, outboundId: outbound.id } })
      return sent
    })
  }

  /**
   * The channel could not confirm delivery: the decision and its outbound
   * message stay `send_unknown`/`unknown`, which is terminal. Nothing resends
   * them automatically; a person must reconcile the channel, and only an
   * explicit retry command (added by WS4/WS5) may try again.
   */
  replyUnknown(decisionId: string, error: string): Decision {
    return this.command((emit) => {
      const at = this.now()
      const decision = this.requireDecision(decisionId)
      if (decision.status !== 'sending') throw new UserError('notSending')
      const outbound = this.requireOutboundOf(decision)
      this.repos.outbound.save({
        ...outbound,
        status: 'unknown',
        attempts: outbound.attempts + 1,
        lastError: error,
      })
      const unknown: Decision = { ...decision, status: 'send_unknown', attempts: decision.attempts + 1, updatedAt: at }
      this.repos.decisions.save(unknown)
      emit({ type: 'reply.unknown', at, data: { decisionId, outboundId: outbound.id, error } })
      return unknown
    })
  }

  /** Delivery failed and will not be retried by the decision itself. */
  replyFailed(decisionId: string, error: string): Decision {
    return this.command((emit) => {
      const at = this.now()
      const decision = this.requireDecision(decisionId)
      if (decision.status !== 'sending') throw new UserError('notSending')
      const outbound = this.requireOutboundOf(decision)
      this.repos.outbound.save({
        ...outbound,
        status: 'failed',
        attempts: outbound.attempts + 1,
        lastError: error,
      })
      const failed: Decision = { ...decision, status: 'send_failed', attempts: decision.attempts + 1, updatedAt: at }
      this.repos.decisions.save(failed)
      emit({ type: 'reply.failed', at, data: { decisionId, outboundId: outbound.id, error } })
      return failed
    })
  }

  /** Put a queued or classified decision aside, recording why. */
  defer(decisionId: string, reason: string): Decision {
    return this.command(() => {
      const at = this.now()
      const decision = this.requireDecision(decisionId)
      if (decision.status !== 'queued' && decision.status !== 'classified') throw new UserError('notDeferrable')
      const deferred: Decision = { ...decision, status: 'deferred', reason, updatedAt: at }
      this.repos.decisions.save(deferred)
      return deferred
    })
  }

  // Approval gate

  /**
   * The owner approves an awaiting task. The approval, the approved task and
   * its pending assignment are written together, so a task is never approved
   * without a record of who approved it or a workspace to run in.
   */
  approveTask(taskId: string, options: ApproveOptions): { task: Task; approval: Approval; assignment: Assignment } {
    return this.command((emit) => {
      const at = this.now()
      const task = this.requireTask(taskId)
      const approval = this.requireApprovalOf(task)
      if (approval.status !== 'pending') throw new UserError('alreadyDecided')
      if (task.status !== 'awaiting-approval') throw new UserError('notAwaitingApproval')
      if (this.instant(options.at) >= this.instant(approval.expiresAt)) throw new UserError('approvalExpired')
      if (options.workspace.trim().length === 0) throw new UserError('missingWorkspace')
      const decided: Approval = {
        ...approval,
        status: 'approved',
        decidedAt: options.at,
        decidedBy: options.by,
        note: options.note ?? null,
      }
      const assignment: Assignment = {
        id: this.options.ids.next('assignment'),
        taskId,
        state: 'pending',
        sessionId: null,
        workspace: options.workspace,
        startedAt: null,
        endedAt: null,
        outcome: null,
        error: null,
      }
      const approved: Task = { ...task, status: 'approved', assignmentId: assignment.id, updatedAt: at }
      this.repos.approvals.save(decided)
      this.repos.assignments.save(assignment)
      this.repos.tasks.save(approved)
      emit({
        type: 'task.approved',
        at,
        data: { taskId, approvalId: approval.id, assignmentId: assignment.id },
      })
      return { task: approved, approval: decided, assignment }
    })
  }

  /** The owner rejects an awaiting task; no assignment is created. */
  rejectTask(taskId: string, options: RejectOptions): { task: Task; approval: Approval } {
    return this.command((emit) => {
      const at = this.now()
      const task = this.requireTask(taskId)
      const approval = this.requireApprovalOf(task)
      if (approval.status !== 'pending') throw new UserError('alreadyDecided')
      if (task.status !== 'awaiting-approval') throw new UserError('notAwaitingApproval')
      const decided: Approval = {
        ...approval,
        status: 'rejected',
        decidedAt: options.at,
        decidedBy: options.by,
        note: options.note ?? null,
      }
      const rejected: Task = { ...task, status: 'rejected', updatedAt: at }
      this.repos.approvals.save(decided)
      this.repos.tasks.save(rejected)
      emit({ type: 'task.rejected', at, data: { taskId, approvalId: approval.id } })
      return { task: rejected, approval: decided }
    })
  }

  /**
   * A person cancels a task that is awaiting approval, approved or running.
   * A cancellation closes the approval request and ends the task's assignment,
   * so a late executor report cannot revive it.
   */
  cancelTask(taskId: string, options: CancelOptions): Task {
    return this.command((emit) => {
      const at = this.now()
      const task = this.requireTask(taskId)
      if (task.status !== 'awaiting-approval' && task.status !== 'approved' && task.status !== 'running') {
        throw new UserError('notCancellable')
      }
      const approval = this.repos.approvals.byTaskId(taskId)
      if (approval && approval.status === 'pending') {
        this.repos.approvals.save({
          ...approval,
          status: 'expired',
          decidedAt: options.at,
          decidedBy: options.by,
          note: options.reason ?? null,
        })
      }
      if (task.assignmentId) {
        const assignment = this.repos.assignments.get(task.assignmentId)
        if (assignment && assignment.state !== 'ended') {
          this.repos.assignments.save({
            ...assignment,
            state: 'ended',
            endedAt: at,
            outcome: 'cancelled',
            error: options.reason ?? assignment.error,
          })
        }
      }
      const cancelled: Task = {
        ...task,
        status: 'cancelled',
        reason: options.reason ?? null,
        updatedAt: at,
      }
      this.repos.tasks.save(cancelled)
      emit({ type: 'task.cancelled', at, data: { taskId, reason: options.reason ?? '' } })
      return cancelled
    })
  }

  /**
   * A person retries a failed task.
   *
   * A retry is a new assignment, not a revival: the task keeps its result (the
   * executor quotes the previous summary as context for the fresh session), its
   * original approval stays `approved`, and a new pending assignment becomes
   * the task's current one. Only `failed` qualifies; a cancelled task was ended
   * on purpose and is never retried implicitly.
   */
  retryTask(taskId: string, options: RetryOptions): { task: Task; assignment: Assignment } {
    return this.command((emit) => {
      const at = this.now()
      const task = this.requireTask(taskId)
      if (task.status !== 'failed') throw new UserError('notFailed')
      this.instant(options.at)
      if (options.workspace.trim().length === 0) throw new UserError('missingWorkspace')
      const workspace = options.workspace.trim()
      if (!isAbsolutePath(workspace)) throw new UserError('invalidWorkspace')
      const approval = this.repos.approvals.byTaskId(taskId)
      if (!approval) throw new UserError('unknownApproval')
      if (approval.status !== 'approved') throw new UserError('notApproved')

      const assignment: Assignment = {
        id: this.options.ids.next('assignment'),
        taskId,
        state: 'pending',
        sessionId: null,
        workspace,
        startedAt: null,
        endedAt: null,
        outcome: null,
        error: null,
      }
      const retried: Task = {
        ...task,
        status: 'approved',
        assignmentId: assignment.id,
        updatedAt: at,
      }
      this.repos.assignments.save(assignment)
      this.repos.tasks.save(retried)
      emit({ type: 'task.retried', at, data: { taskId, assignmentId: assignment.id } })
      return { task: retried, assignment }
    })
  }

  /**
   * Expire every pending approval whose `expiresAt` has passed, together with
   * its still-awaiting task. A second sweep over an unchanged clock returns an
   * empty list, because the approvals are no longer pending.
   */
  expireTasks(now: IsoTime | Date): readonly string[] {
    return this.command((emit) => {
      const at = this.now()
      const cutoff = this.instant(now)
      const expired: string[] = []
      for (const approval of this.repos.approvals.listPending()) {
        const expiresAt = this.storedInstant(approval.expiresAt)
        if (expiresAt === null || expiresAt > cutoff) continue
        const task = this.repos.tasks.get(approval.taskId)
        if (!task || task.status !== 'awaiting-approval') continue
        this.repos.approvals.save({ ...approval, status: 'expired' })
        this.repos.tasks.save({ ...task, status: 'expired', updatedAt: at })
        emit({ type: 'task.expired', at, data: { taskId: task.id, approvalId: approval.id } })
        expired.push(task.id)
      }
      return expired
    })
  }

  // Execution

  /**
   * The executor started the pending assignment of an approved task, optionally
   * binding the session it runs. The session is kept when the assignment ends,
   * so the panel can still find the conversation that did the work.
   */
  assignmentStarted(taskId: string, assignmentId: string, options: AssignmentStartOptions = {}): Assignment {
    return this.command((emit) => {
      const at = this.now()
      const task = this.requireTask(taskId)
      if (task.status !== 'approved') throw new UserError('notApproved')
      const assignment = this.requireAssignmentOf(task, assignmentId)
      if (assignment.state !== 'pending') throw new UserError('assignmentNotPending')
      const sessionId = options.sessionId?.trim() ? options.sessionId.trim() : null
      const running: Assignment = { ...assignment, state: 'running', sessionId, startedAt: at }
      const started: Task = { ...task, status: 'running', updatedAt: at }
      this.repos.assignments.save(running)
      this.repos.tasks.save(started)
      emit({ type: 'assignment.started', at, data: { taskId, assignmentId } })
      return running
    })
  }

  /**
   * The executor finished an assignment. Only the assignment the task points at
   * may report, and only while the task is running; anything else is refused
   * without changing state, so a late report cannot revive a cancelled task.
   */
  assignmentEnded(
    taskId: string,
    assignmentId: string,
    options: EndAssignmentOptions,
  ): { task: Task; assignment: Assignment } {
    return this.command((emit) => {
      const at = this.now()
      const task = this.requireTask(taskId)
      if (task.status !== 'running') throw new UserError('notRunning')
      const assignment = this.requireAssignmentOf(task, assignmentId)
      if (assignment.state !== 'running') throw new UserError('assignmentNotRunning')
      const ended: Assignment = {
        ...assignment,
        state: 'ended',
        endedAt: at,
        outcome: options.outcome,
        error: null,
      }
      const finished: Task = {
        ...task,
        status: options.outcome === 'succeeded' ? 'succeeded' : 'failed',
        result: options.result ?? null,
        updatedAt: at,
      }
      this.repos.assignments.save(ended)
      this.repos.tasks.save(finished)
      emit({ type: 'assignment.ended', at, data: { taskId, assignmentId, outcome: options.outcome } })
      return { task: finished, assignment: ended }
    })
  }

  // Queries (read-only, no transaction)

  thread(key: string): Thread | undefined {
    return this.repos.threads.get(key)
  }

  decision(id: string): Decision | undefined {
    return this.repos.decisions.get(id)
  }

  task(id: string): Task | undefined {
    return this.repos.tasks.get(id)
  }

  /** Tasks a person may still act on: awaiting approval, approved or running. */
  openTasks(): readonly Task[] {
    return this.repos.tasks.open()
  }

  /** Approvals that are pending and still actionable at `now`. */
  pendingApprovals(now: IsoTime | Date): readonly Approval[] {
    const cutoff = this.instant(now)
    return this.repos.approvals.listPending().filter((approval) => {
      const expiresAt = this.storedInstant(approval.expiresAt)
      return expiresAt !== null && expiresAt > cutoff
    })
  }

  /** Follow-up messages still waiting for delivery; the outbox resume pass reads this. */
  pendingOutbounds(): readonly Outbound[] {
    return this.repos.outbound.pending()
  }

  // Helpers

  private now(): IsoTime {
    return this.options.clock.now().toISOString()
  }

  /**
   * Compare instants as epoch milliseconds, never as ISO strings: callers may
   * send an offset such as `+08:00`, which does not sort against `Z` text.
   * A caller-supplied time that does not parse is refused.
   */
  private instant(value: IsoTime | Date): number {
    const time = value instanceof Date ? value.getTime() : Date.parse(value)
    if (!Number.isFinite(time)) throw new UserError('invalidTime')
    return time
  }

  /** A stored instant that a sweep skips instead of trusting when it cannot parse. */
  private storedInstant(value: IsoTime): number | null {
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
  }

  /** Validate a caller-supplied instant and echo it back for an event stamp. */
  private stamped(value: IsoTime): IsoTime {
    this.instant(value)
    return value
  }

  private command<T>(work: (emit: Emit) => T): T {
    const events: DomainEvent[] = []
    const value = this.repos.atomic(() =>
      work((event) => {
        events.push(event)
      }),
    )
    for (const event of events) {
      try {
        this.options.emit?.(event)
      } catch {
        // Observers are best-effort: the command already committed.
      }
    }
    return value
  }

  private requireDecision(id: string): Decision {
    const decision = this.repos.decisions.get(id)
    if (!decision) throw new UserError('unknownDecision')
    return decision
  }

  private requireTask(id: string): Task {
    const task = this.repos.tasks.get(id)
    if (!task) throw new UserError('unknownTask')
    return task
  }

  private requireApprovalOf(task: Task): Approval {
    if (!task.approvalId) throw new UserError('unknownApproval')
    const approval = this.repos.approvals.get(task.approvalId)
    if (!approval) throw new UserError('unknownApproval')
    return approval
  }

  private requireAssignmentOf(task: Task, assignmentId: string): Assignment {
    if (task.assignmentId !== assignmentId) throw new UserError('assignmentMismatch')
    const assignment = this.repos.assignments.get(assignmentId)
    if (!assignment) throw new UserError('unknownAssignment')
    return assignment
  }

  private requireOutboundOf(decision: Decision): Outbound {
    if (!decision.outboundId) throw new UserError('outboundMissing')
    return this.requireOutbound(decision.outboundId)
  }

  private requireOutbound(id: string): Outbound {
    const outbound = this.repos.outbound.get(id)
    if (!outbound) throw new UserError('unknownOutbound')
    return outbound
  }
}

/** A thread created by the first message of a conversation. */
function newThread(message: InboundMessage, createdAt: IsoTime): Thread {
  const title = message.title?.trim()
  return {
    key: message.threadKey,
    targetId: message.targetId,
    kind: message.kind,
    title: title && title.length > 0 ? title : message.kind === 'dm' ? message.sender.nick : message.targetId,
    peer: message.kind === 'dm' ? message.sender : null,
    lastMessageAt: message.at,
    createdAt,
    counts: { inbound: 1, replied: 0, tasks: 0 },
  }
}

/** An existing thread that received another message, including a renamed conversation. */
function advanceThread(thread: Thread, message: InboundMessage): Thread {
  const title = message.title?.trim()
  return {
    ...thread,
    ...(title && title.length > 0 && title !== thread.title ? { title } : {}),
    lastMessageAt: message.at > thread.lastMessageAt ? message.at : thread.lastMessageAt,
    counts: { ...thread.counts, inbound: thread.counts.inbound + 1 },
  }
}

/**
 * Whether a workspace path is absolute on the platform that produced it.
 *
 * `src/core` may not import `node:path`, so this accepts the three forms the
 * domain can meet: a POSIX path, a Windows drive path and a UNC share. The
 * executor repeats the check with the host's own path module before it creates
 * anything; the domain refuses early so a refused retry leaves no write behind.
 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}
