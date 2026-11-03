/**
 * `DshTaskExecutor` behaviour: the approval gate, the workspace, the session
 * it asks the host for, the exact ending it reports, and the one-start /
 * one-finish contract the domain relies on.
 *
 * Every test runs against `FakeSessionHost`, so no DSH session, workspace or
 * permission preset is created.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { USER_ERRORS, UserError } from '../src/core/errors.ts'
import { ExecutorError } from '../src/executor/errors.ts'
import {
  DEFAULT_STATE_DIR,
  DELIVERY_ID_PREFIX,
  DshTaskExecutor,
  MODEL_TURN_TIMEOUT_MS,
  WORKER_PRESET,
  resolveTaskWorkspace,
  taskRequestId,
  taskSessionId,
  taskWorkspace,
  type ExecutorResult,
} from '../src/executor/index.ts'
import { FakeSessionHost, makeApproval, makeSettings, makeTask } from './fixtures/executor.ts'

interface Harness {
  readonly host: FakeSessionHost
  readonly executor: DshTaskExecutor
  readonly dirs: string[]
  readonly results: ExecutorResult[]
  readonly starts: Array<{ taskId: string; sessionId: string }>
}

function harness(options: { settings?: ReturnType<typeof makeSettings>; stateDir?: string } = {}): Harness {
  const host = new FakeSessionHost()
  const dirs: string[] = []
  const results: ExecutorResult[] = []
  const starts: Array<{ taskId: string; sessionId: string }> = []
  const executor = new DshTaskExecutor({
    host,
    homeDir: '/home/owner',
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    clock: () => new Date('2026-11-03T01:00:00.000Z'),
    mkdir: async (path) => {
      dirs.push(path)
    },
  })
  executor.onStarted = (taskId, sessionId) => {
    starts.push({ taskId, sessionId })
  }
  executor.onFinished = (_taskId, result) => {
    results.push(result)
  }
  void options.settings
  return { host, executor, dirs, results, starts }
}

describe('approval gate', () => {
  it('refuses a pending approval without creating a session or a workspace', async () => {
    const { host, executor, dirs } = harness()
    const task = makeTask({ status: 'awaiting-approval' })
    const approval = makeApproval(task, { status: 'pending', decidedAt: null, decidedBy: null })
    await expect(
      executor.execute({ task, approval, settings: makeSettings(), signal: new AbortController().signal }),
    ).rejects.toThrow(UserError)
    expect(host.ensured).toHaveLength(0)
    expect(host.deliveries).toHaveLength(0)
    expect(dirs).toHaveLength(0)
  })

  it('refuses an approved approval whose task never left approval', async () => {
    const { host, executor } = harness()
    const task = makeTask({ status: 'awaiting-approval' })
    await expect(
      executor.execute({
        task,
        approval: makeApproval(task),
        settings: makeSettings(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not approved/i)
    expect(host.ensured).toHaveLength(0)
  })

  it('refuses an approval that belongs to another task', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    const approval = makeApproval(task, { taskId: 'task-other' })
    await expect(
      executor.execute({ task, approval, settings: makeSettings(), signal: new AbortController().signal }),
    ).rejects.toThrow(UserError)
    expect(host.ensured).toHaveLength(0)
  })

  it('refuses a task id that could escape the workspace root', async () => {
    const { host, executor } = harness()
    const task = makeTask({ id: '../../etc/cron.d/evil' })
    await expect(
      executor.execute({
        task,
        approval: makeApproval(task),
        settings: makeSettings(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(ExecutorError)
    expect(host.ensured).toHaveLength(0)
  })
})

describe('session and workspace', () => {
  it('asks for the worker preset, the mapped permission and the task title', async () => {
    const { host, executor } = harness({
      settings: makeSettings({ tasks: { permissionPreset: 'danger-full-access' } }),
    })
    const task = makeTask()
    const result = await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings({ tasks: { permissionPreset: 'danger-full-access' } }),
      signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('succeeded')
    const ensured = host.ensured[0]
    expect(ensured?.preset).toBe(WORKER_PRESET)
    expect(ensured?.permission).toBe('danger-full-access')
    expect(ensured?.title).toBe('任务 · 整理会议纪要')
    expect(ensured?.sessionId).toBe(taskSessionId('task-1', 'assignment-1'))
    expect(result.sessionId).toBe(taskSessionId('task-1', 'assignment-1'))
  })

  it('keeps invalidWorkspace in the domain table as an invalid input', () => {
    // The classification lives in core, so the API maps it to 400 with the
    // other correctable inputs; a move back into the executor would be caught here.
    expect(USER_ERRORS.invalidWorkspace[0]).toBe('invalid')
  })

  it('tells the worker to keep its report free of internal detail', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    const prompt = host.ensured[0]?.systemPrompt ?? ''
    // The report is posted to the group verbatim, so the prompt has to forbid
    // router/agent internals before the model writes them.
    expect(prompt).toContain('不要写 `Route:`')
    expect(prompt).toContain('Aegis')
    expect(prompt).toContain('会话 id')
    expect(prompt).toContain('推理过程')
    expect(prompt).toContain('不要使用 emoji')
  })

  it('defaults the permission to workspace-write', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    expect(host.ensured[0]?.permission).toBe('workspace-write')
  })

  it('passes the configured worker route to the session', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings({ models: { worker: { provider: 'deepseek', model: 'deepseek-chat', effort: '' } } }),
      signal: new AbortController().signal,
    })
    expect(host.ensured[0]?.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat', effort: '' })
  })

  it('creates the workspace under the state directory and passes it on', async () => {
    const { host, executor, dirs } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    const expected = join('/home/owner', '.dsh-whale-chan', 'tasks', 'task-1')
    expect(dirs).toEqual([expected])
    expect(host.ensured[0]?.workspace).toBe(expected)
  })

  it('runs in the workspace the approving person chose, over the settings default', async () => {
    const { host, executor, dirs } = harness()
    const task = makeTask()
    const result = await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings({ tasks: { workspaceRoot: '~/ignored' } }),
      workspace: '/srv/projects/alpha',
      signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('succeeded')
    expect(dirs).toEqual(['/srv/projects/alpha'])
    expect(host.ensured[0]?.workspace).toBe('/srv/projects/alpha')
  })

  it('expands a tilde in the approved workspace', async () => {
    const settings = makeSettings()
    expect(resolveTaskWorkspace({ taskId: 'task-1', settings, approved: '~/work/alpha', home: '/home/owner' })).toBe(
      join('/home/owner', 'work', 'alpha'),
    )
  })

  it('falls back to the settings default when no workspace is approved', async () => {
    const { host, executor, dirs } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings({ tasks: { workspaceRoot: '/srv/tasks' } }),
      workspace: '   ',
      signal: new AbortController().signal,
    })
    expect(dirs).toEqual([join('/srv/tasks', 'task-1')])
    expect(host.ensured[0]?.workspace).toBe(join('/srv/tasks', 'task-1'))
  })

  it('refuses a relative approved workspace as a user error, before creating anything', async () => {
    const { host, executor, dirs } = harness()
    const task = makeTask()
    const error = await executor
      .execute({
        task,
        approval: makeApproval(task),
        settings: makeSettings(),
        workspace: 'projects/alpha',
        signal: new AbortController().signal,
      })
      .catch((thrown: unknown) => thrown)
    // A user-correctable input error, so the API can answer the same way it
    // answers every other refusal the owner can act on.
    expect(error).toBeInstanceOf(UserError)
    expect((error as UserError).code).toBe('invalidWorkspace')
    expect((error as UserError).missing).toBe(false)
    expect(dirs).toHaveLength(0)
    expect(host.ensured).toHaveLength(0)
  })

  it('honours a configured workspace root and expands a leading tilde', async () => {
    const settings = makeSettings({ tasks: { workspaceRoot: '~/work/whale' } })
    expect(taskWorkspace(settings, 'task-9', '/home/owner')).toBe(join('/home/owner', 'work', 'whale', 'task-9'))
  })

  it('falls back to the default state directory', async () => {
    const settings = makeSettings()
    expect(taskWorkspace(settings, 'task-9', '/home/owner', DEFAULT_STATE_DIR)).toBe(
      join('/home/owner', '.dsh-whale-chan', 'tasks', 'task-9'),
    )
  })
})

describe('delivery id', () => {
  it('delivers a bare request id and waits on the prefixed id', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    const delivered = host.deliveries[0]
    expect(delivered?.requestId).toBe('task:task-1:assignment-1')
    expect(delivered?.id).toBe(`${DELIVERY_ID_PREFIX}task:task-1:assignment-1`)
    expect(host.awaited[0]?.options.requestId).toBe(delivered?.id)
  })
})

describe('turn budget', () => {
  it('waits the task budget when it is longer than one model turn', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings({ tasks: { timeoutMinutes: 20 } }),
      signal: new AbortController().signal,
    })
    expect(MODEL_TURN_TIMEOUT_MS).toBe(90_000)
    expect(host.awaited[0]?.options.timeoutMs).toBe(20 * 60_000)
  })

  it('never waits less than one model turn, even for a one-minute task', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings({ tasks: { timeoutMinutes: 1 } }),
      signal: new AbortController().signal,
    })
    expect(host.awaited[0]?.options.timeoutMs).toBe(90_000)
  })
})

describe('prompts and delivery', () => {
  it('puts the persona, the task, its requirements and the safety rules in the system prompt', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    const prompt = host.ensured[0]?.systemPrompt ?? ''
    expect(prompt).toContain('鲸鱼酱')
    expect(prompt).toContain('整理会议纪要')
    expect(prompt).toContain('把今天的会议录音整理成三点纪要。')
    expect(prompt).toContain('三点以内')
    expect(prompt).toContain('小明')
    expect(prompt).toContain('不要自行发送钉钉消息')
    expect(prompt).toContain('只在当前工作区内创建、修改和删除文件')
  })

  it('delivers the assignment once with the request id derived from task and assignment', async () => {
    const { host, executor } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    expect(host.deliveries).toHaveLength(1)
    expect(host.requestIds()).toEqual([taskRequestId(task)])
    expect(host.deliveries[0]?.text).toContain('任务开工：整理会议纪要')
    expect(host.deliveries[0]?.text).toContain('三点以内')
    expect(host.deliveries[0]?.text).toContain('把今天的会议录音整理成三点纪要。')
  })
})

describe('endings', () => {
  it('reports the worker final text as the summary of a success', async () => {
    const { host, executor, results } = harness()
    host.finalText = { text: '  已完成三点纪要，文件为 notes.md。  ', found: true }
    const task = makeTask()
    const result = await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    expect(result).toEqual({
      outcome: 'succeeded',
      summary: '已完成三点纪要，文件为 notes.md。',
      sessionId: taskSessionId('task-1', 'assignment-1'),
    })
    expect(results).toEqual([result])
  })

  it('reports an empty summary without inventing one when the worker said nothing', async () => {
    const { host, executor } = harness()
    host.finalText = { text: '', found: false }
    const task = makeTask()
    const result = await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('succeeded')
    expect(result.summary).toBe('')
  })

  it('maps a failed turn to a failed result with DSH reason detail', async () => {
    const { host, executor } = harness()
    host.turnOutcome = { status: 'failed', detail: 'model provider returned 500' }
    host.finalText = { text: '做到一半', found: true }
    const task = makeTask()
    const result = await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('failed')
    expect(result.summary).toBe('做到一半')
    expect(result.error).toBe('failed: model provider returned 500')
  })

  it('maps a timeout to a timeout result and cancels the session turn', async () => {
    const { host, executor } = harness()
    host.turnOutcome = { status: 'timeout' }
    const task = makeTask()
    const result = await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings({ tasks: { timeoutMinutes: 5 } }),
      signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('timeout')
    expect(result.error).toBe('timeout')
    expect(host.cancellations).toEqual([
      { sessionId: taskSessionId('task-1', 'assignment-1'), reason: 'task task-1 timed out' },
    ])
  })

  it('maps an executor disposal to a cancelled result and stops the session', async () => {
    const { host, executor } = harness()
    host.holdTurns()
    host.finalText = { text: '', found: false }
    const task = makeTask()
    const running = executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    await host.waitForTurnEntry()
    await executor.dispose()
    const result = await running
    expect(result.outcome).toBe('cancelled')
    expect(result.summary).toBe('')
    expect(result.error).toBe('cancelled')
    expect(host.cancellations).toEqual([
      { sessionId: taskSessionId('task-1', 'assignment-1'), reason: 'the executor was disposed' },
    ])
  })
})

describe('cancellation', () => {
  it('cancels a running task, ends it once and is idempotent', async () => {
    const { host, executor, results } = harness()
    host.holdTurns()
    const task = makeTask()
    const running = executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    await host.waitForTurnEntry()
    expect(executor.running()).toEqual(['task-1'])
    expect(await executor.cancel('task-1', '主人取消')).toBe(true)
    expect(await executor.cancel('task-1', '主人取消')).toBe(true)
    const result = await running
    expect(result.outcome).toBe('cancelled')
    expect(result.error).toBe('cancelled: 主人取消')
    expect(host.cancellations).toEqual([{ sessionId: taskSessionId('task-1', 'assignment-1'), reason: '主人取消' }])
    expect(results).toHaveLength(1)
    // After the run ended, the task is no longer addressable.
    expect(await executor.cancel('task-1')).toBe(false)
  })

  it('reports false when nothing runs under that id', async () => {
    const { executor } = harness()
    expect(await executor.cancel('task-missing')).toBe(false)
  })
})

describe('start and finish bookkeeping', () => {
  it('calls onStarted once and onFinished once, in that order', async () => {
    const { executor, starts, results } = harness()
    const task = makeTask()
    await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    expect(starts).toEqual([{ taskId: 'task-1', sessionId: taskSessionId('task-1', 'assignment-1') }])
    expect(results).toHaveLength(1)
    expect(results[0]?.outcome).toBe('succeeded')
  })

  it('does not report a finish when the session could not be created', async () => {
    const { host, executor, starts, results } = harness()
    host.ensureError = new Error('preset not found')
    const task = makeTask()
    await expect(
      executor.execute({
        task,
        approval: makeApproval(task),
        settings: makeSettings(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('preset not found')
    expect(starts).toHaveLength(0)
    expect(results).toHaveLength(0)
  })

  it('keeps the result a failing onFinished listener cannot change it', async () => {
    const { host, executor } = harness()
    host.finalText = { text: '完成', found: true }
    executor.onFinished = () => {
      throw new Error('listener exploded')
    }
    const task = makeTask()
    const result = await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('succeeded')
  })
})

describe('concurrency', () => {
  it('refuses a second concurrent run of the same task without touching the host', async () => {
    const { host, executor } = harness()
    host.holdTurns()
    const task = makeTask()
    const approval = makeApproval(task)
    const settings = makeSettings()
    const first = executor.execute({ task, approval, settings, signal: new AbortController().signal })
    await host.waitForTurnEntry()
    await expect(executor.execute({ task, approval, settings, signal: new AbortController().signal })).rejects.toThrow(
      ExecutorError,
    )
    expect(host.ensured).toHaveLength(1)
    host.releaseTurn()
    const result = await first
    expect(result.outcome).toBe('succeeded')
  })

  it('runs a retry in a fresh session and carries the previous summary as context', async () => {
    const { host, executor, starts } = harness()
    const task = makeTask()
    const first = await executor.execute({
      task,
      approval: makeApproval(task),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    const retried = {
      ...task,
      assignmentId: 'assignment-2',
      result: { summary: '上一轮只写了标题，正文没开始。', sessionId: first.sessionId },
    }
    const second = await executor.execute({
      task: retried,
      approval: makeApproval(retried),
      settings: makeSettings(),
      signal: new AbortController().signal,
    })
    expect(first.outcome).toBe('succeeded')
    expect(second.outcome).toBe('succeeded')
    expect(host.deliveries).toHaveLength(2)
    expect(host.requestIds()).toEqual(['task:task-1:assignment-1', 'task:task-1:assignment-2'])
    // A retry is a new assignment, so it is a new session, not the failed one.
    expect(starts.map((entry) => entry.sessionId)).toEqual([
      taskSessionId('task-1', 'assignment-1'),
      taskSessionId('task-1', 'assignment-2'),
    ])
    expect(host.ensured[1]?.sessionId).toBe(taskSessionId('task-1', 'assignment-2'))
    expect(host.deliveries[1]?.text).toContain('## 上一轮结果（供参考）')
    expect(host.deliveries[1]?.text).toContain('上一轮只写了标题，正文没开始。')
  })
})
