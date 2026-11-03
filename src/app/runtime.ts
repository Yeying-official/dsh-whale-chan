/**
 * Host runtime: one state directory, one database, one settings service, and —
 * when a Cordis host or test overrides are supplied — the channel, the reply
 * pipeline and the task executor.
 *
 * Startup is one ordered sequence so a failure leaves nothing half-open:
 *
 * 1. create the directory, take the lock, open `state.db`, migrate;
 * 2. build settings, the domain engine and the effects queue;
 * 3. preload the prompt templates (a failure is reported, never guessed around);
 * 4. probe `dws` authorization; no owner means no subscription;
 * 5. build the replier model, retrieval and executor, register every effect
 *    handler, then start the queue and the passes;
 * 6. start the channel only when prompts loaded and the owner is known.
 *
 * `stop()` reverses the list: the queue drains, the channel converges, the
 * executor and the replier sessions are disposed, the passes stop, then the
 * database closes and the lock is released. It is idempotent, and a stop that
 * races startup still releases everything already open.
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import type { Clock, InboundMessage, Outbound } from '../core/index.ts'
import { Engine } from '../core/index.ts'
import type { PromptSource, ResearchPort } from '../brain/index.ts'
import { defaultPromptStore } from '../brain/index.ts'
import type { ChannelLogger } from '../channel/index.ts'
import {
  DshResearch,
  DshSessionHost,
  DshTaskExecutor,
  SessionModel,
  type ExecutorLogger,
  type SessionHost,
  type TaskExecutor,
} from '../executor/index.ts'
import { PLUGIN_NAME, PLUGIN_VERSION, type LogLevel } from '../shared/limits.ts'
import type { Health, StateView } from '../shared/models.ts'
import type { ModelRoute, SettingsBlock } from '../shared/settings.ts'
import { SETTINGS_BLOCKS } from '../shared/settings.ts'
import type { BrainModelFactory } from './brain-ports.ts'
import type { ChannelPort } from './channel-port.ts'
import type {
  ChannelAuthState,
  ChannelHealthState,
  ChannelRuntime,
  ChannelSendDetail,
  ChannelTargetHealth,
} from './channel-runtime.ts'
import { KvCounterStore } from './counters.ts'
import type { DeploymentConfig } from './deployment.ts'
import { createDingTalkChannel } from './dingtalk-channel.ts'
import { decisionForOutbound } from './effects-chat.ts'
import { Effects } from './effects.ts'
import { Kv } from './kv.ts'
import { Passes } from './passes.ts'
import { Pipeline } from './pipeline.ts'
import { SettingsService } from './settings.ts'
import { Store } from './store.ts'
import { healthView, stateView, type ViewContext } from './views.ts'

/** How long a lock left by a dead process is honoured before it is reclaimed. */
export const LOCK_STALE_MS = 10_000

/** Delay before reacting to a target or `dws` settings change. */
export const CHANNEL_RESTART_DEBOUNCE_MS = 500

/** Concurrent effect attempts: send/classify stay responsive while a task runs. */
export const EFFECT_CONCURRENCY = 8

/** Expand a leading `~` and return an absolute state-directory path. */
export function resolveStateDir(raw: string, home = homedir()): string {
  const value = raw.trim()
  if (!value) throw new Error('stateDir must not be empty')
  if (value === '~') return resolve(home)
  // Match exactly one separator after `~`: `~/x` and the Windows form.
  const homePrefixes = ['~/', `~${String.fromCharCode(92)}`] as const
  if (homePrefixes.some((prefix) => value.startsWith(prefix))) {
    return resolve(join(home, value.slice(2)))
  }
  if (!isAbsolute(value)) throw new Error('stateDir must be an absolute path or start with ~')
  return resolve(value)
}

export interface RuntimeInfo {
  readonly name: string
  readonly version: string
  readonly stateDir: string
  readonly startedAt: string
}

/** Facts the health view reports about the open runtime. */
export interface RuntimeFacts {
  readonly stateDirWritable: boolean
  readonly lockHeld: boolean
  readonly databaseOpen: boolean
  readonly schemaVersion: number
}

/** The service state the health and overview views project; no ids or text. */
export interface RuntimeServiceStatus {
  readonly monitorRunning: boolean
  readonly paused: boolean
  readonly channelAttached: boolean
  readonly executorAttached: boolean
  /** Whether authorization named an account; a subscription must not start without it. */
  readonly ownerKnown: boolean
  readonly channelState: ChannelHealthState['state']
  readonly channelTargets: readonly ChannelTargetHealth[]
  /** Stable reason code of the last channel start failure, when there is one. */
  readonly channelError: string | null
  readonly auth: { readonly available: boolean; readonly authenticated: boolean; readonly tokenValid: boolean } | null
  readonly effectsPending: number
  readonly effectsDead: number
  readonly executorActive: readonly string[]
  readonly promptsReady: boolean
  readonly promptError: string | null
}

/** Timer seam for the settings debounce; tests drive it explicitly. */
export interface RuntimeTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

/** Test seams: every external capability can be replaced. */
export interface RuntimeOverrides {
  readonly channel?: ChannelRuntime
  readonly model?: BrainModelFactory
  readonly research?: ResearchPort
  readonly executor?: TaskExecutor
  readonly sessionHost?: SessionHost
  readonly prompts?: PromptSource & { preload?: () => unknown }
  readonly settings?: Partial<Record<SettingsBlock, Record<string, unknown>>>
  /** Only tests set these; production reads them from settings. */
  readonly command?: string
  readonly baseArgs?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

export interface RuntimeOptions {
  /** Clock seam for tests; production uses the wall clock. */
  readonly now?: () => Date
  /** WS5a management-only channel; kept for the existing HTTP tests. */
  readonly channel?: ChannelPort
  /** Cordis host; absent in pure API tests and in the compose-with-overrides tests. */
  readonly ctx?: Context
  readonly overrides?: RuntimeOverrides
  readonly timers?: RuntimeTimers
}

const DEFAULT_TIMERS: RuntimeTimers = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

async function writable(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function noopLogger(): ChannelLogger & ExecutorLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

function stableReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code.length > 0 ? `${error.name}:${code}` : error.name
  }
  return 'error'
}

/**
 * One long-lived replier session per conversation, rebuilt when the owner
 * changes the persona or the `settings.models.reply` route.
 */
class SessionModelPool implements BrainModelFactory {
  private current: SessionModel
  private route: ModelRoute

  constructor(
    private readonly host: SessionHost,
    private readonly stateDir: string,
    route: ModelRoute,
    private readonly logger: ExecutorLogger,
  ) {
    this.route = { ...route }
    this.current = this.build()
  }

  forThread(threadKey: string, title?: string): ReturnType<SessionModel['forThread']> {
    return this.current.forThread(threadKey, title)
  }

  async reset(): Promise<void> {
    const previous = this.current
    this.current = this.build()
    await previous.dispose()
  }

  async updateRoute(route: ModelRoute): Promise<void> {
    if (sameRoute(this.route, route)) return
    this.route = { ...route }
    await this.reset()
  }

  async dispose(): Promise<void> {
    await this.current.dispose()
  }

  private build(): SessionModel {
    return new SessionModel({
      host: this.host,
      logger: this.logger,
      stateDir: this.stateDir,
      model: this.route,
    })
  }
}

function sameRoute(left: ModelRoute, right: ModelRoute): boolean {
  return left.provider === right.provider && left.model === right.model && left.effort === right.effort
}

/** Executor used only to fail clearly when no DSH host is available. */
class UnavailableExecutor implements TaskExecutor {
  async execute(): Promise<never> {
    throw new Error('The DSH host is not attached; a task cannot run')
  }

  async cancel(): Promise<boolean> {
    return false
  }
}

/** Retrieval that is never consulted; used when no `ctx.web` exists. */
const EMPTY_RESEARCH: ResearchPort = { search: async () => ({ facts: [], sources: [] }) }

export class Runtime {
  readonly name = PLUGIN_NAME
  readonly version = PLUGIN_VERSION
  readonly stateDir: string
  readonly startedAt: string
  readonly logLevel: LogLevel
  readonly ready: Promise<void>
  private readonly time: Clock
  private readonly ctx: Context | undefined
  private readonly overrides: RuntimeOverrides
  private readonly timers: RuntimeTimers
  private readonly lifetimeController = new AbortController()
  private readonly idSource = { next: (prefix: string) => `${prefix}-${randomUUID()}` }
  private storeRef: Store | undefined
  private settingsRef: SettingsService | undefined
  private engineRef: Engine | undefined
  private effectsRef: Effects | undefined
  private passesRef: Passes | undefined
  private pipelineRef: Pipeline | undefined
  private modelRef: BrainModelFactory | undefined
  private executorRef: TaskExecutor | undefined
  private hostRef: SessionHost | undefined
  private managementChannel: ChannelRuntime | undefined
  private runningChannel: ChannelRuntime | undefined
  private channelPortRef: ChannelPort | undefined
  private countersRef: KvCounterStore | undefined
  private promptsRef: PromptSource | undefined
  private promptsReady = false
  private promptError: string | null = null
  private auth: ChannelAuthState | undefined
  private channelSignature = ''
  private channelError: string | null = null
  private unsubscribeSettings: (() => void) | undefined
  private restartTimer: unknown
  private channelChain: Promise<void> = Promise.resolve()
  private releaseLock: (() => Promise<void>) | undefined
  private releasePromise: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private lockCompromised = false
  private stateDirWritable = false
  private closing = false
  private stopping: Promise<void> | undefined

  constructor(config: DeploymentConfig, options: RuntimeOptions = {}) {
    this.stateDir = resolveStateDir(config.stateDir)
    this.logLevel = config.logLevel
    this.startedAt = (options.now?.() ?? new Date()).toISOString()
    const now = options.now ?? (() => new Date())
    this.time = { now: () => new Date(now()) }
    this.ctx = options.ctx
    this.overrides = options.overrides ?? {}
    this.timers = options.timers ?? DEFAULT_TIMERS
    this.channelPortRef = options.channel
    this.ready = this.prepare()
  }

  /** The open state database; throws before `ready` has settled successfully. */
  get store(): Store {
    return this.require(this.storeRef, 'store')
  }

  /** The durable settings service; throws before `ready` has settled successfully. */
  get settings(): SettingsService {
    return this.require(this.settingsRef, 'settings')
  }

  /** The domain engine bound to the open database. */
  get engine(): Engine {
    return this.require(this.engineRef, 'engine')
  }

  /** The effects queue, constructed but not started until startup composes it. */
  get effects(): Effects {
    return this.require(this.effectsRef, 'effects')
  }

  /** Clock seam shared by settings, engine and effects. */
  get clock(): Clock {
    return this.time
  }

  /** The management channel surface; absent on an API-only runtime. */
  get channel(): ChannelPort | undefined {
    return this.channelPortRef ?? this.managementChannel ?? this.runningChannel
  }

  info(): RuntimeInfo {
    return {
      name: this.name,
      version: this.version,
      stateDir: this.stateDir,
      startedAt: this.startedAt,
    }
  }

  /** Facts for the health view; safe to call before startup settles. */
  facts(): RuntimeFacts {
    return {
      stateDirWritable: this.stateDirWritable,
      lockHeld: this.releaseLock !== undefined && !this.lockCompromised,
      databaseOpen: this.storeRef !== undefined,
      schemaVersion: this.storeRef?.schemaVersion() ?? 0,
    }
  }

  /** Real service values for the health view; no identifiers or message text. */
  status(): RuntimeServiceStatus {
    const settings = this.settingsRef?.current()
    return {
      monitorRunning: this.runningChannel !== undefined && this.runningChannel.health().running,
      paused: settings?.monitor.paused ?? false,
      channelAttached: this.channel !== undefined,
      executorAttached: this.pipelineRef !== undefined && this.executorRef !== undefined,
      ownerKnown: (this.auth?.userId ?? '').trim().length > 0,
      channelState: this.channelHealth().state,
      channelTargets: this.channelHealth().targets,
      channelError: this.channelError,
      auth:
        this.auth === undefined
          ? null
          : {
              available: this.auth.available,
              authenticated: this.auth.authenticated,
              tokenValid: this.auth.tokenValid,
            },
      effectsPending: this.effectsRef?.pending().length ?? 0,
      effectsDead: this.effectsRef?.dead().length ?? 0,
      executorActive: this.pipelineRef?.runningTasks() ?? [],
      promptsReady: this.promptsReady,
      promptError: this.promptError,
    }
  }

  /** The frozen `GET state` view. */
  state(): StateView {
    return stateView(this)
  }

  /** The frozen `GET health` view. */
  health(): Health {
    return healthView(this.viewContext())
  }

  /** Everything a view builder may read. */
  viewContext(): ViewContext {
    return {
      runtime: {
        info: () => this.info(),
        facts: () => this.facts(),
        status: () => this.status(),
      },
      settings: this.settings,
      store: this.store,
      clock: this.time,
      effects: this.effects,
      channel: this.channel,
    }
  }

  get closed(): boolean {
    return this.closing
  }

  /**
   * Stop the runtime and release every resource.
   *
   * Repeated calls share one promise. Startup errors are swallowed here: the
   * caller that awaited `ready` already reports them, and unload must not fail
   * because the directory could not be created.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.closing = true
    this.lifetimeController.abort()
    this.clearRestartTimer()
    this.stopping = (async () => {
      await this.ready.catch(() => undefined)
      await this.shutdownComponents()
      await this.releaseResources()
    })()
    return this.stopping
  }

  /** Message sink the channel calls; exposed so tests can drive it directly. */
  receive(message: InboundMessage): void {
    this.pipelineRef?.receive(message)
  }

  /** Resolves once every scheduled channel transition has settled. */
  settled(): Promise<void> {
    return this.channelChain
  }

  /** Run every due pass at `now`; exposed so an operator (and a test) can advance the schedule. */
  async tick(now: Date = this.time.now()): Promise<void> {
    await this.passesRef?.tick(now)
  }

  private async prepare(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    this.stateDirWritable = await writable(this.stateDir)
    this.releaseLock = await this.acquireLock()
    try {
      const store = Store.open(this.stateDir)
      this.storeRef = store
      const settings = new SettingsService(store, this.time)
      this.settingsRef = settings
      this.applySettingsSeed(settings)
      this.engineRef = new Engine({
        repos: store,
        ids: this.idSource,
        clock: this.time,
        // The audit trail is the durable copy of every committed domain event.
        emit: (event) => store.appendEvent(event.type, event.at, event.data),
      })
      this.effectsRef = new Effects(store, { now: () => this.time.now().getTime() })
      this.countersRef = new KvCounterStore(new Kv(store), { now: () => this.time.now().getTime() })
      await this.preparePrompts()
      await this.prepareServices()
      await this.prepareChannel()
      await this.startBackgroundWork()
    } catch (error) {
      await this.shutdownComponents()
      await this.releaseResources()
      throw error
    }
    if (this.closing) {
      await this.shutdownComponents()
      await this.releaseResources()
    }
  }

  private applySettingsSeed(settings: SettingsService): void {
    const seed = this.overrides.settings
    if (!seed) return
    for (const block of SETTINGS_BLOCKS) {
      const patch = seed[block]
      if (patch !== undefined) settings.patchInternal(block, patch)
    }
  }

  private async preparePrompts(): Promise<void> {
    const prompts = this.overrides.prompts ?? defaultPromptStore()
    this.promptsRef = prompts
    try {
      prompts.preload?.()
      this.promptsReady = true
      this.promptError = null
    } catch (error) {
      this.promptsReady = false
      this.promptError = stableReason(error)
      this.log('error', `dsh-whale-chan: prompt templates are unavailable (${this.promptError})`)
    }
  }

  /** Build the brain, the executor and the pipeline; never start them here. */
  private async prepareServices(): Promise<void> {
    if (this.ctx === undefined && !this.overrides.model && !this.overrides.executor) return
    if (!this.promptsReady) return

    const logger = this.executorLogger()
    this.hostRef =
      this.overrides.sessionHost ?? (this.ctx === undefined ? undefined : new DshSessionHost({ ctx: this.ctx, logger }))

    if (this.overrides.model !== undefined) {
      this.modelRef = this.overrides.model
    } else if (this.hostRef !== undefined) {
      this.modelRef = new SessionModelPool(this.hostRef, this.stateDir, this.settings.current().models.reply, logger)
    }

    this.executorRef =
      this.overrides.executor ??
      (this.hostRef === undefined
        ? new UnavailableExecutor()
        : new DshTaskExecutor({
            host: this.hostRef,
            logger,
            stateDir: this.stateDir,
            ...(this.promptsRef === undefined ? {} : { personaTemplate: this.promptsRef.get('persona') }),
          }))
    this.wireExecutor()

    const research =
      this.overrides.research ??
      (this.ctx === undefined ? EMPTY_RESEARCH : new DshResearch({ web: this.ctx.web, logger }))

    this.pipelineRef = new Pipeline({
      engine: this.engine,
      store: this.store,
      settings: this.settings,
      effects: this.effects,
      clock: this.time,
      counters: this.require(this.countersRef, 'counters'),
      model: this.require(this.modelRef, 'model'),
      research,
      prompts: this.require(this.promptsRef, 'prompts'),
      executor: this.require(this.executorRef, 'executor'),
      channel: () => this.runningChannel,
      channelRunning: () => this.runningChannel !== undefined,
      ownerUserId: () => this.auth?.userId ?? '',
      lifetime: this.lifetimeController.signal,
      ids: this.idSource,
      probe: () => this.probe(),
    })
    this.pipelineRef.register()
    this.passesRef = new Passes({
      clock: this.time,
      onError: (name, error) => this.log('warn', `dsh-whale-chan: pass ${name} failed: ${stableReason(error)}`),
    })
    this.passesRef.register(
      'expire',
      () => {
        this.engine.expireTasks(this.time.now())
      },
      {
        intervalMs: 60_000,
        runAtStart: true,
      },
    )
    this.passesRef.register('probe', () => this.probe(), { intervalMs: 5 * 60_000 })
    this.unsubscribeSettings = this.settings.onChange((change) => this.onSettingsChange(change.block))
  }

  /** Wire the executor's callbacks onto the two domain commands they mean. */
  private wireExecutor(): void {
    const executor = this.require(this.executorRef, 'executor')
    executor.onStarted = (taskId, sessionId) => {
      const task = this.engine.task(taskId)
      if (!task?.assignmentId) return
      try {
        this.engine.assignmentStarted(taskId, task.assignmentId, { sessionId })
      } catch (error) {
        this.log('warn', `dsh-whale-chan: assignmentStarted was refused for ${taskId}: ${stableReason(error)}`)
      }
    }
    executor.onFinished = (taskId, result) => {
      const task = this.engine.task(taskId)
      if (!task?.assignmentId) return
      try {
        this.engine.assignmentEnded(taskId, task.assignmentId, {
          outcome: result.outcome,
          result: { summary: result.summary, sessionId: result.sessionId },
        })
      } catch (error) {
        this.log('warn', `dsh-whale-chan: assignmentEnded was refused for ${taskId}: ${stableReason(error)}`)
      }
    }
  }

  private async prepareChannel(): Promise<void> {
    if (this.channelPortRef !== undefined) {
      // A management-only channel (WS5a tests) is never started here.
      this.managementChannel = this.overrides.channel
      return
    }
    if (this.overrides.channel !== undefined) {
      this.managementChannel = this.overrides.channel
      this.channelPortRef = this.overrides.channel
      return
    }
    if (this.ctx === undefined) return
    const management = createDingTalkChannel({
      settings: () => this.settings.current(),
      logger: this.channelLogger(),
      ownerUserId: '',
      ...(this.overrides.command === undefined ? {} : { command: this.overrides.command }),
      ...(this.overrides.baseArgs === undefined ? {} : { baseArgs: this.overrides.baseArgs }),
      ...(this.overrides.env === undefined ? {} : { env: this.overrides.env }),
    })
    this.managementChannel = management
    this.channelPortRef = management
  }

  /** Probe once, then start the queue, the passes and — only if authorized — the channel. */
  private async startBackgroundWork(): Promise<void> {
    if (this.pipelineRef === undefined) return
    await this.probe(false)
    if (this.closing) return
    // The queue and the passes are ready before any subscription can deliver a
    // message, so an inbound event never waits for the effect loop to start.
    this.effectsRef?.start({ concurrency: EFFECT_CONCURRENCY })
    this.passesRef?.start()
    if (this.promptsReady && this.authorized()) {
      await this.startChannel()
      this.channelSignature = this.signature()
      if (this.runningChannel !== undefined) this.resumeOutbox()
    }
  }

  private authorized(): boolean {
    const auth = this.auth
    return (
      auth !== undefined &&
      auth.available &&
      auth.authenticated &&
      auth.tokenValid &&
      (auth.userId ?? '').trim().length > 0
    )
  }

  /** Probe authorization and bring the subscription in line with it. */
  private async probe(reconcile = true): Promise<void> {
    const probe = this.managementChannel ?? this.overrides.channel
    if (probe === undefined) {
      this.auth = {
        available: false,
        authenticated: false,
        tokenValid: false,
      }
      return
    }
    try {
      this.auth = await probe.probeAuth()
    } catch (error) {
      this.auth = { available: false, authenticated: false, tokenValid: false }
      this.log('warn', `dsh-whale-chan: the authorization probe failed: ${stableReason(error)}`)
    }
    if (!this.authorized()) {
      await this.stopChannel()
      return
    }
    if (reconcile) this.requestReconcile(0)
  }

  private onSettingsChange(block: SettingsBlock): void {
    if (block === 'persona') {
      void this.resetModel()
      return
    }
    if (block === 'models') {
      void this.applyModelRoute()
      return
    }
    if (block === 'monitor') {
      // Pause/resume must take effect promptly; a stop is cheap and idempotent.
      this.requestReconcile(0)
      return
    }
    if (block === 'targets' || block === 'dws') {
      this.requestReconcile(CHANNEL_RESTART_DEBOUNCE_MS)
    }
  }

  private async resetModel(): Promise<void> {
    try {
      await this.modelRef?.reset()
    } catch (error) {
      this.log('warn', `dsh-whale-chan: could not reset the replier session: ${stableReason(error)}`)
    }
  }

  private async applyModelRoute(): Promise<void> {
    try {
      await this.modelRef?.updateRoute(this.settings.current().models.reply)
    } catch (error) {
      this.log('warn', `dsh-whale-chan: could not apply the reply model route: ${stableReason(error)}`)
    }
  }

  private requestReconcile(delayMs: number): void {
    this.clearRestartTimer()
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = undefined
      void this.reconcile()
    }, delayMs)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer === undefined) return
    this.timers.clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }

  /** Serialize channel transitions so a stop and a start cannot interleave. */
  private reconcile(): Promise<void> {
    this.channelChain = this.channelChain.then(
      () => this.applyChannelState(),
      () => this.applyChannelState(),
    )
    return this.channelChain
  }

  private async applyChannelState(): Promise<void> {
    if (this.closing || this.pipelineRef === undefined) return
    const settings = this.settings.current()
    const shouldRun = this.promptsReady && this.authorized() && settings.monitor.enabled && !settings.monitor.paused
    if (!shouldRun) {
      await this.stopChannel()
      return
    }
    const signature = this.signature()
    if (this.runningChannel === undefined) {
      await this.startChannel()
      if (this.runningChannel !== undefined) this.channelSignature = signature
      return
    }
    if (signature !== this.channelSignature) {
      await this.stopChannel()
      await this.startChannel()
      if (this.runningChannel !== undefined) this.channelSignature = signature
    }
  }

  private signature(): string {
    const settings = this.settings.current()
    return JSON.stringify({
      targets: settings.targets.rows,
      dws: settings.dws,
      monitor: { enabled: settings.monitor.enabled, paused: settings.monitor.paused },
      owner: this.auth?.userId ?? '',
    })
  }

  private async startChannel(): Promise<void> {
    if (this.closing || this.pipelineRef === undefined || !this.promptsReady || !this.authorized()) return
    if (this.runningChannel !== undefined) return
    const owner = (this.auth?.userId ?? '').trim()
    if (owner.length === 0) return
    const channel =
      this.overrides.channel ??
      createDingTalkChannel({
        settings: () => this.settings.current(),
        logger: this.channelLogger(),
        ownerUserId: owner,
        ...(this.overrides.command === undefined ? {} : { command: this.overrides.command }),
        ...(this.overrides.baseArgs === undefined ? {} : { baseArgs: this.overrides.baseArgs }),
        ...(this.overrides.env === undefined ? {} : { env: this.overrides.env }),
      })
    try {
      await channel.start((message) => this.receive(message))
      this.runningChannel = channel
      this.channelError = null
      this.resumeOutbox()
    } catch (error) {
      this.runningChannel = undefined
      this.channelError = stableReason(error)
      this.log('error', `dsh-whale-chan: the channel could not start (${this.channelError})`)
    }
  }

  private async stopChannel(): Promise<void> {
    const channel = this.runningChannel
    this.runningChannel = undefined
    this.channelSignature = ''
    if (channel === undefined) return
    try {
      await channel.stop()
    } catch (error) {
      this.log('warn', `dsh-whale-chan: stopping the channel failed: ${stableReason(error)}`)
    }
  }

  /**
   * Re-enqueue every pending outbound row.
   *
   * This is the crash recovery path: the row is the durable record, and the
   * send handler re-checks `pending`, so a message that was already delivered
   * is never sent twice. Only a running channel is worth resuming into.
   */
  resumeOutbox(): void {
    if (this.runningChannel === undefined) return
    for (const outbound of this.engine.pendingOutbounds()) {
      this.enqueueSend(outbound)
    }
  }

  private enqueueSend(outbound: Outbound): void {
    const decision = decisionForOutbound(this.store, outbound.id)
    this.effects.enqueue('send', outbound.id, {
      outboundId: outbound.id,
      ...(decision === undefined ? {} : { decisionId: decision.id, threadKey: decision.threadKey }),
    })
  }

  private channelHealth(): ChannelHealthState {
    const channel = this.runningChannel ?? this.managementChannel
    return channel?.health() ?? { state: 'stopped', running: false, targets: [] }
  }

  private channelLogger(): ChannelLogger {
    return {
      debug: (message) => this.log('debug', message),
      info: (message) => this.log('info', message),
      warn: (message) => this.log('warn', message),
      error: (message) => this.log('error', message),
    }
  }

  private executorLogger(): ExecutorLogger & ChannelLogger {
    if (this.ctx === undefined) return noopLogger()
    const logger = this.ctx.logger
    return {
      debug: (message) => logger.debug(message),
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
      error: (message) => logger.error(message),
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const logger = this.ctx?.logger
    if (logger === undefined) return
    logger[level](message)
  }

  private async shutdownComponents(): Promise<void> {
    this.shutdownPromise ??= this.shutdownNow()
    await this.shutdownPromise
  }

  private async shutdownNow(): Promise<void> {
    this.unsubscribeSettings?.()
    this.unsubscribeSettings = undefined
    this.clearRestartTimer()
    try {
      await this.channelChain
    } catch {
      // The chain records its own failures; shutdown continues.
    }
    try {
      await this.effectsRef?.drain()
    } catch (error) {
      this.log('warn', `dsh-whale-chan: draining effects failed: ${stableReason(error)}`)
    }
    await this.stopChannel()
    try {
      await (this.executorRef as { dispose?: () => Promise<void> } | undefined)?.dispose?.()
    } catch (error) {
      this.log('warn', `dsh-whale-chan: disposing the executor failed: ${stableReason(error)}`)
    }
    try {
      await this.modelRef?.dispose()
    } catch (error) {
      this.log('warn', `dsh-whale-chan: disposing the replier model failed: ${stableReason(error)}`)
    }
    try {
      await this.passesRef?.stop()
    } catch (error) {
      this.log('warn', `dsh-whale-chan: stopping passes failed: ${stableReason(error)}`)
    }
    try {
      await this.hostRef?.dispose()
    } catch (error) {
      this.log('warn', `dsh-whale-chan: disposing the session host failed: ${stableReason(error)}`)
    }
    this.pipelineRef = undefined
    this.modelRef = undefined
    this.executorRef = undefined
    this.hostRef = undefined
    this.passesRef = undefined
    this.countersRef = undefined
    this.promptsRef = undefined
    this.managementChannel = undefined
    this.channelPortRef = undefined
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    try {
      return await lock(this.stateDir, {
        lockfilePath: join(this.stateDir, '.lock'),
        stale: LOCK_STALE_MS,
        retries: 0,
        realpath: false,
        onCompromised: () => {
          this.lockCompromised = true
        },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
        throw new Error(
          `The state directory is already in use by another process: ${this.stateDir}. ` +
            'Stop the other instance, or point this one at a different stateDir.',
        )
      }
      throw error
    }
  }

  private releaseResources(): Promise<void> {
    this.releasePromise ??= this.releaseNow()
    return this.releasePromise
  }

  private async releaseNow(): Promise<void> {
    const release = this.releaseLock
    this.releaseLock = undefined
    if (release) {
      try {
        await release()
      } catch {
        // The lock was already reclaimed as stale; nothing left to release.
      }
    }
    const store = this.storeRef
    this.storeRef = undefined
    this.settingsRef = undefined
    this.engineRef = undefined
    this.effectsRef = undefined
    if (store) {
      try {
        store.close()
      } catch {
        // Closing twice is harmless; the first close already flushed WAL.
      }
    }
  }

  private require<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new Error(`The runtime is not ready: ${name} is not open`)
    return value
  }
}
