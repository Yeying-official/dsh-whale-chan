/**
 * The effect pipeline: the bridge between durable domain rows and the outside
 * world.
 *
 * One inbound message becomes at most one chain:
 *
 * ```text
 * receive → classify → (research →) compose → send
 *                    ↘ task → approval → launch → finish → send
 * ```
 *
 * Each step is an effect keyed by the row it works on, so a crash or a retry
 * resumes exactly where the previous attempt stopped. The pipeline owns no
 * state beyond the in-flight task set: the domain row is the truth, and every
 * handler re-reads it before acting.
 */
import type { Clock, Engine, InboundMessage, ReceiveResult } from '../core/index.ts'
import type { PromptSource, ResearchPort } from '../brain/index.ts'
import type { TaskExecutor } from '../executor/index.ts'
import type { ChannelRuntime } from './channel-runtime.ts'
import type { KvCounterStore } from './counters.ts'
import type { Effects } from './effects.ts'
import type { SettingsService } from './settings.ts'
import type { Store } from './store.ts'
import type { BrainModelFactory } from './brain-ports.ts'
import { ChatEffects, type ChatEffectDeps } from './effects-chat.ts'
import { TaskEffects, type TaskEffectDeps } from './effects-task.ts'

export interface PipelineOptions {
  readonly engine: Engine
  readonly store: Store
  readonly settings: SettingsService
  readonly effects: Effects
  readonly clock: Clock
  readonly counters: KvCounterStore
  readonly model: BrainModelFactory
  readonly research: ResearchPort
  readonly prompts: PromptSource
  readonly executor: TaskExecutor
  readonly channel: () => ChannelRuntime | undefined
  readonly channelRunning: () => boolean
  readonly ownerUserId: () => string
  readonly lifetime: AbortSignal
  readonly ids: { next(prefix: string): string }
  readonly probe: () => Promise<void>
}

export class Pipeline {
  private readonly engine: Engine
  private readonly effects: Effects
  private readonly chat: ChatEffects
  private readonly task: TaskEffects

  constructor(options: PipelineOptions) {
    this.engine = options.engine
    this.effects = options.effects
    const shared: ChatEffectDeps = {
      engine: options.engine,
      store: options.store,
      settings: options.settings,
      effects: options.effects,
      clock: options.clock,
      counters: options.counters,
      model: options.model,
      research: options.research,
      prompts: options.prompts,
      ownerUserId: options.ownerUserId,
      channel: options.channel,
      channelRunning: options.channelRunning,
      lifetime: options.lifetime,
      ids: options.ids,
    }
    const task: TaskEffectDeps = {
      engine: options.engine,
      store: options.store,
      settings: options.settings,
      effects: options.effects,
      clock: options.clock,
      executor: options.executor,
      lifetime: options.lifetime,
      ids: options.ids,
      probe: options.probe,
    }
    this.chat = new ChatEffects(shared)
    this.task = new TaskEffects(task)
  }

  /** Register every handler; must run before `Effects.start`. */
  register(): void {
    this.chat.register()
    this.task.register()
  }

  /**
   * Accept one inbound message and enqueue its classification.
   *
   * The domain command commits first; only then is the effect staged, so a
   * crash in between leaves a queued decision that the outbox-resume pass or a
   * redelivered channel event can pick up again.
   */
  receive(message: InboundMessage): ReceiveResult {
    const result = this.engine.receive(message)
    if (result.decision.status === 'queued') {
      this.effects.enqueue('classify', result.decision.id, { decisionId: result.decision.id })
    }
    return result
  }

  /** Task ids whose executor run is in flight. */
  runningTasks(): readonly string[] {
    return this.task.running()
  }
}
