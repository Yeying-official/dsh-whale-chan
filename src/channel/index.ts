/**
 * `DingTalkChannel`: the composition surface the host wires into `src/app`.
 *
 * The host supplies settings and a logger; the channel owns the dws processes,
 * decoding and the send command. There is no Cordis import here on purpose, so
 * the app layer can compose the channel directly without a dependency cycle.
 */
import type { Outbound } from '../core/model.ts'
import type { Settings } from '../shared/settings.ts'
import { probeAuth } from './auth.ts'
import { discoverGroups, discoverPeers } from './discover.ts'
import { ChannelError } from './errors.ts'
import { createRunner, type SpawnFn } from './process.ts'
import { sendDetailed, type SendDetail } from './sender.ts'
import { ChannelSupervisor, type EventSink } from './supervisor.ts'
import { dedupeTargets, resolveOwnerUserId, targetsFromSettings } from './targets.ts'
import { validateTarget } from './validate.ts'
import type {
  AuthState,
  ChannelHealth,
  ChannelLogger,
  CommandRunner,
  DwsTarget,
  SendResult,
  TargetCandidate,
  ValidateResult,
} from './types.ts'

export interface DingTalkChannelOptions {
  /** Read the current settings; may be async so the host stays authoritative. */
  readonly settingsProvider: () => Settings | Promise<Settings>
  readonly logger: ChannelLogger
  /** Authorized account id, used for self-detection and mention matching. */
  readonly ownerUserId?: string
  readonly ownerNick?: string
  /** Default event sink; `start` may override it. */
  readonly sink?: EventSink
  /** Binary override for tests; defaults to `settings.dws.binaryPath`. */
  readonly command?: string
  /** Base argv before the dws command; tests pass `[fakeScript]` with `process.execPath`. */
  readonly baseArgs?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly spawn?: SpawnFn
  readonly graceMs?: number
  readonly termMs?: number
  readonly backoff?: { readonly baseMs?: number; readonly maxMs?: number }
  readonly now?: () => Date
}

const STOPPED: ChannelHealth = { state: 'stopped', running: false, targets: [] }

/**
 * Facade over the dws channel.
 *
 * `start` subscribes enabled targets, `stop` converges every child, and the
 * remaining methods are explicit one-shot operations: discovery, validation,
 * auth probe and send.
 */
export class DingTalkChannel {
  readonly #options: DingTalkChannelOptions
  #supervisor: ChannelSupervisor | undefined

  constructor(options: DingTalkChannelOptions) {
    this.#options = options
  }

  /**
   * Subscribe every enabled target.
   *
   * The owner identity must be known before any subscription starts: without it
   * a message written by the assistant itself is not recognized as `self`, and
   * the assistant could answer its own reply. A paused or disabled monitor still
   * validates that precondition, then starts nothing.
   */
  async start(targets?: readonly DwsTarget[], sink?: EventSink): Promise<ChannelHealth> {
    if (this.#supervisor) throw new ChannelError('invalid-state', 'channel is already started')
    const settings = await this.#options.settingsProvider()
    const eventSink = sink ?? this.#options.sink
    if (!eventSink) throw new ChannelError('invalid-state', 'channel has no event sink')
    const selected = targets ? dedupeTargets([...targets]) : targetsFromSettings(settings)
    const ownerUserId = this.ownerUserId()
    if (selected.length > 0 && ownerUserId === '') {
      throw new ChannelError(
        'owner-unknown',
        'owner identity is required before subscribing; pass the userId returned by probeAuth()',
      )
    }
    if (!settings.monitor.enabled || settings.monitor.paused) {
      this.#options.logger.info('channel: monitor is disabled or paused; no subscription started')
      return STOPPED
    }
    if (selected.length === 0) {
      this.#options.logger.info('channel: no enabled target; monitoring is idle')
      return STOPPED
    }

    const supervisor = new ChannelSupervisor({
      settings,
      logger: this.#options.logger,
      ownerUserId,
      ownerNick: this.#options.ownerNick,
      command: this.#options.command,
      baseArgs: this.#options.baseArgs,
      env: this.#options.env,
      cwd: this.#options.cwd,
      spawn: this.#options.spawn,
      graceMs: this.#options.graceMs,
      termMs: this.#options.termMs,
      backoff: this.#options.backoff,
      now: this.#options.now,
    })
    supervisor.start(selected, eventSink)
    this.#supervisor = supervisor
    return supervisor.health()
  }

  /** Stop every subscription and wait for all children to converge. */
  async stop(): Promise<void> {
    const supervisor = this.#supervisor
    this.#supervisor = undefined
    if (supervisor) await supervisor.stop()
  }

  /** Send one queued message; `unknown` forbids a retry. */
  async send(outbound: Outbound): Promise<SendResult> {
    return (await this.sendWithReceipt(outbound)).result
  }

  /**
   * Send and keep the receipt/error detail for the Outbox record.
   *
   * In dry-run mode the call is skipped, not failed: the caller must leave the
   * Outbox record untouched instead of retrying or marking it failed.
   */
  async sendWithReceipt(outbound: Outbound): Promise<SendDetail> {
    const settings = await this.#options.settingsProvider()
    if (settings.advanced.dryRun) {
      this.#options.logger.info('channel: dry run is enabled; outbound message was skipped')
      return { result: 'skipped' }
    }
    return sendDetailed(outbound, settings, { runner: await this.#runner() })
  }

  async discoverGroups(query: string): Promise<TargetCandidate[]> {
    const settings = await this.#options.settingsProvider()
    return discoverGroups(query, settings, { runner: await this.#runner() })
  }

  async discoverPeers(query?: string): Promise<TargetCandidate[]> {
    const settings = await this.#options.settingsProvider()
    return discoverPeers(query, settings, { runner: await this.#runner() })
  }

  async validateTarget(target: DwsTarget): Promise<ValidateResult> {
    const settings = await this.#options.settingsProvider()
    return validateTarget(target, settings, { runner: await this.#runner() })
  }

  async probeAuth(): Promise<AuthState> {
    const settings = await this.#options.settingsProvider()
    return probeAuth(settings, { runner: await this.#runner() })
  }

  health(): ChannelHealth {
    return this.#supervisor?.health() ?? STOPPED
  }

  /**
   * Owner id the channel uses for self-detection.
   *
   * It is resolved once by the host from `probeAuth().userId`; there is no
   * fallback because a guessed id would defeat the self-message filter.
   */
  ownerUserId(): string {
    return resolveOwnerUserId(this.#options.ownerUserId)
  }

  async #runner(): Promise<CommandRunner> {
    const settings = await this.#options.settingsProvider()
    return createRunner({
      command: this.#options.command ?? settings.dws.binaryPath,
      baseArgs: this.#options.baseArgs,
      env: this.#options.env,
      cwd: this.#options.cwd,
      spawn: this.#options.spawn,
    })
  }
}

export { ChannelError, isChannelError } from './errors.ts'
export { redact, describeError } from './log.ts'
export {
  DEFAULT_MAX_TEXT_CHARS,
  normalizeEvent,
  summarizeRawEvent,
  toConversationType,
  toIsoTime,
} from './normalize.ts'
export { createRunner, DwsProcess, parseReadyLine, runOnce } from './process.ts'
export { send, sendDetailed, buildSendArgs } from './sender.ts'
export type { SendDetail } from './sender.ts'
export { ChannelSupervisor } from './supervisor.ts'
export type { EventSink } from './supervisor.ts'
export {
  consumeSpec,
  dedupeTargets,
  EVENT_KEYS,
  parsePeerAddress,
  resolveOwnerUserId,
  targetKey,
  targetsFromSettings,
  withProfile,
} from './targets.ts'
export { validateTarget } from './validate.ts'
export { discoverGroups, discoverPeers } from './discover.ts'
export { probeAuth } from './auth.ts'
export * from './types.ts'
