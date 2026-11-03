/**
 * Wire view builders for the management API.
 *
 * The domain and the browser deliberately use different vocabularies: the
 * domain's `approved` task is the panel's `queued` task, a thread has counters
 * instead of an unread badge, and an audit row is one committed domain event.
 * This module is the only place that translates between the two, so a route
 * never hand-builds a response and `tests/contract.spec.ts` can type-check the
 * result against the frozen `src/shared/models.ts`.
 */
import type {
  Approval,
  Clock,
  InboundMessage,
  Task as DomainTask,
  TaskStatus as DomainTaskStatus,
  Thread,
} from '../core/index.ts'
import type { TargetKind } from '../shared/limits.ts'
import { TARGET_KINDS } from '../shared/limits.ts'
import type {
  Approval as ApprovalView,
  AuditEntry,
  AuditPage,
  Health,
  HealthCheck,
  HealthStatus,
  MessageView,
  Overview,
  StateView,
  Target,
  TargetWorkspace,
  TargetsView,
  Task as TaskView,
  TaskDetail,
  TasksPage,
  TaskStatus as SharedTaskStatus,
  ThreadDetail,
  ThreadSummary,
  ThreadsPage,
} from '../shared/models.ts'
import type { SettingsService } from './settings.ts'
import type { Effects } from './effects.ts'
import type { ChannelPort } from './channel-port.ts'
import type { Store } from './store.ts'
import type { ListOptions } from './store-read.ts'
import type { RuntimeFacts, RuntimeInfo, RuntimeServiceStatus } from './runtime.ts'

/** Everything a read-only view may observe. */
export interface ViewContext {
  readonly runtime: {
    info(): RuntimeInfo
    facts(): RuntimeFacts
    /** Live service status; absent only on a bare state-view stub. */
    status?(): RuntimeServiceStatus
  }
  readonly settings: SettingsService
  readonly store: Store
  readonly clock: Clock
  readonly effects: Effects
  /** The attached channel, when the runtime composed one. */
  readonly channel?: ChannelPort
}

/** The minimum a state view needs, so WS0 tests can keep passing a stub. */
export interface StateRuntime {
  info(): RuntimeInfo
}

/** Project the live runtime into the frozen `GET state` response. */
export function stateView(runtime: StateRuntime): StateView {
  const info = runtime.info()
  return {
    ok: true,
    name: info.name,
    version: info.version,
    stateDir: info.stateDir,
    startedAt: info.startedAt,
  }
}

/**
 * The domain's `approved` state is the panel's `queued` state.
 *
 * `src/shared/models.ts` never exposes `approved`: from the panel's point of
 * view an approved task is waiting for the executor, which is exactly `queued`.
 */
const DOMAIN_TO_SHARED_STATUS: Readonly<Record<DomainTaskStatus, SharedTaskStatus>> = {
  captured: 'captured',
  'awaiting-approval': 'awaiting-approval',
  approved: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'expired',
}

const SHARED_TO_DOMAIN_STATUS: Readonly<Record<SharedTaskStatus, DomainTaskStatus>> = {
  captured: 'captured',
  'awaiting-approval': 'awaiting-approval',
  queued: 'approved',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'expired',
}

/** Map a shared status name to the domain status it filters, or undefined. */
export function domainTaskStatus(value: string): DomainTaskStatus | undefined {
  return (SHARED_TO_DOMAIN_STATUS as Readonly<Record<string, DomainTaskStatus | undefined>>)[value]
}

export function toTaskView(task: DomainTask): TaskView {
  return {
    id: task.id,
    title: task.title,
    status: DOMAIN_TO_SHARED_STATUS[task.status],
    threadKey: task.threadKey,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    approvalId: task.approvalId,
  }
}

export function toApprovalView(approval: Approval): ApprovalView {
  return {
    id: approval.id,
    taskId: approval.taskId,
    status: approval.status,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    decidedAt: approval.decidedAt,
    decidedBy: approval.decidedBy,
  }
}

export function toMessageView(message: InboundMessage): MessageView {
  return {
    id: message.id,
    threadKey: message.threadKey,
    direction: 'incoming',
    senderId: message.sender.userId,
    senderName: message.sender.nick,
    text: message.text,
    sentAt: message.at,
  }
}

function toThreadSummary(thread: Thread): ThreadSummary {
  return {
    key: thread.key,
    title: thread.title,
    kind: thread.kind,
    lastMessageAt: thread.lastMessageAt,
    // Unread is a channel concern; the domain only counts inbound messages.
    unreadCount: 0,
    // A thread may own several tasks, so no single task id is authoritative.
    taskId: null,
  }
}

/** The target fields a workspace projection reads; the row itself is not exposed here. */
export interface TargetWorkspaceInput {
  readonly kind: TargetKind
  readonly id: string
  readonly label: string
}

/** Fills the read-only workspace field of a target row. */
export type TargetWorkspaceResolver = (target: TargetWorkspaceInput) => TargetWorkspace

/**
 * One target row as the panel edits it.
 *
 * The workspace field is read-only and derived, never stored: `ready` targets
 * have one concrete directory, while a global subscription or a send-only open
 * id reports `per-conversation` because its directory is created by the first
 * message. Without a resolver (an older composition) the field is omitted
 * rather than guessed.
 */
export function targetsView(settings: SettingsService, resolveWorkspace?: TargetWorkspaceResolver): TargetsView {
  const rows = settings.current().targets.rows
  return {
    targets: rows.map(
      (row): Target => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        enabled: row.enabled,
        mentionOnly: row.mentionOnly,
        replyMode: row.replyMode,
        ...(resolveWorkspace === undefined ? {} : { workspace: resolveWorkspace(row) }),
      }),
    ),
    supportedKinds: TARGET_KINDS,
  }
}

/** One page of conversations, newest activity first. */
export function threadsView(store: Store, options: ListOptions = {}): ThreadsPage {
  const page = store.read.listThreads(options)
  return { items: page.items.map(toThreadSummary), nextOffset: page.nextOffset }
}

/** One conversation with a page of its messages; undefined when it is unknown. */
export function threadView(
  store: Store,
  key: string,
  options: { readonly before?: string; readonly limit?: number } = {},
): ThreadDetail | undefined {
  const thread = store.threads.get(key)
  if (!thread) return undefined
  const page = store.read.threadMessages(key, options)
  return {
    thread: toThreadSummary(thread),
    messages: page.items.map(toMessageView),
    nextBefore: page.nextBefore,
  }
}

/** One page of tasks, newest update first. */
export function tasksView(
  store: Store,
  options: { readonly status?: DomainTaskStatus; readonly offset?: number; readonly limit?: number } = {},
): TasksPage {
  const page = store.read.listTasks(options)
  return { items: page.items.map(toTaskView), nextOffset: page.nextOffset }
}

/** One task with its approval and the latest messages of its thread. */
export function taskDetailView(store: Store, id: string): TaskDetail | undefined {
  const task = store.tasks.get(id)
  if (!task) return undefined
  const approval = store.approvals.byTaskId(id)
  const messages = store.read.threadMessages(task.threadKey, { limit: 50 })
  return {
    task: toTaskView(task),
    approval: approval === undefined ? null : toApprovalView(approval),
    messages: messages.items.map(toMessageView),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The most specific identifier a domain event carries. */
function auditTarget(data: unknown): string {
  if (!isRecord(data)) return ''
  for (const key of ['taskId', 'threadKey', 'decisionId', 'messageId', 'outboundId', 'assignmentId']) {
    const value = data[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

const OWNER_ACTIONS = new Set(['task.approved', 'task.rejected', 'task.cancelled', 'task.retried'])

function toAuditEntry(record: { seq: number; type: string; at: string; data: unknown }): AuditEntry {
  return {
    id: String(record.seq),
    at: record.at,
    actor: OWNER_ACTIONS.has(record.type) ? 'owner' : 'assistant',
    action: record.type,
    target: auditTarget(record.data),
    outcome: 'ok',
  }
}

/** One page of the durable audit log, newest first. */
export function auditView(store: Store, options: ListOptions = {}): AuditPage {
  const page = store.read.audit(options)
  return { items: page.items.map(toAuditEntry), nextOffset: page.nextOffset }
}

/** Worst-of rollup over the checks the host itself owns. */
function rollup(checks: readonly HealthCheck[]): HealthStatus {
  if (checks.some((check) => check.status === 'error')) return 'error'
  if (checks.some((check) => check.status === 'degraded')) return 'degraded'
  return 'ok'
}

/**
 * Host health.
 *
 * The host-owned checks decide the overall status. Once the channel and the
 * executor are attached, their checks are host-owned too: an expired `dws`
 * authorization or a channel that failed to start is a real error, not an
 * unknown. Pausing the monitor is intentional and stays `ok`.
 */
export function healthView(ctx: ViewContext): Health {
  const info = ctx.runtime.info()
  const facts = ctx.runtime.facts()
  const settings = ctx.settings.current()
  const observedAt = ctx.clock.now().toISOString()
  const warnings = ctx.settings.warnings()
  const status = ctx.runtime.status?.()
  const check = (id: string, value: HealthStatus, detail: string): HealthCheck => ({
    id,
    status: value,
    detail,
    observedAt,
  })
  const checks: HealthCheck[] = [
    check('state', 'ok', `started at ${info.startedAt}`),
    check('stateDir', facts.stateDirWritable ? 'ok' : 'error', facts.stateDirWritable ? 'writable' : 'not writable'),
    check('database', facts.databaseOpen ? 'ok' : 'error', `schema v${facts.schemaVersion}`),
    check(
      'lock',
      facts.lockHeld ? 'ok' : 'degraded',
      facts.lockHeld ? 'state directory lock is held' : 'state directory lock is not held',
    ),
    check(
      'settings',
      warnings.length > 0 ? 'degraded' : 'ok',
      warnings.length > 0
        ? warnings.map((warning) => `${warning.block}: ${warning.message}`).join('; ')
        : 'every block loaded from state.db',
    ),
  ]
  const owned = [...checks]

  if (status === undefined) {
    checks.push(
      ctx.channel === undefined
        ? check('channel', 'degraded', 'unknown: the DingTalk channel is not attached')
        : check('channel', 'ok', 'channel attached'),
      check('executor', 'degraded', 'unknown: the task executor is not attached'),
    )
    return finishHealth(checks, owned, settings.dws.binaryPath, false, null)
  }

  const promptsCheck = check(
    'prompts',
    status.promptsReady ? 'ok' : 'error',
    status.promptsReady ? 'all five templates loaded' : `templates unavailable (${status.promptError ?? 'unknown'})`,
  )
  const effectsCheck = check(
    'effects',
    status.effectsDead > 0 ? 'degraded' : 'ok',
    `${status.effectsPending} pending, ${status.effectsDead} dead`,
  )
  checks.push(promptsCheck, effectsCheck)
  owned.push(promptsCheck, effectsCheck)

  const attached = status.auth !== null || status.monitorRunning || status.channelError !== null
  const authCheck = authHealth(status, check)
  const channelCheck = channelHealth(
    status,
    authCheck,
    check,
    settings.monitor.enabled,
    settings.targets.rows.filter((row) => row.enabled).length,
  )
  checks.push(channelCheck, authCheck)
  if (attached) owned.push(channelCheck, authCheck)

  const executor = !status.executorAttached
    ? check('executor', 'degraded', 'unknown: the task executor is not attached')
    : status.executorActive.length === 0
      ? check('executor', 'ok', 'idle')
      : check('executor', 'ok', `${status.executorActive.length} task(s) running`)
  checks.push(executor)
  if (status.executorAttached) owned.push(executor)

  return finishHealth(
    checks,
    owned,
    settings.dws.binaryPath,
    status.auth?.available ?? false,
    status.auth?.authenticated ?? null,
  )
}

function authHealth(status: RuntimeServiceStatus, check: CheckFactory): HealthCheck {
  if (status.auth === null) return check('auth', 'degraded', 'unknown: the channel is not attached')
  if (!status.auth.available) return check('auth', 'error', 'dws is not available')
  if (!status.auth.authenticated) return check('auth', 'error', 'dws is not logged in')
  if (!status.auth.tokenValid) return check('auth', 'error', 'the dws authorization is no longer valid')
  if (!status.ownerKnown)
    return check('auth', 'error', 'authorization did not report an account id; no subscription may start')
  return check('auth', 'ok', 'dws authorization is valid')
}

/**
 * Project one channel state into a health check.
 *
 * "Stopped" is not automatically unhealthy: the owner can disable monitoring,
 * pause the assistant, or configure no enabled target at all. Those are normal
 * idle states and stay `ok`; only a channel that should be subscribed but is
 * not gets `degraded`.
 */
function channelHealth(
  status: RuntimeServiceStatus,
  auth: HealthCheck,
  check: CheckFactory,
  monitoringEnabled: boolean,
  enabledTargets: number,
): HealthCheck {
  if (auth.status === 'error') return check('channel', 'error', 'not subscribed because authorization is invalid')
  if (!monitoringEnabled) return check('channel', 'ok', 'monitoring is disabled in settings')
  if (status.paused) return check('channel', 'ok', 'paused by the owner')
  if (!status.channelAttached) return check('channel', 'degraded', 'unknown: the DingTalk channel is not attached')
  if (status.channelError !== null) {
    return check('channel', 'error', `the channel could not start (${status.channelError})`)
  }
  if (status.channelState === 'ready') {
    return check('channel', 'ok', `ready; ${status.channelTargets.length} target(s)`)
  }
  if (status.channelState === 'starting') return check('channel', 'degraded', 'starting')
  if (status.channelState === 'degraded') return check('channel', 'degraded', 'some subscriptions are unhealthy')
  if (enabledTargets === 0) return check('channel', 'ok', 'idle: no enabled targets')
  return check('channel', 'degraded', 'not running')
}

type CheckFactory = (id: string, value: HealthStatus, detail: string) => HealthCheck

function finishHealth(
  checks: readonly HealthCheck[],
  owned: readonly HealthCheck[],
  binaryPath: string,
  available: boolean,
  authenticated: boolean | null,
): Health {
  const status = rollup(owned)
  return { ok: status === 'ok', status, checks, dws: { binaryPath, available, authenticated } }
}

/** Aggregate counters for the overview page. */
export function overviewView(ctx: ViewContext): Overview {
  const settings = ctx.settings.current()
  const counts = ctx.store.read.counts(ctx.clock.now())
  const tasks = Object.values(counts.tasks).reduce((total, value) => total + value, 0)
  const status = ctx.runtime.status?.()
  return {
    generatedAt: ctx.clock.now().toISOString(),
    monitor: {
      enabled: settings.monitor.enabled,
      paused: settings.monitor.paused,
      running: status?.monitorRunning ?? false,
    },
    counts: {
      targets: settings.targets.rows.filter((row) => row.enabled).length,
      threads: counts.threads,
      tasks,
      awaitingApproval: counts.tasks['awaiting-approval'],
    },
    health: healthView(ctx),
  }
}

/** Kinds a discovery request may name; exported for route validation. */
export function isTargetKind(value: unknown): value is TargetKind {
  return typeof value === 'string' && (TARGET_KINDS as readonly string[]).includes(value)
}
