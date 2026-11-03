/**
 * Test doubles for the WS5b composition root.
 *
 * Every external capability is replaced: the channel records subscriptions and
 * sends, the model answers a classifier JSON or a reply body from one script,
 * retrieval records its query and the executor records the request it was
 * given. The real Runtime, SQLite store, settings service, effects queue and
 * passes stay in place, so a test exercises the actual startup, persistence and
 * shutdown ordering.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { InboundMessage, Outbound } from '../../src/core/index.ts'
import type { ModelPort, ModelRequest, ResearchHit, ResearchPort } from '../../src/brain/index.ts'
import type { ExecutorRequest, ExecutorResult, TaskExecutor } from '../../src/executor/index.ts'
import type { SettingsBlock } from '../../src/shared/settings.ts'
import type { TargetKind } from '../../src/shared/limits.ts'
import type { TargetCandidate, TargetDraft, TargetValidation } from '../../src/shared/models.ts'
import type {
  ChannelAuthState,
  ChannelHealthState,
  ChannelRuntime,
  ChannelSendDetail,
} from '../../src/app/channel-runtime.ts'
import type { BrainModelFactory } from '../../src/app/brain-ports.ts'
import { createHttpHandler, httpDeps } from '../../src/app/http.ts'
import { Runtime, type RuntimeOverrides, type RuntimeTimers } from '../../src/app/runtime.ts'
import { createClock, type MutableClock } from './domain.ts'

/** One manually-fired timer; the runtime uses a single debounce. */
export class ManualTimers implements RuntimeTimers {
  private readonly pending = new Map<unknown, { readonly callback: () => void; readonly delayMs: number }>()
  private next = 0

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = { id: (this.next += 1) }
    this.pending.set(handle, { callback, delayMs })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle)
  }

  /** Delays of the timers still scheduled, oldest first. */
  delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.delayMs)
  }

  get size(): number {
    return this.pending.size
  }

  /** Fire every scheduled timer once. */
  fire(): void {
    const timers = [...this.pending.values()]
    this.pending.clear()
    for (const timer of timers) timer.callback()
  }
}

export interface FakeChannelOptions {
  readonly auth?: Partial<ChannelAuthState>
  readonly sendResults?: readonly ChannelSendDetail[]
}

export class FakeChannel implements ChannelRuntime {
  startCalls = 0
  stopCalls = 0
  running = false
  sink: ((message: InboundMessage) => void) | undefined
  readonly sends: Outbound[] = []
  readonly discoveries: { kind: TargetKind; query?: string }[] = []
  readonly validations: TargetDraft[] = []
  readonly sentResults: ChannelSendDetail[] = []
  readonly startErrors: Error[] = []
  auth: ChannelAuthState
  startError: Error | undefined
  sendResults: ChannelSendDetail[]
  healthTargets: ChannelHealthState['targets'] = []

  constructor(options: FakeChannelOptions = {}) {
    this.auth = {
      available: true,
      authenticated: true,
      tokenValid: true,
      userId: 'owner-1',
      version: '1.0.66',
      ...options.auth,
    }
    this.sendResults = [...(options.sendResults ?? [])]
  }

  async start(sink: (message: InboundMessage) => void): Promise<ChannelHealthState> {
    this.startCalls += 1
    if (this.startError !== undefined) {
      this.startErrors.push(this.startError)
      throw this.startError
    }
    this.sink = sink
    this.running = true
    return this.health()
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
    this.running = false
    this.sink = undefined
  }

  async sendWithReceipt(outbound: Outbound): Promise<ChannelSendDetail> {
    this.sends.push(outbound)
    const result = this.sendResults.shift() ?? { result: 'sent', receipt: `receipt-${this.sends.length}` }
    this.sentResults.push(result)
    return result
  }

  async probeAuth(): Promise<ChannelAuthState> {
    return { ...this.auth }
  }

  async discover(kind: TargetKind, query?: string): Promise<readonly TargetCandidate[]> {
    this.discoveries.push(query === undefined ? { kind } : { kind, query })
    return []
  }

  async validate(target: TargetDraft): Promise<TargetValidation> {
    this.validations.push(target)
    return { target, valid: true }
  }

  health(): ChannelHealthState {
    return this.running
      ? { state: 'ready', running: true, targets: this.healthTargets }
      : { state: 'stopped', running: false, targets: [] }
  }

  ownerUserId(): string {
    return this.auth.userId ?? ''
  }

  emit(message: InboundMessage): void {
    this.sink?.(message)
  }
}

/** Classifier answer the fake model returns when the request is a classification. */
export function classifyAnswer(
  intent: 'chat' | 'question' | 'task' | 'ignore',
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    intent,
    confidence: 0.9,
    reason: 'test',
    need_search: false,
    ...(intent === 'task' ? { task: { title: '整理发布说明', brief: '把发布说明整理一下', requirements: [] } } : {}),
    ...overrides,
  })
}

export class ScriptedModel implements ModelPort {
  classifyAnswer = classifyAnswer('chat')
  replyAnswer = '收到，我来看看。'
  readonly requests: ModelRequest[] = []
  /** When set, every call rejects with it. */
  error: Error | undefined

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string> {
    this.requests.push(request)
    if (signal.aborted) throw new Error('aborted')
    if (this.error !== undefined) throw this.error
    // The classifier asks for a bounded JSON answer; a reply asks for the persona limit.
    return request.maxChars === 800 ? this.classifyAnswer : this.replyAnswer
  }
}

export class FakeModelFactory implements BrainModelFactory {
  readonly models: ScriptedModel[] = []
  resetCalls = 0
  disposeCalls = 0
  readonly routes: string[] = []
  private readonly model: ScriptedModel

  constructor(model = new ScriptedModel()) {
    this.model = model
    this.models.push(model)
  }

  get current(): ScriptedModel {
    return this.model
  }

  forThread(): ModelPort {
    return this.model
  }

  async reset(): Promise<void> {
    this.resetCalls += 1
  }

  async updateRoute(route: { provider: string; model: string }): Promise<void> {
    this.routes.push(`${route.provider}/${route.model}`)
    this.resetCalls += 1
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1
  }
}

export class FakeResearch implements ResearchPort {
  readonly calls: { query: string; limit: number; timeoutMs: number }[] = []
  hit: ResearchHit = {
    facts: ['这是检索到的事实。'],
    sources: [{ title: '资料', url: 'https://example.com/doc' }],
  }
  error: Error | undefined

  async search(
    query: string,
    options: { limit: number; timeoutMs: number },
    signal: AbortSignal,
  ): Promise<ResearchHit> {
    this.calls.push({ query, limit: options.limit, timeoutMs: options.timeoutMs })
    if (signal.aborted) throw new Error('aborted')
    if (this.error !== undefined) throw this.error
    return this.hit
  }
}

export class FakeExecutor implements TaskExecutor {
  readonly executed: ExecutorRequest[] = []
  readonly cancelled: string[] = []
  result: ExecutorResult = { outcome: 'succeeded', summary: '已经整理好了。', sessionId: 'session-1' }
  executeError: Error | undefined
  onStarted: TaskExecutor['onStarted']
  onFinished: TaskExecutor['onFinished']
  disposeCalls = 0
  private readonly events: string[]

  constructor(events: string[] = []) {
    this.events = events
  }

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    this.executed.push(request)
    if (this.executeError !== undefined) throw this.executeError
    this.onStarted?.(request.task.id, this.result.sessionId)
    this.events.push('executor:finished')
    this.onFinished?.(request.task.id, this.result)
    return this.result
  }

  async cancel(taskId: string): Promise<boolean> {
    this.cancelled.push(taskId)
    return true
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1
    this.events.push('executor:dispose')
  }
}

export interface PipelineHarness {
  readonly runtime: Runtime
  readonly clock: MutableClock
  readonly channel: FakeChannel
  readonly model: FakeModelFactory
  readonly research: FakeResearch
  readonly executor: FakeExecutor
  readonly timers: ManualTimers
  readonly events: string[]
}

export interface PipelineOptions {
  readonly stateDir: string
  readonly settings?: Partial<Record<SettingsBlock, Record<string, unknown>>>
  readonly channel?: FakeChannel
  readonly model?: FakeModelFactory
  readonly research?: FakeResearch
  readonly executor?: FakeExecutor
  readonly prompts?: RuntimeOverrides['prompts']
  readonly clock?: MutableClock
}

/** Default settings most pipeline tests use: one enabled at-me target. */
export const AT_ME_SETTINGS = {
  targets: {
    rows: [{ kind: 'at-me', id: 'target-1', label: '全局 @我', mentionOnly: true, replyMode: 'auto', enabled: true }],
  },
}

export async function startPipeline(options: PipelineOptions): Promise<PipelineHarness> {
  const clock = options.clock ?? createClock()
  const channel = options.channel ?? new FakeChannel()
  const model = options.model ?? new FakeModelFactory()
  const research = options.research ?? new FakeResearch()
  const events: string[] = []
  const executor = options.executor ?? new FakeExecutor(events)
  const timers = new ManualTimers()
  const runtime = new Runtime(
    { stateDir: options.stateDir, logLevel: 'info' },
    {
      now: () => clock.now(),
      timers,
      overrides: {
        channel,
        model,
        research,
        executor,
        settings: { ...AT_ME_SETTINGS, ...options.settings },
        ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
      },
    },
  )
  try {
    await runtime.ready
  } catch (error) {
    await runtime.stop()
    throw error
  }
  const originalStop = channel.stop.bind(channel)
  channel.stop = async () => {
    events.push('channel:stop')
    await originalStop()
  }
  return { runtime, clock, channel, model, research, executor, timers, events }
}

export interface RuntimeHttp {
  readonly baseUrl: string
  close(): Promise<void>
}

/** Serve the management API for a runtime the test already started. */
export async function serveRuntime(runtime: Runtime): Promise<RuntimeHttp> {
  const server: Server = createServer(createHttpHandler(httpDeps(runtime)))
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}
