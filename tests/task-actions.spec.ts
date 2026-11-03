import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../src/core/index.ts'
import { jsonBody, request, startTestServer, type TestServer } from './fixtures/http.ts'
import { inboundMessage } from './fixtures/domain.ts'

let root = ''
let server: TestServer | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-actions-'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(root, { recursive: true, force: true })
})

async function start(): Promise<TestServer> {
  server = await startTestServer({ stateDir: join(root, 'state') })
  return server
}

function seedTask(runtime: TestServer['runtime'], id = 'message-task'): { taskId: string; approvalId: string } {
  const { decision } = runtime.engine.receive(inboundMessage({ id }))
  const created = runtime.engine.classify(decision.id, {
    intent: 'task',
    task: { title: '整理发布说明' },
    approvalTtlMs: 3_600_000,
  })
  const taskId = created.taskId
  if (!taskId) throw new Error('the decision did not create a task')
  const approval = runtime.store.approvals.byTaskId(taskId)
  if (!approval) throw new Error('the task has no approval')
  return { taskId, approvalId: approval.id }
}

function domainTask(runtime: TestServer['runtime'], taskId: string): Task {
  const task = runtime.engine.task(taskId)
  if (!task) throw new Error(`missing task ${taskId}`)
  return task
}

function failTask(runtime: TestServer['runtime'], taskId: string): string {
  const approved = domainTask(runtime, taskId)
  const assignmentId = approved.assignmentId
  if (!assignmentId) throw new Error('the task has no assignment')
  runtime.engine.assignmentStarted(taskId, assignmentId)
  runtime.engine.assignmentEnded(taskId, assignmentId, { outcome: 'failed', result: { summary: '上一次失败了' } })
  return assignmentId
}

describe('approving a task', () => {
  it('creates an assignment and enqueues the launch effect', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId, approvalId } = seedTask(runtime)
    const response = await request(baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { task: { id: string; status: string }; approval: { id: string } }
    expect(body.task).toEqual(expect.objectContaining({ id: taskId, status: 'queued' }))
    expect(body.approval).toMatchObject({ id: approvalId, status: 'approved' })

    const task = domainTask(runtime, taskId)
    expect(task.status).toBe('approved')
    const assignment = task.assignmentId === null ? undefined : runtime.store.assignments.get(task.assignmentId)
    expect(assignment).toMatchObject({
      taskId,
      state: 'pending',
      workspace: join(runtime.stateDir, 'tasks', taskId),
    })

    const pending = runtime.effects.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      kind: 'launch',
      key: taskId,
      state: 'waiting',
      payload: { assignmentId: task.assignmentId, workspace: join(runtime.stateDir, 'tasks', taskId) },
    })
  })

  it('honours an explicit absolute workspace and expands a leading tilde', async () => {
    const { baseUrl, runtime } = await start()
    const first = seedTask(runtime, 'message-absolute')
    const absolute = join(root, 'work', 'absolute')
    const approved = await request(
      baseUrl,
      `/whale-chan/api/tasks/${first.taskId}/approve`,
      jsonBody('POST', { workspace: absolute }),
    )
    expect(approved.status).toBe(200)
    const firstAssignment = domainTask(runtime, first.taskId).assignmentId
    expect(runtime.store.assignments.get(firstAssignment as string)?.workspace).toBe(absolute)

    const second = seedTask(runtime, 'message-home')
    const home = await request(
      baseUrl,
      `/whale-chan/api/tasks/${second.taskId}/approve`,
      jsonBody('POST', { workspace: '~/whale-chan-work' }),
    )
    expect(home.status).toBe(200)
    const secondAssignment = domainTask(runtime, second.taskId).assignmentId
    expect(runtime.store.assignments.get(secondAssignment as string)?.workspace).toBe(
      join(homedir(), 'whale-chan-work'),
    )
  })

  it('rejects a relative workspace, a mismatched approval and an unknown task', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId } = seedTask(runtime)
    const relative = await request(
      baseUrl,
      `/whale-chan/api/tasks/${taskId}/approve`,
      jsonBody('POST', { workspace: 'work/relative' }),
    )
    expect(relative.status).toBe(400)
    expect(await relative.json()).toMatchObject({ ok: false, error: { code: 'invalid_workspace' } })

    const mismatched = await request(
      baseUrl,
      `/whale-chan/api/tasks/${taskId}/approve`,
      jsonBody('POST', { approvalId: 'approval-other' }),
    )
    expect(mismatched.status).toBe(400)
    expect(await mismatched.json()).toMatchObject({ ok: false, error: { code: 'approval_mismatch' } })

    const missing = await request(baseUrl, '/whale-chan/api/tasks/task-missing/approve', jsonBody('POST', {}))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'unknown_task' } })
  })

  it('refuses a second approval of the same task', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId } = seedTask(runtime)
    expect((await request(baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))).status).toBe(200)
    const again = await request(baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    expect(again.status).toBe(400)
    expect(await again.json()).toMatchObject({ ok: false, error: { code: 'alreadyDecided' } })
    expect(runtime.effects.pending()).toHaveLength(1)
  })
})

describe('rejecting and cancelling a task', () => {
  it('rejects an awaiting task without creating an assignment', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId, approvalId } = seedTask(runtime)
    const response = await request(
      baseUrl,
      `/whale-chan/api/tasks/${taskId}/reject`,
      jsonBody('POST', { reason: '不需要了' }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { task: { status: string }; approval: { status: string } }
    expect(body.task.status).toBe('rejected')
    expect(body.approval.status).toBe('rejected')
    const task = domainTask(runtime, taskId)
    expect(task.assignmentId).toBeNull()
    expect(runtime.store.approvals.get(approvalId)?.status).toBe('rejected')
    expect(runtime.effects.pending()).toEqual([])
  })

  it('cancels an approved task and ends its assignment', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId } = seedTask(runtime)
    await request(baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    const assignmentId = domainTask(runtime, taskId).assignmentId as string

    const response = await request(
      baseUrl,
      `/whale-chan/api/tasks/${taskId}/cancel`,
      jsonBody('POST', { reason: '主人取消了' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      task: expect.objectContaining({ id: taskId, status: 'cancelled' }),
    })
    expect(runtime.store.assignments.get(assignmentId)).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    expect(domainTask(runtime, taskId).reason).toBe('主人取消了')
  })
})

describe('retrying a failed task', () => {
  it('creates a new pending assignment and enqueues another launch', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId } = seedTask(runtime)
    await request(baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    const oldAssignment = failTask(runtime, taskId)
    expect(domainTask(runtime, taskId).status).toBe('failed')

    const response = await request(baseUrl, `/whale-chan/api/tasks/${taskId}/retry`, jsonBody('POST', {}))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ task: expect.objectContaining({ id: taskId, status: 'queued' }) })

    const task = domainTask(runtime, taskId)
    expect(task.status).toBe('approved')
    expect(task.assignmentId).not.toBe(oldAssignment)
    expect(runtime.store.assignments.get(oldAssignment)).toMatchObject({ state: 'ended', outcome: 'failed' })
    expect(runtime.store.assignments.get(task.assignmentId as string)).toMatchObject({
      taskId,
      state: 'pending',
      workspace: join(runtime.stateDir, 'tasks', taskId),
    })
    // The previous result is kept so the executor can quote it as context.
    expect(task.result).toMatchObject({ summary: '上一次失败了' })
    expect(runtime.store.approvals.byTaskId(taskId)?.status).toBe('approved')
    // One active launch per task: the retry rewrote the waiting row to point at
    // the new assignment instead of leaving a stale one behind.
    const pending = runtime.effects.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      kind: 'launch',
      key: taskId,
      payload: { assignmentId: task.assignmentId, workspace: join(runtime.stateDir, 'tasks', taskId) },
    })
  })

  it('refuses a task that did not fail', async () => {
    const { baseUrl, runtime } = await start()
    const awaiting = seedTask(runtime, 'message-awaiting')
    const refusedAwaiting = await request(
      baseUrl,
      `/whale-chan/api/tasks/${awaiting.taskId}/retry`,
      jsonBody('POST', {}),
    )
    expect(refusedAwaiting.status).toBe(400)
    expect(await refusedAwaiting.json()).toMatchObject({ ok: false, error: { code: 'notFailed' } })

    const succeeded = seedTask(runtime, 'message-succeeded')
    await request(baseUrl, `/whale-chan/api/tasks/${succeeded.taskId}/approve`, jsonBody('POST', {}))
    const succeededAssignment = domainTask(runtime, succeeded.taskId).assignmentId as string
    runtime.engine.assignmentStarted(succeeded.taskId, succeededAssignment)
    runtime.engine.assignmentEnded(succeeded.taskId, succeededAssignment, { outcome: 'succeeded' })
    const refusedSucceeded = await request(
      baseUrl,
      `/whale-chan/api/tasks/${succeeded.taskId}/retry`,
      jsonBody('POST', {}),
    )
    expect(refusedSucceeded.status).toBe(400)
    expect(await refusedSucceeded.json()).toMatchObject({ ok: false, error: { code: 'notFailed' } })

    const cancelled = seedTask(runtime, 'message-cancelled')
    await request(baseUrl, `/whale-chan/api/tasks/${cancelled.taskId}/cancel`, jsonBody('POST', {}))
    const refusedCancelled = await request(
      baseUrl,
      `/whale-chan/api/tasks/${cancelled.taskId}/retry`,
      jsonBody('POST', {}),
    )
    expect(refusedCancelled.status).toBe(400)
    expect(await refusedCancelled.json()).toMatchObject({ ok: false, error: { code: 'notFailed' } })
  })

  it('rejects a relative retry workspace and an unknown task', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId } = seedTask(runtime)
    await request(baseUrl, `/whale-chan/api/tasks/${taskId}/approve`, jsonBody('POST', {}))
    failTask(runtime, taskId)
    const relative = await request(
      baseUrl,
      `/whale-chan/api/tasks/${taskId}/retry`,
      jsonBody('POST', { workspace: 'relative/dir' }),
    )
    expect(relative.status).toBe(400)
    expect(await relative.json()).toMatchObject({ ok: false, error: { code: 'invalid_workspace' } })

    const missing = await request(baseUrl, '/whale-chan/api/tasks/task-missing/retry', jsonBody('POST', {}))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'unknown_task' } })
  })
})
