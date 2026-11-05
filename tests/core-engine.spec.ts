import { describe, expect, it } from 'vitest'
import { Engine, UserError } from '../src/core/index.ts'
import { THREAD_KEY, createHarness, inboundMessage, receiveDraft, receiveTask } from './fixtures/domain.ts'

describe('intake', () => {
  it('records the message, its thread and one queued decision', () => {
    const harness = createHarness()
    const result = harness.receive()

    expect(result.duplicate).toBe(false)
    expect(result.decision).toMatchObject({
      messageId: 'message-1',
      threadKey: THREAD_KEY,
      intent: null,
      status: 'queued',
      draft: null,
      outboundId: null,
      taskId: null,
      attempts: 0,
      at: '2026-11-02T09:00:00.000Z',
      updatedAt: '2026-11-02T09:00:00.000Z',
    })
    expect(harness.repos.messages.get('message-1')).toMatchObject({ text: '你好', addressed: true })
    expect(harness.engine.thread(THREAD_KEY)).toMatchObject({
      key: THREAD_KEY,
      targetId: 'target-1',
      kind: 'at-me',
      title: 'target-1',
      peer: null,
      lastMessageAt: '2026-11-02T08:59:00.000Z',
      createdAt: '2026-11-02T09:00:00.000Z',
      counts: { inbound: 1, replied: 0, tasks: 0 },
    })
    expect(harness.events.map((event) => event.type)).toEqual(['message.received', 'decision.queued'])
    expect(harness.events[0]?.data).toEqual({ messageId: 'message-1', threadKey: THREAD_KEY })
  })

  it('titles a direct thread with its peer', () => {
    const harness = createHarness()
    harness.receive({
      id: 'message-dm',
      kind: 'dm',
      conversationType: 'direct',
      sender: { userId: 'user-2', openDingTalkId: 'open-2', nick: 'Bob' },
    })
    expect(harness.engine.thread(THREAD_KEY)).toMatchObject({
      kind: 'dm',
      title: 'Bob',
      peer: { userId: 'user-2', openDingTalkId: 'open-2', nick: 'Bob' },
    })
  })

  it('uses the title the channel reports and follows a rename', () => {
    const harness = createHarness()
    harness.receive({ id: 'message-title-1', title: 'AI工程师孵化中心' })
    expect(harness.engine.thread(THREAD_KEY)?.title).toBe('AI工程师孵化中心')

    harness.receive({ id: 'message-title-2', title: 'AI工程师孵化中心 · 新' })
    expect(harness.engine.thread(THREAD_KEY)?.title).toBe('AI工程师孵化中心 · 新')

    harness.receive({ id: 'message-title-3' })
    expect(harness.engine.thread(THREAD_KEY)?.title).toBe('AI工程师孵化中心 · 新')

    harness.receive({ id: 'message-title-4', title: '   ' })
    expect(harness.engine.thread(THREAD_KEY)?.title).toBe('AI工程师孵化中心 · 新')
  })

  it('keeps the newest message time when an older message arrives late', () => {
    const harness = createHarness()
    harness.receive({ id: 'message-new', at: '2026-11-02T09:30:00.000Z' })
    harness.receive({ id: 'message-old', at: '2026-11-02T09:10:00.000Z' })
    expect(harness.engine.thread(THREAD_KEY)?.lastMessageAt).toBe('2026-11-02T09:30:00.000Z')
    expect(harness.engine.thread(THREAD_KEY)?.counts.inbound).toBe(2)
  })
})

describe('classification and drafting', () => {
  it('classifies chat and question decisions without creating a task', () => {
    const harness = createHarness()
    const chat = harness.receive({ id: 'message-chat' }).decision
    expect(harness.engine.classify(chat.id, { intent: 'chat', confidence: 0.8, reason: 'small talk' })).toMatchObject({
      status: 'classified',
      intent: 'chat',
      confidence: 0.8,
      reason: 'small talk',
    })
    const question = harness.receive({ id: 'message-question' }).decision
    expect(harness.engine.classify(question.id, { intent: 'question' })).toMatchObject({
      status: 'classified',
      intent: 'question',
      taskId: null,
    })
    expect(harness.repos.listTasks()).toEqual([])
  })

  it('closes an ignored decision and records the reason', () => {
    const harness = createHarness()
    const { decision } = harness.receive()
    const ignored = harness.engine.classify(decision.id, { intent: 'ignore', reason: 'bot echo' })
    expect(ignored).toMatchObject({ status: 'ignored', intent: 'ignore', reason: 'bot echo' })
    expect(harness.engine.thread(THREAD_KEY)?.counts).toEqual({ inbound: 1, replied: 0, tasks: 0 })
  })

  it('creates the task, its pending approval and the decision link together', () => {
    const harness = createHarness()
    const { decision, task, approval } = receiveTask(
      harness,
      { id: 'message-task' },
      { title: '整理发布说明', brief: '把本周变更写成文档', requirements: ['中文'] },
      90_000,
    )

    expect(decision).toMatchObject({ status: 'task_created', intent: 'task', taskId: task.id })
    expect(task).toMatchObject({
      id: 'task-1',
      threadKey: THREAD_KEY,
      messageId: 'message-task',
      title: '整理发布说明',
      brief: '把本周变更写成文档',
      requirements: ['中文'],
      status: 'awaiting-approval',
      approvalId: approval.id,
      assignmentId: null,
      result: null,
      requester: { userId: 'user-1', nick: 'Alice' },
    })
    expect(approval).toMatchObject({
      id: 'approval-1',
      taskId: 'task-1',
      status: 'pending',
      requestedAt: '2026-11-02T09:00:00.000Z',
      expiresAt: '2026-11-02T09:01:30.000Z',
      decidedAt: null,
      decidedBy: null,
      note: null,
    })
    expect(harness.engine.thread(THREAD_KEY)?.counts).toEqual({ inbound: 1, replied: 0, tasks: 1 })
    expect(harness.engine.openTasks().map((item) => item.id)).toEqual(['task-1'])
    expect(harness.engine.pendingApprovals('2026-11-02T09:00:30.000Z').map((item) => item.id)).toEqual(['approval-1'])
  })

  it('drafts a classified decision and refuses any other status', () => {
    const harness = createHarness()
    const { decision } = harness.receive()
    harness.engine.classify(decision.id, { intent: 'question' })
    const drafted = harness.engine.draft(decision.id, {
      text: '据我了解是三号发布。',
      researched: true,
      sources: ['https://example.test/release'],
    })
    expect(drafted).toMatchObject({
      status: 'drafted',
      draft: { text: '据我了解是三号发布。', researched: true, sources: ['https://example.test/release'] },
    })
    expect(harness.events.map((event) => event.type)).toContain('reply.drafted')
    expect(() => harness.engine.draft(decision.id, { text: 'again', researched: false, sources: [] })).toThrowError(
      expect.objectContaining({ code: 'notClassified' }),
    )
  })

  it('defers only a queued or classified decision', () => {
    const harness = createHarness()
    const queued = harness.receive({ id: 'message-queued' }).decision
    expect(harness.engine.defer(queued.id, 'quiet hours')).toMatchObject({
      status: 'deferred',
      reason: 'quiet hours',
    })
    const classified = harness.receive({ id: 'message-classified' }).decision
    harness.engine.classify(classified.id, { intent: 'chat' })
    expect(harness.engine.defer(classified.id, 'digest')).toMatchObject({ status: 'deferred' })
    const { decision: drafted } = receiveDraft(harness, { id: 'message-drafted' })
    expect(() => harness.engine.defer(drafted.id, 'late')).toThrowError(
      expect.objectContaining({ code: 'notDeferrable' }),
    )
  })

  it('records compose attempts only while the decision is classified', () => {
    const harness = createHarness()
    const queued = harness.receive({ id: 'message-queued' }).decision
    expect(() => harness.engine.recordReplyAttempt(queued.id)).toThrowError(
      expect.objectContaining({ code: 'notRetryable' }),
    )

    harness.engine.classify(queued.id, { intent: 'chat', confidence: 0.7, reason: '问候' })
    harness.clock.advance(1_000)
    const first = harness.engine.recordReplyAttempt(queued.id)
    expect(first).toMatchObject({
      id: queued.id,
      messageId: queued.messageId,
      status: 'classified',
      intent: 'chat',
      confidence: 0.7,
      draft: null,
      outboundId: null,
      taskId: null,
      attempts: 1,
      // The classification reason survives a retry; only the log names the failure.
      reason: '问候',
      updatedAt: '2026-11-02T09:00:01.000Z',
    })
    const second = harness.engine.recordReplyAttempt(queued.id)
    expect(second).toMatchObject({ status: 'classified', attempts: 2, reason: '问候' })

    const deferred = harness.receive({ id: 'message-deferred' }).decision
    harness.engine.defer(deferred.id, 'quiet hours')
    expect(() => harness.engine.recordReplyAttempt(deferred.id)).toThrowError(
      expect.objectContaining({ code: 'notRetryable' }),
    )

    const { decision: drafted } = receiveDraft(harness, { id: 'message-drafted' })
    expect(() => harness.engine.recordReplyAttempt(drafted.id)).toThrowError(
      expect.objectContaining({ code: 'notRetryable' }),
    )
  })
})

describe('reply delivery', () => {
  it('queues a sending decision and confirms the delivery once', () => {
    const harness = createHarness()
    const { decision, outbound } = receiveDraft(harness)

    expect(decision).toMatchObject({ status: 'sending', outboundId: outbound.id })
    expect(outbound).toMatchObject({
      id: 'outbound-1',
      idempotencyKey: 'reply:decision-1',
      kind: 'reply',
      target: { kind: 'at-me', conversationId: 'conv-1' },
      status: 'pending',
      attempts: 0,
      lastError: null,
      sentAt: null,
      receipt: null,
    })

    const sent = harness.engine.replySent(decision.id, 'dingtalk-message-9')
    expect(sent.status).toBe('sent')
    expect(harness.engine.thread(THREAD_KEY)?.counts).toEqual({ inbound: 1, replied: 1, tasks: 0 })
    const stored = harness.repos.outbound.get(outbound.id)
    expect(stored).toMatchObject({ status: 'sent', receipt: 'dingtalk-message-9', sentAt: '2026-11-02T09:00:00.000Z' })
    expect(harness.events.map((event) => event.type)).toEqual([
      'message.received',
      'decision.queued',
      'decision.classified',
      'reply.drafted',
      'reply.queued',
      'reply.sent',
    ])
  })

  it('records an unknown delivery without confirming it', () => {
    const harness = createHarness()
    const { decision, outbound } = receiveDraft(harness)
    const unknown = harness.engine.replyUnknown(decision.id, 'socket closed')
    expect(unknown).toMatchObject({ status: 'send_unknown', attempts: 1 })
    expect(harness.repos.outbound.get(outbound.id)).toMatchObject({
      status: 'unknown',
      attempts: 1,
      lastError: 'socket closed',
      sentAt: null,
    })
    expect(harness.engine.thread(THREAD_KEY)?.counts.replied).toBe(0)
    expect(() => harness.engine.replySent(decision.id)).toThrowError(expect.objectContaining({ code: 'notSending' }))
  })

  it('records a failed delivery and counts the attempt', () => {
    const harness = createHarness()
    const { decision, outbound } = receiveDraft(harness)
    const failed = harness.engine.replyFailed(decision.id, 'rate limited')
    expect(failed).toMatchObject({ status: 'send_failed', attempts: 1 })
    expect(harness.repos.outbound.get(outbound.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'rate limited',
    })
  })
})

describe('approval gate', () => {
  it('approves a task with its assignment and records who decided', () => {
    const harness = createHarness()
    const { task, approval } = receiveTask(harness)
    const result = harness.engine.approveTask(task.id, {
      by: 'owner',
      note: '可以做',
      at: '2026-11-02T09:00:10.000Z',
      workspace: '/workspace/task-1',
    })

    expect(result.approval).toMatchObject({
      id: approval.id,
      status: 'approved',
      decidedAt: '2026-11-02T09:00:10.000Z',
      decidedBy: 'owner',
      note: '可以做',
    })
    expect(result.task).toMatchObject({
      status: 'approved',
      assignmentId: result.assignment.id,
      updatedAt: '2026-11-02T09:00:00.000Z',
    })
    expect(result.assignment).toMatchObject({
      id: 'assignment-1',
      taskId: task.id,
      state: 'pending',
      sessionId: null,
      workspace: '/workspace/task-1',
      startedAt: null,
      endedAt: null,
      outcome: null,
      error: null,
    })
    expect(harness.events.map((event) => event.type)).toContain('task.approved')
  })

  it('rejects an awaiting task without creating an assignment', () => {
    const harness = createHarness()
    const { task, approval } = receiveTask(harness)
    const result = harness.engine.rejectTask(task.id, {
      by: 'owner',
      note: '不需要',
      at: '2026-11-02T09:00:05.000Z',
    })
    expect(result.task.status).toBe('rejected')
    expect(result.approval).toMatchObject({ status: 'rejected', decidedAt: '2026-11-02T09:00:05.000Z' })
    expect(harness.repos.listAssignments()).toEqual([])
    expect(harness.engine.openTasks()).toEqual([])
    expect(approval.status).toBe('pending')
    expect(harness.events.map((event) => event.type)).toContain('task.rejected')
  })

  it('cancels an awaiting, an approved and a running task', () => {
    const harness = createHarness()

    const awaiting = receiveTask(harness, { id: 'message-cancel-awaiting' }, { title: 'A' })
    const cancelledAwaiting = harness.engine.cancelTask(awaiting.task.id, {
      by: 'owner',
      reason: 'no longer needed',
      at: '2026-11-02T09:01:00.000Z',
    })
    expect(cancelledAwaiting).toMatchObject({ status: 'cancelled', reason: 'no longer needed' })
    expect(harness.repos.approvals.byTaskId(awaiting.task.id)).toMatchObject({ status: 'expired' })

    const approved = receiveTask(harness, { id: 'message-cancel-approved' }, { title: 'B' }, 3_600_000)
    const approvedResult = harness.engine.approveTask(approved.task.id, {
      by: 'owner',
      at: '2026-11-02T09:01:00.000Z',
      workspace: '/workspace/b',
    })
    harness.engine.cancelTask(approved.task.id, { by: 'owner', at: '2026-11-02T09:02:00.000Z' })
    expect(harness.repos.assignments.get(approvedResult.assignment.id)).toMatchObject({
      state: 'ended',
      outcome: 'cancelled',
      endedAt: '2026-11-02T09:00:00.000Z',
    })

    const running = receiveTask(harness, { id: 'message-cancel-running' }, { title: 'C' }, 3_600_000)
    const runningResult = harness.engine.approveTask(running.task.id, {
      by: 'owner',
      at: '2026-11-02T09:01:00.000Z',
      workspace: '/workspace/c',
    })
    harness.engine.assignmentStarted(running.task.id, runningResult.assignment.id)
    harness.engine.cancelTask(running.task.id, { by: 'owner', at: '2026-11-02T09:02:00.000Z' })
    expect(harness.repos.assignments.get(runningResult.assignment.id)?.outcome).toBe('cancelled')
  })

  it('refuses to cancel a terminal task', () => {
    const harness = createHarness()
    const { task } = receiveTask(harness)
    harness.engine.rejectTask(task.id, { by: 'owner', at: '2026-11-02T09:00:05.000Z' })
    expect(() => harness.engine.cancelTask(task.id, { by: 'owner', at: '2026-11-02T09:01:00.000Z' })).toThrowError(
      expect.objectContaining({ code: 'notCancellable' }),
    )
  })
})

describe('execution', () => {
  it('starts and ends an assignment successfully', () => {
    const harness = createHarness()
    const { task } = receiveTask(harness)
    const approved = harness.engine.approveTask(task.id, {
      by: 'owner',
      at: '2026-11-02T09:00:10.000Z',
      workspace: '/workspace/task-1',
    })
    const started = harness.engine.assignmentStarted(task.id, approved.assignment.id)
    expect(started).toMatchObject({ state: 'running', startedAt: '2026-11-02T09:00:00.000Z', sessionId: null })
    expect(harness.engine.task(task.id)?.status).toBe('running')

    const ended = harness.engine.assignmentEnded(task.id, approved.assignment.id, {
      outcome: 'succeeded',
      result: { summary: '发布说明已整理', sessionId: 'session-1', artifactPaths: ['/tmp/out.md'] },
    })
    expect(ended.task).toMatchObject({
      status: 'succeeded',
      result: { summary: '发布说明已整理', sessionId: 'session-1', artifactPaths: ['/tmp/out.md'] },
    })
    expect(ended.assignment).toMatchObject({
      state: 'ended',
      outcome: 'succeeded',
      endedAt: '2026-11-02T09:00:00.000Z',
      error: null,
    })
    expect(harness.events.map((event) => event.type)).toContain('assignment.started')
    expect(harness.events.map((event) => event.type)).toContain('assignment.ended')
  })

  it('binds the executor session to the assignment and keeps it after the end', () => {
    const harness = createHarness()
    const { task } = receiveTask(harness)
    const approved = harness.engine.approveTask(task.id, {
      by: 'owner',
      at: '2026-11-02T09:00:10.000Z',
      workspace: '/workspace/task-1',
    })
    const started = harness.engine.assignmentStarted(task.id, approved.assignment.id, {
      sessionId: 'session-abc',
    })
    expect(started).toMatchObject({ state: 'running', sessionId: 'session-abc' })
    expect(harness.engine.task(task.id)?.assignmentId).toBe(approved.assignment.id)
    expect(harness.repos.assignments.get(approved.assignment.id)?.sessionId).toBe('session-abc')

    const ended = harness.engine.assignmentEnded(task.id, approved.assignment.id, { outcome: 'succeeded' })
    expect(ended.assignment).toMatchObject({ state: 'ended', sessionId: 'session-abc', outcome: 'succeeded' })
    expect(harness.repos.assignments.get(approved.assignment.id)?.sessionId).toBe('session-abc')
  })

  it('maps a failed and a timed-out assignment to a failed task', () => {
    for (const outcome of ['failed', 'timeout'] as const) {
      const harness = createHarness()
      const { task } = receiveTask(harness)
      const approved = harness.engine.approveTask(task.id, {
        by: 'owner',
        at: '2026-11-02T09:00:10.000Z',
        workspace: '/workspace/task-1',
      })
      harness.engine.assignmentStarted(task.id, approved.assignment.id)
      const ended = harness.engine.assignmentEnded(task.id, approved.assignment.id, { outcome })
      expect(ended.task.status).toBe('failed')
      expect(ended.assignment.outcome).toBe(outcome)
    }
  })

  it('expires overdue approvals and reports the affected tasks', () => {
    const harness = createHarness()
    const first = receiveTask(harness, { id: 'message-short' }, { title: 'short' }, 1_000)
    const second = receiveTask(harness, { id: 'message-long' }, { title: 'long' }, 60_000)
    const expired = harness.engine.expireTasks('2026-11-02T09:00:02.000Z')
    expect(expired).toEqual([first.task.id])
    expect(harness.engine.task(first.task.id)?.status).toBe('expired')
    expect(harness.engine.task(second.task.id)?.status).toBe('awaiting-approval')
    expect(harness.repos.approvals.byTaskId(first.task.id)?.status).toBe('expired')
    expect(harness.engine.pendingApprovals('2026-11-02T09:00:02.000Z').map((item) => item.taskId)).toEqual([
      second.task.id,
    ])
  })

  it('reads threads, decisions and tasks without a transaction', () => {
    const harness = createHarness()
    const { decision, task } = receiveTask(harness)
    expect(harness.engine.decision(decision.id)).toEqual(decision)
    expect(harness.engine.task(task.id)).toEqual(task)
    expect(harness.engine.thread('missing')).toBeUndefined()
    expect(harness.engine.decision('missing')).toBeUndefined()
    expect(harness.engine.task('missing')).toBeUndefined()
  })
})

describe('error handling', () => {
  it('refuses unknown aggregates with a missing UserError', () => {
    const harness = createHarness()
    const error = capture(() => harness.engine.classify('decision-missing', { intent: 'chat' }))
    expect(error).toBeInstanceOf(UserError)
    expect((error as UserError).code).toBe('unknownDecision')
    expect((error as UserError).missing).toBe(true)
    expect(() =>
      harness.engine.approveTask('task-missing', { by: 'owner', at: '2026-11-02T09:00:00.000Z', workspace: '/w' }),
    ).toThrowError(expect.objectContaining({ code: 'unknownTask' }))
  })

  it('keeps a committed command when an event observer throws', () => {
    const harness = createHarness()
    const engine = new Engine({
      repos: harness.repos,
      ids: harness.ids,
      clock: harness.clock,
      emit: () => {
        throw new Error('observer failed')
      },
    })
    const result = engine.receive(inboundMessage({ id: 'message-observer' }))
    expect(result.duplicate).toBe(false)
    expect(engine.decision(result.decision.id)?.status).toBe('queued')
  })
})

describe('retrying a failed task', () => {
  function failFirst(harness: ReturnType<typeof createHarness>): { taskId: string; assignmentId: string } {
    const { task } = receiveTask(harness, {}, { title: '重试' }, 3_600_000)
    const approved = harness.engine.approveTask(task.id, {
      by: 'owner',
      at: '2026-11-02T09:00:10.000Z',
      workspace: '/workspace/task-1',
    })
    harness.engine.assignmentStarted(task.id, approved.assignment.id)
    harness.engine.assignmentEnded(task.id, approved.assignment.id, {
      outcome: 'failed',
      result: { summary: '上一次失败了' },
    })
    return { taskId: task.id, assignmentId: approved.assignment.id }
  }

  it('creates a new pending assignment and keeps the result and the approval', () => {
    const harness = createHarness()
    const { taskId, assignmentId } = failFirst(harness)
    const result = harness.engine.retryTask(taskId, {
      by: 'owner',
      at: '2026-11-02T09:05:00.000Z',
      workspace: '/workspace/task-1-retry',
      note: '再试一次',
    })

    expect(result.task).toMatchObject({
      id: taskId,
      status: 'approved',
      assignmentId: result.assignment.id,
      result: { summary: '上一次失败了' },
      approvalId: 'approval-1',
    })
    expect(result.assignment).toMatchObject({
      taskId,
      state: 'pending',
      workspace: '/workspace/task-1-retry',
      sessionId: null,
      startedAt: null,
      endedAt: null,
      outcome: null,
      error: null,
    })
    expect(result.assignment.id).not.toBe(assignmentId)
    expect(harness.repos.assignments.get(assignmentId)).toMatchObject({ state: 'ended', outcome: 'failed' })
    expect(harness.repos.approvals.byTaskId(taskId)?.status).toBe('approved')
    expect(harness.engine.task(taskId)?.status).toBe('approved')
    expect(harness.events.at(-1)).toMatchObject({
      type: 'task.retried',
      data: { taskId, assignmentId: result.assignment.id },
    })
  })

  it('accepts a Windows absolute workspace from the domain check', () => {
    const harness = createHarness()
    const { taskId } = failFirst(harness)
    const result = harness.engine.retryTask(taskId, {
      by: 'owner',
      at: '2026-11-02T09:05:00.000Z',
      workspace: 'C:\\work\\task-1',
    })
    expect(result.assignment.workspace).toBe('C:\\work\\task-1')
  })

  it('refuses every status other than failed', () => {
    const awaiting = createHarness()
    const pending = receiveTask(awaiting)
    expect(() =>
      awaiting.engine.retryTask(pending.task.id, {
        by: 'owner',
        at: '2026-11-02T09:05:00.000Z',
        workspace: '/workspace/x',
      }),
    ).toThrowError(expect.objectContaining({ code: 'notFailed' }))

    const running = createHarness()
    const runningTask = receiveTask(running)
    const approved = running.engine.approveTask(runningTask.task.id, {
      by: 'owner',
      at: '2026-11-02T09:00:10.000Z',
      workspace: '/workspace/running',
    })
    running.engine.assignmentStarted(runningTask.task.id, approved.assignment.id)
    expect(() =>
      running.engine.retryTask(runningTask.task.id, {
        by: 'owner',
        at: '2026-11-02T09:05:00.000Z',
        workspace: '/workspace/running',
      }),
    ).toThrowError(expect.objectContaining({ code: 'notFailed' }))

    const succeeded = createHarness()
    const succeededTask = receiveTask(succeeded)
    const succeededApproval = succeeded.engine.approveTask(succeededTask.task.id, {
      by: 'owner',
      at: '2026-11-02T09:00:10.000Z',
      workspace: '/workspace/succeeded',
    })
    succeeded.engine.assignmentStarted(succeededTask.task.id, succeededApproval.assignment.id)
    succeeded.engine.assignmentEnded(succeededTask.task.id, succeededApproval.assignment.id, {
      outcome: 'succeeded',
    })
    expect(() =>
      succeeded.engine.retryTask(succeededTask.task.id, {
        by: 'owner',
        at: '2026-11-02T09:05:00.000Z',
        workspace: '/workspace/succeeded',
      }),
    ).toThrowError(expect.objectContaining({ code: 'notFailed' }))

    const cancelled = createHarness()
    const cancelledTask = receiveTask(cancelled)
    cancelled.engine.cancelTask(cancelledTask.task.id, { by: 'owner', at: '2026-11-02T09:01:00.000Z' })
    expect(() =>
      cancelled.engine.retryTask(cancelledTask.task.id, {
        by: 'owner',
        at: '2026-11-02T09:05:00.000Z',
        workspace: '/workspace/cancelled',
      }),
    ).toThrowError(expect.objectContaining({ code: 'notFailed' }))
  })

  it('refuses a missing or relative workspace without writing a new assignment', () => {
    const harness = createHarness()
    const { taskId } = failFirst(harness)
    expect(() =>
      harness.engine.retryTask(taskId, { by: 'owner', at: '2026-11-02T09:05:00.000Z', workspace: '   ' }),
    ).toThrowError(expect.objectContaining({ code: 'missingWorkspace' }))
    expect(() =>
      harness.engine.retryTask(taskId, { by: 'owner', at: '2026-11-02T09:05:00.000Z', workspace: 'relative/dir' }),
    ).toThrowError(expect.objectContaining({ code: 'invalidWorkspace' }))
    expect(harness.repos.listAssignments()).toHaveLength(1)
    expect(harness.engine.task(taskId)?.status).toBe('failed')
  })

  it('refuses an unknown task and an unparseable instant', () => {
    const harness = createHarness()
    expect(() =>
      harness.engine.retryTask('task-missing', {
        by: 'owner',
        at: '2026-11-02T09:05:00.000Z',
        workspace: '/workspace/x',
      }),
    ).toThrowError(expect.objectContaining({ code: 'unknownTask', missing: true }))

    const { taskId } = failFirst(harness)
    expect(() =>
      harness.engine.retryTask(taskId, { by: 'owner', at: 'not-a-time', workspace: '/workspace/x' }),
    ).toThrowError(expect.objectContaining({ code: 'invalidTime' }))
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
