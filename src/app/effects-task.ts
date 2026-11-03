/**
 * Task-path effects: start an approved assignment, report its result back to
 * the conversation it came from, and keep the channel's authorization fresh.
 *
 * The approval gate is enforced twice: the domain only creates an assignment
 * for an approved task, and this handler re-checks the task, the approval and
 * the assignment before it asks the executor for a session. A task therefore
 * never runs because a stale effect row survived a restart.
 *
 * A result is reported, never invented: a failed, timed-out or cancelled run
 * produces a local notice only. Only a succeeded run queues a follow-up
 * message, and that message goes through the same outbox and `send` handler as
 * a reply.
 */
import type { Clock, Task } from '../core/index.ts'
import { UserError } from '../core/index.ts'
import { isExecutorError, type ExecutorResult, type TaskExecutor } from '../executor/index.ts'
import { Later, type Effects } from './effects.ts'
import type { SettingsService } from './settings.ts'
import type { Store } from './store.ts'
import type { Engine } from '../core/index.ts'
import { latestMessage, threadTarget } from './thread-state.ts'
import type { NoticePayload } from './effects-chat.ts'

/** Longest worker summary quoted back into the chat. */
export const FOLLOWUP_SUMMARY_CHARS = 800

interface LaunchPayload {
  readonly taskId?: string
  readonly assignmentId?: string
}

export interface TaskEffectDeps {
  readonly engine: Engine
  readonly store: Store
  readonly settings: SettingsService
  readonly effects: Effects
  readonly clock: Clock
  readonly executor: TaskExecutor
  readonly lifetime: AbortSignal
  readonly ids: { next(prefix: string): string }
  /** Probe authorization and reconcile the channel; implemented by the runtime. */
  readonly probe: () => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const found = value[key]
  return typeof found === 'string' && found.length > 0 ? found : undefined
}

/** The short Chinese template a finished task posts back to its thread. */
export function renderFollowup(task: Task, summary: string, sessionId: string | undefined): string {
  const text = summary.trim().replace(/\s+/gu, ' ').slice(0, FOLLOWUP_SUMMARY_CHARS)
  const lines = [`任务「${task.title}」已完成。`, text.length > 0 ? text : '这次没有文字汇报，详情可以在面板里查看。']
  if (sessionId !== undefined && sessionId.trim().length > 0) lines.push(`会话：${sessionId.trim()}`)
  return lines.join('\n')
}

/** Register every task-path handler on the shared queue. */
export class TaskEffects {
  private readonly active = new Set<string>()

  constructor(private readonly deps: TaskEffectDeps) {}

  register(): void {
    this.deps.effects.handle('launch', (payload, key) => this.launch(payload, key))
    this.deps.effects.handle('finish', (payload, key) => this.finish(payload, key))
    this.deps.effects.handle('probe', () => this.deps.probe())
    this.deps.effects.handle('notify', (payload, key) => this.notify(payload, key))
  }

  /** Tasks whose executor run is currently in flight; the health view reports them. */
  running(): readonly string[] {
    return [...this.active]
  }

  /** Start one approved assignment, bounded by `tasks.maxConcurrent`. */
  private async launch(payload: unknown, key: string): Promise<void> {
    const taskId = readString(payload, 'taskId') ?? key
    const task = this.deps.engine.task(taskId)
    if (!task) return
    if (task.status !== 'approved') {
      // Only an awaiting task is a launch that should have had an approval; a
      // running/succeeded row is a duplicate and returns quietly.
      if (task.status === 'awaiting-approval') {
        this.notice({ kind: 'task_launch_refused', taskId, reason: 'not_approved' })
      }
      return
    }

    const settings = this.deps.settings.current()
    if (!settings.tasks.enabled) {
      this.notice({ kind: 'task_launch_refused', taskId, reason: 'tasks_disabled' })
      return
    }
    const approval = task.approvalId === null ? undefined : this.deps.store.approvals.get(task.approvalId)
    if (!approval || approval.status !== 'approved' || approval.taskId !== task.id) {
      this.notice({ kind: 'task_launch_refused', taskId, reason: 'not_approved' })
      return
    }
    const assignmentId = task.assignmentId
    const assignment = assignmentId === null ? undefined : this.deps.store.assignments.get(assignmentId)
    if (!assignmentId || !assignment || assignment.state !== 'pending') {
      this.notice({ kind: 'task_launch_refused', taskId, reason: 'no_pending_assignment' })
      return
    }
    const requested = readString(payload, 'assignmentId')
    if (requested !== undefined && requested !== assignmentId) {
      this.notice({ kind: 'task_launch_refused', taskId, reason: 'assignment_mismatch' })
      return
    }
    if (this.active.size >= settings.tasks.maxConcurrent) throw new Later('task concurrency limit reached')

    this.active.add(taskId)
    try {
      const result = await this.deps.executor.execute({
        task,
        approval,
        settings,
        workspace: assignment.workspace,
        signal: this.deps.lifetime,
      })
      this.afterRun(task, assignmentId, result)
    } catch (error) {
      if (error instanceof UserError) {
        this.notice({ kind: 'task_launch_refused', taskId, reason: error.code })
        return
      }
      if (isExecutorError(error)) {
        this.notice({ kind: 'task_launch_failed', taskId, reason: error.code })
        return
      }
      throw error
    } finally {
      this.active.delete(taskId)
    }
  }

  /** A succeeded run is reported to its thread; anything else stays a local notice. */
  private afterRun(task: Task, assignmentId: string, result: ExecutorResult): void {
    if (result.outcome !== 'succeeded') {
      this.notice({ kind: 'task_failed', taskId: task.id, reason: result.outcome })
      return
    }
    this.deps.effects.enqueue('finish', task.id, {
      taskId: task.id,
      assignmentId,
      summary: result.summary,
      sessionId: result.sessionId,
    })
  }

  /** Queue one short result message on the task's original thread. */
  private async finish(payload: unknown, key: string): Promise<void> {
    const taskId = readString(payload, 'taskId') ?? key
    const task = this.deps.engine.task(taskId)
    if (!task || task.status !== 'succeeded') return
    const assignmentId = readString(payload, 'assignmentId') ?? task.assignmentId ?? 'initial'
    const thread = this.deps.engine.thread(task.threadKey)
    if (!thread) return
    const message = latestMessage(this.deps.store, thread.key)
    const target = threadTarget(thread, message)
    if (!target) {
      this.notice({ kind: 'task_followup_dropped', taskId, reason: 'no_target' })
      return
    }
    const summary = readString(payload, 'summary') ?? task.result?.summary ?? ''
    const sessionId = readString(payload, 'sessionId') ?? task.result?.sessionId
    const text = renderFollowup(task, summary, sessionId)
    const outbound = this.deps.engine.queueFollowup(
      {
        threadKey: thread.key,
        target,
        text,
        idempotencyKey: `task-finish:${task.id}:${assignmentId}`,
        kind: 'reply',
        outboundId: this.deps.ids.next('outbound'),
      },
      { at: this.deps.clock.now().toISOString() },
    )
    this.deps.effects.enqueue('send', outbound.id, { outboundId: outbound.id, threadKey: thread.key })
  }

  /**
   * v1 notice: one audit row, no DSH inbox conversation and no chat message.
   *
   * Only stable identifiers and codes are stored, never a message body or a
   * worker summary.
   */
  private notify(payload: unknown, key: string): void {
    const recorded: NoticePayload = { kind: readString(payload, 'kind') ?? 'notice' }
    const threadKey = readString(payload, 'threadKey')
    const decisionId = readString(payload, 'decisionId')
    const outboundId = readString(payload, 'outboundId')
    const taskId = readString(payload, 'taskId')
    const reason = readString(payload, 'reason')
    const at = this.deps.clock.now().toISOString()
    this.deps.store.appendEvent('notice', at, {
      ...recorded,
      ...(threadKey === undefined ? {} : { threadKey }),
      ...(decisionId === undefined ? {} : { decisionId }),
      ...(outboundId === undefined ? {} : { outboundId }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(reason === undefined ? {} : { reason }),
      key,
    })
  }

  private notice(payload: NoticePayload): void {
    this.deps.effects.enqueue(
      'notify',
      `${payload.kind}:${payload.taskId ?? payload.outboundId ?? payload.decisionId ?? 'x'}`,
      payload,
    )
  }
}
