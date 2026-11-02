import { describe, expect, it } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { THREAD_KEY, createHarness, receiveDraft, receiveTask } from './fixtures/domain.ts'

describe('domain invariants', () => {
  it('1. deduplicates an inbound message by id and counts it once', () => {
    const harness = createHarness()
    const first = harness.receive({ id: 'message-dup' })
    const second = harness.receive({ id: 'message-dup' })

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.decision.id).toBe(first.decision.id)
    expect(harness.repos.listDecisions()).toHaveLength(1)
    expect(harness.engine.thread(THREAD_KEY)?.counts.inbound).toBe(1)
  })

  it('2. approves only an awaiting task and never creates a second assignment', () => {
    const harness = createHarness()
    const first = receiveTask(harness, { id: 'message-approve' })
    harness.engine.approveTask(first.task.id, {
      by: 'owner',
      at: '2026-11-02T09:00:05.000Z',
      workspace: '/workspace/first',
    })
    expect(() =>
      harness.engine.approveTask(first.task.id, {
        by: 'owner',
        at: '2026-11-02T09:00:06.000Z',
        workspace: '/workspace/first',
      }),
    ).toThrowError(expect.objectContaining({ code: 'alreadyDecided' }))
    expect(harness.repos.listAssignments()).toHaveLength(1)

    const rejected = receiveTask(harness, { id: 'message-reject' })
    harness.engine.rejectTask(rejected.task.id, { by: 'owner', at: '2026-11-02T09:00:05.000Z' })
    expect(() =>
      harness.engine.approveTask(rejected.task.id, {
        by: 'owner',
        at: '2026-11-02T09:00:06.000Z',
        workspace: '/workspace/rejected',
      }),
    ).toThrowError(expect.objectContaining({ code: 'alreadyDecided' }))
    expect(harness.repos.listAssignments()).toHaveLength(1)
  })

  it('3. refuses to start an assignment for a task that is not approved', () => {
    const harness = createHarness()
    const { task } = receiveTask(harness)
    expect(harness.engine.task(task.id)?.status).toBe('awaiting-approval')
    expect(() => harness.engine.assignmentStarted(task.id, 'assignment-forged')).toThrowError(
      expect.objectContaining({ code: 'notApproved' }),
    )
    expect(harness.engine.task(task.id)?.status).toBe('awaiting-approval')
    expect(harness.repos.listAssignments()).toEqual([])
  })

  it('4. refuses an assignment report that does not match the running task', () => {
    const harness = createHarness()
    const { task } = receiveTask(harness)
    const approved = harness.engine.approveTask(task.id, {
      by: 'owner',
      at: '2026-11-02T09:00:05.000Z',
      workspace: '/workspace/task',
    })

    expect(() => harness.engine.assignmentEnded(task.id, 'assignment-forged', { outcome: 'succeeded' })).toThrowError(
      expect.objectContaining({ code: 'notRunning' }),
    )
    expect(harness.engine.task(task.id)?.status).toBe('approved')

    harness.engine.assignmentStarted(task.id, approved.assignment.id)
    expect(() => harness.engine.assignmentEnded(task.id, 'assignment-forged', { outcome: 'succeeded' })).toThrowError(
      expect.objectContaining({ code: 'assignmentMismatch' }),
    )
    expect(harness.engine.task(task.id)?.status).toBe('running')
    expect(harness.repos.assignments.get(approved.assignment.id)?.state).toBe('running')

    harness.engine.assignmentEnded(task.id, approved.assignment.id, { outcome: 'succeeded' })
    expect(() =>
      harness.engine.assignmentEnded(task.id, approved.assignment.id, { outcome: 'succeeded' }),
    ).toThrowError(expect.objectContaining({ code: 'notRunning' }))
  })

  it('5. queues one outbound message per idempotency key', () => {
    const harness = createHarness()
    const { decision } = harness.receive({ id: 'message-idempotent' })
    harness.engine.classify(decision.id, { intent: 'chat' })
    harness.engine.draft(decision.id, { text: '一次即可', researched: false, sources: [] })
    const first = harness.engine.queueReply(decision.id, {
      outboundId: 'outbound-a',
      idempotencyKey: 'reply:message-idempotent',
      text: '一次即可',
      target: { kind: 'at-me', conversationId: 'conv-1' },
    })
    const second = harness.engine.queueReply(decision.id, {
      outboundId: 'outbound-b',
      idempotencyKey: 'reply:message-idempotent',
      text: '一次即可',
      target: { kind: 'at-me', conversationId: 'conv-1' },
    })
    expect(second.id).toBe(first.id)
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(harness.repos.listOutbound()).toHaveLength(1)
  })

  it('6. rolls back a task classification that lacks an approval TTL', () => {
    const harness = createHarness()
    const { decision } = harness.receive({ id: 'message-no-ttl' })
    const error = capture(() =>
      harness.engine.classify(decision.id, { intent: 'task', task: { title: '没有期限的任务' } }),
    )
    expect(error).toBeInstanceOf(UserError)
    expect((error as UserError).code).toBe('missingApprovalTtl')
    expect(harness.repos.listTasks()).toEqual([])
    expect(harness.repos.listApprovals()).toEqual([])
    expect(harness.engine.decision(decision.id)).toMatchObject({ status: 'queued', taskId: null })
    expect(harness.engine.thread(THREAD_KEY)?.counts.tasks).toBe(0)
    expect(harness.engine.openTasks()).toEqual([])
  })

  it('6b. rolls back the writes of a command that fails in the middle', () => {
    const harness = createHarness()
    const { decision } = harness.receive({ id: 'message-mid-failure' })
    const saveApproval = harness.repos.approvals.save
    let writes = 0
    harness.repos.approvals.save = (approval) => {
      writes += 1
      if (writes === 1) throw new Error('disk full')
      saveApproval(approval)
    }
    expect(() =>
      harness.engine.classify(decision.id, {
        intent: 'task',
        task: { title: '会中途失败的任务' },
        approvalTtlMs: 60_000,
      }),
    ).toThrow('disk full')
    expect(writes).toBe(1)
    expect(harness.repos.listTasks()).toEqual([])
    expect(harness.repos.listApprovals()).toEqual([])
    expect(harness.engine.decision(decision.id)).toMatchObject({ status: 'queued', taskId: null })
    expect(harness.engine.thread(THREAD_KEY)?.counts.tasks).toBe(0)
    expect(harness.engine.openTasks()).toEqual([])
  })

  it('7. expires only overdue pending approvals and stays idempotent', () => {
    const harness = createHarness()
    const short = receiveTask(harness, { id: 'message-short' }, { title: 'short' }, 1_000)
    const long = receiveTask(harness, { id: 'message-long' }, { title: 'long' }, 60_000)

    expect(harness.engine.expireTasks('2026-11-02T09:00:00.999Z')).toEqual([])
    expect(harness.engine.task(short.task.id)?.status).toBe('awaiting-approval')

    const expired = harness.engine.expireTasks('2026-11-02T09:00:01.000Z')
    expect(expired).toEqual([short.task.id])
    expect(harness.engine.task(short.task.id)?.status).toBe('expired')
    expect(harness.repos.approvals.byTaskId(short.task.id)?.status).toBe('expired')
    expect(harness.engine.task(long.task.id)?.status).toBe('awaiting-approval')
    expect(harness.repos.approvals.byTaskId(long.task.id)?.status).toBe('pending')

    expect(harness.engine.expireTasks('2026-11-02T09:00:01.000Z')).toEqual([])
    expect(harness.engine.task(short.task.id)?.status).toBe('expired')
  })

  it('8. cancels a running task and refuses to revive it through its assignment', () => {
    const harness = createHarness()
    const { task } = receiveTask(harness)
    const approved = harness.engine.approveTask(task.id, {
      by: 'owner',
      at: '2026-11-02T09:00:05.000Z',
      workspace: '/workspace/task',
    })
    harness.engine.assignmentStarted(task.id, approved.assignment.id)
    const cancelled = harness.engine.cancelTask(task.id, {
      by: 'owner',
      reason: 'owner stopped it',
      at: '2026-11-02T09:00:09.000Z',
    })

    expect(cancelled.status).toBe('cancelled')
    expect(harness.repos.assignments.get(approved.assignment.id)).toMatchObject({
      state: 'ended',
      outcome: 'cancelled',
    })
    expect(() =>
      harness.engine.assignmentEnded(task.id, approved.assignment.id, { outcome: 'succeeded' }),
    ).toThrowError(expect.objectContaining({ code: 'notRunning' }))
    expect(harness.engine.task(task.id)?.status).toBe('cancelled')
    expect(harness.repos.assignments.get(approved.assignment.id)?.outcome).toBe('cancelled')
  })

  it('9. increments every thread counter exactly once per domain event', () => {
    const harness = createHarness()
    harness.receive({ id: 'message-1' })
    harness.receive({ id: 'message-2' })
    receiveTask(harness, { id: 'message-3' })
    const reply = receiveDraft(harness, { id: 'message-4' })
    harness.engine.replySent(reply.decision.id)

    expect(harness.engine.thread(THREAD_KEY)?.counts).toEqual({ inbound: 4, replied: 1, tasks: 1 })
    expect(harness.repos.listDecisions()).toHaveLength(4)
    expect(harness.repos.listTasks()).toHaveLength(1)
    expect(harness.repos.listOutbound()).toHaveLength(1)
  })

  it('10. stamps every command with the injected clock', () => {
    const harness = createHarness()
    const { decision } = harness.receive({ id: 'message-clock' })
    expect(decision.updatedAt).toBe('2026-11-02T09:00:00.000Z')

    harness.clock.set('2026-11-02T10:00:00.000Z')
    const classified = harness.engine.classify(decision.id, { intent: 'chat' })
    expect(classified.updatedAt).toBe('2026-11-02T10:00:00.000Z')

    harness.clock.set('2026-11-02T11:00:00.000Z')
    const drafted = harness.engine.draft(decision.id, { text: '好', researched: false, sources: [] })
    expect(drafted.updatedAt).toBe('2026-11-02T11:00:00.000Z')

    harness.clock.set('2026-11-02T12:00:00.000Z')
    harness.engine.queueReply(decision.id, {
      outboundId: 'outbound-clock',
      idempotencyKey: 'reply:message-clock',
      text: '好',
      target: { kind: 'at-me', conversationId: 'conv-1' },
    })
    expect(harness.engine.decision(decision.id)?.updatedAt).toBe('2026-11-02T12:00:00.000Z')

    harness.clock.set('2026-11-02T13:00:00.000Z')
    const sent = harness.engine.replySent(decision.id)
    expect(sent.updatedAt).toBe('2026-11-02T13:00:00.000Z')

    const taskFlow = receiveTask(harness, { id: 'message-clock-task' }, { title: 'clock' }, 3_600_000)
    harness.clock.set('2026-11-02T14:00:00.000Z')
    const approved = harness.engine.approveTask(taskFlow.task.id, {
      by: 'owner',
      at: '2026-11-02T13:30:00.000Z',
      workspace: '/workspace/clock',
    })
    expect(approved.task.updatedAt).toBe('2026-11-02T14:00:00.000Z')
    expect(approved.approval.decidedAt).toBe('2026-11-02T13:30:00.000Z')

    harness.clock.set('2026-11-02T15:00:00.000Z')
    harness.engine.assignmentStarted(taskFlow.task.id, approved.assignment.id)
    expect(harness.engine.task(taskFlow.task.id)?.updatedAt).toBe('2026-11-02T15:00:00.000Z')
    expect(harness.repos.assignments.get(approved.assignment.id)?.startedAt).toBe('2026-11-02T15:00:00.000Z')

    harness.clock.set('2026-11-02T16:00:00.000Z')
    const expiredTask = receiveTask(harness, { id: 'message-clock-expire' }, { title: 'expire' }, 1_000)
    harness.clock.set('2026-11-02T17:00:00.000Z')
    expect(harness.engine.expireTasks('2026-11-02T16:30:00.000Z')).toEqual([expiredTask.task.id])
    expect(harness.engine.task(expiredTask.task.id)?.updatedAt).toBe('2026-11-02T17:00:00.000Z')
  })

  it('refuses a task classification without task detail and leaves nothing behind', () => {
    const harness = createHarness()
    const { decision } = harness.receive({ id: 'message-no-detail' })
    expect(() => harness.engine.classify(decision.id, { intent: 'task', approvalTtlMs: 60_000 })).toThrowError(
      expect.objectContaining({ code: 'missingTaskDetail' }),
    )
    expect(harness.repos.listTasks()).toEqual([])
    expect(harness.repos.listApprovals()).toEqual([])
    expect(harness.engine.thread(THREAD_KEY)?.counts.tasks).toBe(0)
  })

  it('refuses a late approval once its deadline passed', () => {
    const harness = createHarness()
    const { task } = receiveTask(harness, { id: 'message-late' }, { title: 'late' }, 1_000)
    expect(() =>
      harness.engine.approveTask(task.id, {
        by: 'owner',
        at: '2026-11-02T09:00:01.500Z',
        workspace: '/workspace/late',
      }),
    ).toThrowError(expect.objectContaining({ code: 'approvalExpired' }))
    expect(harness.engine.task(task.id)?.status).toBe('awaiting-approval')
    expect(harness.repos.approvals.byTaskId(task.id)?.status).toBe('pending')
    expect(harness.repos.listAssignments()).toEqual([])
  })
})

function capture(work: () => unknown): unknown {
  try {
    work()
    return undefined
  } catch (error) {
    return error
  }
}
