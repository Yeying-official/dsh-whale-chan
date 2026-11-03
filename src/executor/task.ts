/**
 * `DshTaskExecutor`: turns one approved task into one DSH worker session.
 *
 * The executor is deliberately narrow. It creates the workspace, asks the host
 * for a session under the worker preset, hands over the assignment, waits for
 * the turn and reports the worker's own final text. It never writes the domain,
 * never sends a DingTalk message and never invents a summary.
 *
 * Three invariants are enforced here rather than by the caller:
 *
 * 1. **Fail closed.** A task runs only when the task *and* its approval are
 *    `approved` and the approval belongs to that task. Anything else throws
 *    `UserError('notApproved')` before a workspace or session exists.
 * 2. **One run per task.** The internal map refuses a second concurrent run of
 *    the same task; the map is per-executor, keyed by task, and holds no state
 *    another task can read.
 * 3. **Exactly one ending per start.** `onStarted` fires once, after the
 *    session exists; `onFinished` fires once in `finally`, and only if the run
 *    started. A refusal before the session exists throws instead, because the
 *    domain has no running assignment to end.
 */
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { UserError } from '../core/errors.ts'
import type { Approval, Task } from '../core/model.ts'
import { renderPersona } from '../brain/persona.ts'
import type { Settings } from '../shared/settings.ts'
import type { PermissionPreset } from '../shared/limits.ts'
import { ExecutorError } from './errors.ts'
import {
  MODEL_TURN_TIMEOUT_MS,
  WORKER_PRESET,
  deliveryId,
  taskSessionId,
  type AwaitTurnOptions,
  type ExecutorLogger,
  type ExecutorRequest,
  type ExecutorResult,
  type SessionHost,
  type SessionRef,
  type TaskExecutor,
  type TurnEndOutcome,
} from './types.ts'

/** Directory name under the state directory that holds task workspaces. */
export const TASKS_DIRECTORY = 'tasks'

/** Default host state directory, matching the deployment default. */
export const DEFAULT_STATE_DIR = '~/.dsh-whale-chan'

/** Request id of the assignment message of one task run; stable across retries of one assignment. */
export function taskRequestId(task: Task): string {
  return `task:${task.id}:${task.assignmentId ?? 'initial'}`
}

/** Expand a leading `~` against `home`; every other path is returned unchanged. */
export function expandHome(path: string, home: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return trimmed
}

/**
 * The default workspace directory of one task.
 *
 * It is only used when the approving person named no directory: `tasks.workspaceRoot`
 * wins over `<stateDir>/tasks`, and the task id must be one safe path segment, so
 * a crafted id cannot escape the root.
 */
export function taskWorkspace(settings: Settings, taskId: string, home: string, stateDir = DEFAULT_STATE_DIR): string {
  if (!isSafeSegment(taskId)) throw new ExecutorError('unsafeTaskId', taskId)
  const configured = settings.tasks.workspaceRoot.trim()
  const root = configured.length > 0 ? expandHome(configured, home) : join(expandHome(stateDir, home), TASKS_DIRECTORY)
  return join(root, taskId)
}

/**
 * The workspace one run uses: the approved directory when it names one, else the
 * settings default.
 *
 * A relative path is refused instead of resolved: `mkdir` and the session
 * workspace are both resolved by DSH against the host's own working directory,
 * so accepting `work/foo` would silently place the worker somewhere the owner
 * cannot predict.
 */
export function resolveTaskWorkspace(input: {
  readonly taskId: string
  readonly settings: Settings
  readonly approved?: string
  readonly home: string
  readonly stateDir?: string
}): string {
  const approved = (input.approved ?? '').trim()
  if (approved.length > 0) {
    const expanded = expandHome(approved, input.home)
    // A user-correctable input error: the panel must ask for another directory,
    // so the domain error carries it rather than an internal executor failure.
    if (!isAbsolute(expanded)) throw new UserError('invalidWorkspace')
    return expanded
  }
  return taskWorkspace(input.settings, input.taskId, input.home, input.stateDir ?? DEFAULT_STATE_DIR)
}

/** Whether `value` is usable as one path segment and cannot traverse out of a root. */
export function isSafeSegment(value: string): boolean {
  if (value.length === 0 || value === '.' || value === '..') return false
  return !/[/\\\0]/.test(value) && !value.includes('..')
}

/** The permission preset a task runs under; anything unexpected falls back to the narrow one. */
export function permissionFor(settings: Settings): PermissionPreset {
  return settings.tasks.permissionPreset === 'danger-full-access' ? 'danger-full-access' : 'workspace-write'
}

export interface TaskPromptInput {
  readonly task: Task
  readonly settings: Settings
  readonly now: Date
  /** Shipped `persona` template; the built-in frame is used when omitted. */
  readonly personaTemplate?: string
}

function bullets(lines: readonly string[], empty: string): string {
  const kept = lines.map((line) => line.trim()).filter((line) => line.length > 0)
  return kept.length === 0 ? empty : kept.map((line) => `- ${line}`).join('\n')
}

/**
 * The worker's system prompt: the owner's persona, then the task, then the
 * rules that keep a chat-triggered worker inside the workspace and off
 * DingTalk. The persona block is rendered by the brain, so the worker speaks as
 * the same assistant the replier does.
 */
export function renderTaskSystemPrompt(input: TaskPromptInput): string {
  const { task, now } = input
  const persona = renderPersona(
    input.settings.persona,
    { targetLabel: task.title, now },
    input.personaTemplate === undefined ? {} : { template: input.personaTemplate },
  )
  const requirements = bullets(task.requirements, '（发起人没有额外要求，按任务说明完成。）')
  return [
    persona,
    '',
    '## 任务',
    `- 标题：${task.title}`,
    `- 发起人：${task.requester.nick}（${task.requester.userId}）`,
    `- 来源会话：${task.threadKey}`,
    '- 这项任务已经由主人亲自批准，你只需要完成它。',
    '',
    '## 任务说明（发起人的原话）',
    task.brief.trim().length === 0 ? '（没有更多说明。）' : task.brief.trim(),
    '',
    '## 交付要求',
    requirements,
    '',
    '## 执行规则',
    '- 只在当前工作区内创建、修改和删除文件，不要写到工作区之外的路径。',
    '- 不要读取、输出或写入任何凭据、令牌、密钥或密码。',
    '- 不要自行发送钉钉消息，也不要联系任务发起人；结果只通过本次汇报返回。',
    '- 需要人决策、缺少权限或超出任务范围时，停下来直接汇报，不要猜测或扩大范围。',
    '- 不要留下长期驻留的进程；需要后台运行时使用工具提供的后台模式，并在结束时说明。',
    '',
    '## 汇报',
    '汇报会在群里原样展示给任务发起人，所以只写他能看懂、看了有用的事情：',
    '- 做了什么（结果，不是过程）；',
    '- 改了哪些文件；',
    '- 怎么验证的、结果如何；',
    '- 还有什么没做完或需要他决定的。',
    '不要写任何内部实现细节，具体包括：',
    '- 不要写 `Route:`、`Aegis`、fast-path/slow-path 之类内部分类或路由结论；',
    '- 不要写会话 id（例如 `whale-task-…`）、工作区绝对路径、工具名或函数名；',
    '- 不要复述你的推理过程、内心独白或“我先看看/接下来我要”这类旁白；',
    '- 不要使用 emoji，也不要写“会话：…”“模型：…”这类元信息行。',
    '如果任务没做成，直接说没做成、卡在哪、需要什么，不要用过程描述掩盖结果。',
  ].join('\n')
}

/** The assignment message handed to the worker session. */
export function renderTaskMessage(task: Task): string {
  const previous = (task.result?.summary ?? '').trim()
  return [
    `任务开工：${task.title}`,
    '',
    `发起人：${task.requester.nick}（${task.requester.userId}）`,
    `来源会话：${task.threadKey}`,
    '',
    '原始请求：',
    task.brief.trim().length === 0 ? '（没有更多说明。）' : task.brief.trim(),
    '',
    '交付要求：',
    bullets(task.requirements, '（无额外要求。）'),
    // A retry runs in a new session, so the previous attempt's report is the
    // only way it can avoid repeating work. It is context, never an instruction.
    ...(previous.length === 0 ? [] : ['', '## 上一轮结果（供参考）', previous]),
    '',
    '完成后用简洁的中文汇报结果。',
  ].join('\n')
}

/** Everything `DshTaskExecutor` needs from its composition root. */
export interface DshTaskExecutorOptions {
  readonly host: SessionHost
  readonly logger?: ExecutorLogger
  /** Injected clock for the persona context; defaults to the wall clock. */
  readonly clock?: () => Date
  /** Injected home directory for `~` expansion; defaults to `os.homedir()`. */
  readonly homeDir?: string
  /** Deployment state directory; defaults to `~/.dsh-whale-chan`. */
  readonly stateDir?: string
  /** Shipped `persona` template, when the composition root loaded one. */
  readonly personaTemplate?: string
  /** Creates a directory recursively; replaced by tests. */
  readonly mkdir?: (path: string) => Promise<void>
}

/** One in-flight run; the executor's only per-task state. */
interface Run {
  readonly controller: AbortController
  /** Session this run addresses, known before `ensureSession` resolves so a cancel can find it. */
  readonly sessionId: string
  session: SessionRef | undefined
  cancelled: boolean
  reason: string | undefined
}

/** `TaskExecutor` over a `SessionHost`. */
export class DshTaskExecutor implements TaskExecutor {
  private readonly host: SessionHost
  private readonly logger: ExecutorLogger | undefined
  private readonly clock: () => Date
  private readonly homeDir: string
  private readonly stateDir: string
  private readonly personaTemplate: string | undefined
  private readonly makeDirectory: (path: string) => Promise<void>
  private readonly runs = new Map<string, Run>()

  onStarted?: (taskId: string, sessionId: string) => void
  onFinished?: (taskId: string, result: ExecutorResult) => void

  constructor(options: DshTaskExecutorOptions) {
    this.host = options.host
    this.logger = options.logger
    this.clock = options.clock ?? (() => new Date())
    this.homeDir = options.homeDir ?? homedir()
    this.stateDir = options.stateDir ?? DEFAULT_STATE_DIR
    this.personaTemplate = options.personaTemplate
    this.makeDirectory =
      options.mkdir ??
      (async (path: string): Promise<void> => {
        await mkdir(path, { recursive: true })
      })
  }

  /** Whether `taskId` currently runs; the app layer uses it to bound concurrency. */
  running(): readonly string[] {
    return [...this.runs.keys()]
  }

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const { task, approval, settings, signal } = request
    this.assertApproved(task, approval)
    if (this.runs.has(task.id)) throw new ExecutorError('alreadyRunning', task.id)

    const sessionId = taskSessionId(task.id, task.assignmentId)
    const run: Run = {
      controller: new AbortController(),
      sessionId,
      session: undefined,
      cancelled: false,
      reason: undefined,
    }
    this.runs.set(task.id, run)
    let started = false
    let result: ExecutorResult | undefined
    try {
      const lifetime = AbortSignal.any([signal, run.controller.signal])
      const workspace = await this.prepareWorkspace(task, settings, request.workspace)
      const session = await this.host.ensureSession({
        sessionId,
        workspace,
        title: `任务 · ${task.title}`,
        preset: WORKER_PRESET,
        permission: permissionFor(settings),
        systemPrompt: renderTaskSystemPrompt({
          task,
          settings,
          now: this.clock(),
          ...(this.personaTemplate === undefined ? {} : { personaTemplate: this.personaTemplate }),
        }),
        model: settings.models.worker,
        signal: lifetime,
      })
      run.session = session
      started = true
      this.onStarted?.(task.id, session.sessionId)
      this.logger?.info?.(`dsh-whale-chan: task ${task.id} started in session ${session.sessionId}`)

      const requestId = taskRequestId(task)
      await this.host.deliver(session, { requestId, text: renderTaskMessage(task) })
      // A task has one turn, so its overall budget is also the wait budget; it
      // never drops below one model turn, or a one-minute task would cut a slow
      // first token before the model could answer.
      const timeoutMs = Math.max(settings.tasks.timeoutMinutes * 60_000, MODEL_TURN_TIMEOUT_MS)
      // Same contract as the replier: wait on the id the log actually holds.
      const awaitOptions: AwaitTurnOptions = { requestId: deliveryId(requestId), timeoutMs, signal: lifetime }
      const end = await this.host.awaitTurnEnd(session, awaitOptions)
      const final = await this.host.readFinalText(session)
      result = await this.ending(task, end, final.text, run)
      return result
    } catch (error) {
      // A refusal or failure before the session exists is the caller's to
      // handle: nothing is running, so there is no ending to report.
      if (!started) throw error
      result = {
        outcome: run.cancelled ? 'cancelled' : 'failed',
        summary: '',
        sessionId: run.session?.sessionId ?? run.sessionId,
        error: run.cancelled ? 'cancelled' : describe(error),
      }
      return result
    } finally {
      this.runs.delete(task.id)
      if (started && result !== undefined) {
        try {
          this.onFinished?.(task.id, result)
        } catch (error) {
          // A listener must not change the result the caller is about to get.
          this.logger?.warn?.(`dsh-whale-chan: onFinished failed for ${task.id}: ${describe(error)}`)
        }
      }
    }
  }

  /** Cancel one running task. Returns `false` when nothing runs under that id. */
  async cancel(taskId: string, reason?: string): Promise<boolean> {
    const run = this.runs.get(taskId)
    if (run === undefined) return false
    if (run.cancelled) return true
    run.cancelled = true
    run.reason = reason
    // Abort our own lifetime first so the pending wait settles as `aborted`
    // before the host's turn cancellation is observed.
    run.controller.abort()
    const ref = run.session ?? { sessionId: run.sessionId, workspace: '' }
    try {
      await this.host.cancel(ref, reason ?? 'the task was cancelled')
    } catch (error) {
      this.logger?.warn?.(`dsh-whale-chan: cancelling task ${taskId} failed: ${describe(error)}`)
    }
    return true
  }

  /**
   * Abort every running task and stop its session turn; the host stays usable.
   *
   * The returned promise settles only after each session cancellation was
   * attempted, so a composition root that disposes during shutdown knows the
   * worker turns are no longer running when it continues.
   */
  async dispose(): Promise<void> {
    const runs = [...this.runs.values()]
    for (const run of runs) {
      run.cancelled = true
      run.controller.abort()
    }
    for (const run of runs) {
      if (run.session === undefined) continue
      try {
        await this.host.cancel(run.session, 'the executor was disposed')
      } catch (error) {
        this.logger?.warn?.(`dsh-whale-chan: cancelling a session on dispose failed: ${describe(error)}`)
      }
    }
  }

  /** Map one turn ending plus the worker's final text onto the executor result. */
  private async ending(task: Task, end: TurnEndOutcome, text: string, run: Run): Promise<ExecutorResult> {
    const sessionId = run.session?.sessionId ?? run.sessionId
    const summary = text.trim()
    switch (end.status) {
      case 'completed':
        return { outcome: 'succeeded', summary, sessionId }
      case 'timeout': {
        if (run.session !== undefined) {
          await this.host.cancel(run.session, `task ${task.id} timed out`)
        }
        return { outcome: 'timeout', summary, sessionId, error: 'timeout' }
      }
      case 'aborted':
        return {
          outcome: 'cancelled',
          summary,
          sessionId,
          error: run.reason === undefined ? 'cancelled' : `cancelled: ${run.reason}`,
        }
      case 'failed':
        return {
          outcome: 'failed',
          summary,
          sessionId,
          error: end.detail === undefined ? 'failed' : `failed: ${end.detail}`,
        }
    }
  }

  private assertApproved(task: Task, approval: Approval): void {
    if (approval.status !== 'approved' || task.status !== 'approved' || approval.taskId !== task.id) {
      throw new UserError('notApproved', { taskId: task.id })
    }
  }

  private async prepareWorkspace(task: Task, settings: Settings, approved?: string): Promise<string> {
    const workspace = resolveTaskWorkspace({
      taskId: task.id,
      settings,
      ...(approved === undefined ? {} : { approved }),
      home: this.homeDir,
      stateDir: this.stateDir,
    })
    await this.makeDirectory(workspace)
    return workspace
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 400)
  return String(error).slice(0, 400)
}
