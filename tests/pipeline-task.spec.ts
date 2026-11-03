import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inboundMessage } from './fixtures/domain.ts'
import { jsonBody, request } from './fixtures/http.ts'
import {
  classifyAnswer,
  serveRuntime,
  startPipeline,
  type PipelineHarness,
  type PipelineOptions,
  type RuntimeHttp,
} from './fixtures/pipeline.ts'

let root = ''
let harness: PipelineHarness | undefined
let http: RuntimeHttp | undefined

async function start(options: Omit<PipelineOptions, 'stateDir'> = {}): Promise<PipelineHarness> {
  harness = await startPipeline({ stateDir: join(root, 'state'), ...options })
  return harness
}

async function deliverTask(h: PipelineHarness, overrides: Record<string, unknown> = {}): Promise<string> {
  h.model.current.classifyAnswer = classifyAnswer('task')
  h.channel.emit(inboundMessage({ text: '帮我整理发布说明', ...overrides }))
  await h.runtime.effects.idle()
  const row = h.runtime.store.db.prepare('SELECT task_id FROM decisions LIMIT 1').get() as Record<string, unknown>
  const taskId = String(row['task_id'])
  if (taskId === 'null') throw new Error('the message did not create a task')
  return taskId
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-task-'))
})

afterEach(async () => {
  await http?.close()
  http = undefined
  await harness?.runtime.stop()
  harness = undefined
  await rm(root, { recursive: true, force: true })
})

describe('capturing and approving a task', () => {
  it('creates an awaiting approval that GET tasks reports', async () => {
    const h = await start()
    const taskId = await deliverTask(h)
    http = await serveRuntime(h.runtime)

    const response = await request(http.baseUrl, '/whale-chan/api/tasks')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: { id: string; status: string }[] }
    expect(body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: taskId, status: 'awaiting-approval' })]),
    )

    const notices = h.runtime.store.read
      .audit({ limit: 50 })
      .items.filter((item) => item.type === 'notice')
      .map((item) => item.data as Record<string, unknown>)
    expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task_captured', taskId })]))
    // A captured task never starts by itself.
    expect(h.executor.executed).toEqual([])
    expect(h.channel.sends).toEqual([])
  })

  it('runs only after approval and posts one result back to the thread', async () => {
    const h = await start()
    const taskId = await deliverTask(h)
    http = await serveRuntime(h.runtime)

    const approved = await request(http.baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    expect(approved.status).toBe(200)
    await h.runtime.effects.idle()

    expect(h.executor.executed).toHaveLength(1)
    expect(h.executor.executed[0]?.workspace).toBe(join(h.runtime.stateDir, 'tasks', taskId))
    const task = h.runtime.engine.task(taskId)
    expect(task?.status).toBe('succeeded')
    expect(task?.result).toMatchObject({ summary: '已经整理好了。', sessionId: 'session-1' })
    expect(h.runtime.store.assignments.get(task?.assignmentId as string)?.state).toBe('ended')

    expect(h.channel.sends).toHaveLength(1)
    expect(h.channel.sends[0]).toMatchObject({ kind: 'reply' })
    expect(h.channel.sends[0]?.text).toContain('整理发布说明')
    expect(h.channel.sends[0]?.text).toContain('已经整理好了。')
    expect(h.channel.sends[0]?.text).not.toContain('session-1')
    expect(h.channel.sends[0]?.text).not.toContain('会话：')
    const outbound = h.runtime.store.db.prepare('SELECT status FROM outbound LIMIT 1').get() as Record<string, unknown>
    expect(outbound['status']).toBe('sent')
  })

  it('does not run a task that was never approved', async () => {
    const h = await start()
    const taskId = await deliverTask(h)
    h.runtime.effects.enqueue('launch', taskId, {})
    await h.runtime.effects.idle()

    expect(h.executor.executed).toEqual([])
    expect(h.runtime.engine.task(taskId)?.status).toBe('awaiting-approval')
    const notices = h.runtime.store.read
      .audit({ limit: 50 })
      .items.filter((item) => item.type === 'notice')
      .map((item) => item.data as Record<string, unknown>)
    expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task_launch_refused' })]))
  })

  it('refuses a launch whose assignment does not own the task', async () => {
    const h = await start()
    const taskId = await deliverTask(h)
    const task = h.runtime.engine.task(taskId)
    if (!task?.approvalId) throw new Error('missing approval')
    h.runtime.engine.approveTask(taskId, {
      by: 'owner',
      at: h.clock.now().toISOString(),
      workspace: join(h.runtime.stateDir, 'tasks', taskId),
    })
    h.runtime.effects.enqueue('launch', taskId, { assignmentId: 'assignment-other' })
    await h.runtime.effects.idle()

    expect(h.executor.executed).toEqual([])
    const notices = h.runtime.store.read
      .audit({ limit: 50 })
      .items.filter((item) => item.type === 'notice')
      .map((item) => item.data as Record<string, unknown>)
    expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'assignment_mismatch' })]))
  })

  it('does not run a launch row that survived a cancellation', async () => {
    const h = await start()
    const taskId = await deliverTask(h)
    const task = h.runtime.engine.task(taskId)
    if (!task?.approvalId) throw new Error('missing approval')
    // Approve and cancel without a launch effect, then replay a stale launch row.
    const approved = h.runtime.engine.approveTask(taskId, {
      by: 'owner',
      at: h.clock.now().toISOString(),
      workspace: join(h.runtime.stateDir, 'tasks', taskId),
    })
    h.runtime.engine.cancelTask(taskId, { by: 'owner', at: h.clock.now().toISOString(), reason: '不需要了' })
    h.runtime.effects.enqueue('launch', taskId, {
      assignmentId: approved.assignment.id,
      workspace: approved.assignment.workspace,
    })

    await h.runtime.effects.idle()
    expect(h.executor.executed).toEqual([])
    expect(h.runtime.engine.task(taskId)?.status).toBe('cancelled')
    expect(h.channel.sends).toEqual([])
  })
})

describe('reporting a finished task', () => {
  it('reports a failed run locally and never posts a success message', async () => {
    const h = await start()
    h.executor.result = { outcome: 'failed', summary: '', sessionId: 'session-2', error: 'failed: worker crashed' }
    const taskId = await deliverTask(h)
    http = await serveRuntime(h.runtime)
    await request(http.baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    await h.runtime.effects.idle()

    expect(h.runtime.engine.task(taskId)?.status).toBe('failed')
    expect(h.channel.sends).toEqual([])
    const notices = h.runtime.store.read
      .audit({ limit: 50 })
      .items.filter((item) => item.type === 'notice')
      .map((item) => item.data as Record<string, unknown>)
    expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task_failed', taskId })]))
  })

  it('addresses a direct-message result to its peer', async () => {
    const h = await start({
      settings: {
        targets: {
          rows: [{ kind: 'dm', id: 'target-dm', label: 'Bob', mentionOnly: false, replyMode: 'auto', enabled: true }],
        },
      },
    })
    const taskId = await deliverTask(h, {
      id: 'message-dm-task',
      targetId: 'target-dm',
      threadKey: 'dm:user-9',
      kind: 'dm',
      conversationId: 'user-9',
      conversationType: 'direct',
      sender: { userId: 'user-9', nick: 'Bob' },
    })
    http = await serveRuntime(h.runtime)
    await request(http.baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    await h.runtime.effects.idle()

    expect(h.channel.sends).toHaveLength(1)
    expect(h.channel.sends[0]?.target).toEqual({
      kind: 'dm',
      conversationId: 'user-9',
      peerUserId: 'user-9',
    })
    expect(h.channel.sends[0]?.text).toContain('已经整理好了。')
    expect(h.channel.sends[0]?.text).not.toContain('会话：')
    expect(h.channel.sends[0]?.text).not.toContain('session-1')
  })

  it('strips internal routing and session lines from the result reply', async () => {
    const h = await start()
    h.executor.result = {
      outcome: 'succeeded',
      summary:
        '发布说明已整理好。\nRoute: fast-path — 单文件新建\nAegis Reason Note: 内部理由\n会话：whale-task-task-1-c236a8a7\nSession: whale-task-task-1\n可以直接发布。',
      sessionId: 'whale-task-task-1-c236a8a7',
    }
    const taskId = await deliverTask(h, { id: 'message-internal-lines' })
    http = await serveRuntime(h.runtime)
    await request(http.baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    await h.runtime.effects.idle()

    const text = h.channel.sends[0]?.text ?? ''
    expect(text).toContain('任务「')
    expect(text).toContain('发布说明已整理好。')
    expect(text).toContain('可以直接发布。')
    expect(text).not.toMatch(/Route:|Aegis Reason Note:|会话：|Session:/u)
    expect(text).not.toContain('whale-task-task-1')
  })

  it('falls back when every summary line is internal', async () => {
    const h = await start()
    h.executor.result = {
      outcome: 'succeeded',
      summary: 'Route: fast-path\nSession: whale-task-hidden',
      sessionId: 'whale-task-hidden',
    }
    const taskId = await deliverTask(h, { id: 'message-empty-summary' })
    http = await serveRuntime(h.runtime)
    await request(http.baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    await h.runtime.effects.idle()

    const text = h.channel.sends[0]?.text ?? ''
    expect(text).toContain('这次没有文字汇报，详情可以在面板里查看。')
    expect(text).not.toContain('whale-task-hidden')
  })
})
