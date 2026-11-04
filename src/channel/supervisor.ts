/**
 * Per-target subscription supervisor.
 *
 * One long-lived `dws event consume` process per enabled target, with bounded
 * exponential restart backoff, no concurrency for the same target, and a
 * stop path that never leaves an unaccounted child behind.
 *
 * Events are handed to the sink in arrival order without blocking the stdout
 * reader: each target owns a promise chain, so a slow sink delays later events
 * of the same target but never causes back-pressure on the child's pipe or
 * reorders messages.
 */
import type { InboundMessage } from '../core/model.ts'
import type { Settings } from '../shared/settings.ts'
import { resolveDwsCommand } from './command.ts'
import { ChannelError } from './errors.ts'
import { describeError, describeExit, redact, truncate } from './log.ts'
import { normalizeEvent, summarizeRawEvent } from './normalize.ts'
import { DwsProcess, runOnce, type DwsExitInfo, type ReadyInfo, type SpawnFn } from './process.ts'
import { consumeSpec, dedupeTargets, resolveOwnerUserId, targetKey, withProfile } from './targets.ts'
import type { ChannelHealth, ChannelLogger, DwsTarget, ProcessState, TargetHealth } from './types.ts'

/** Receives accepted events; may be async, and its failures never break the channel. */
export type EventSink = (message: InboundMessage) => void | Promise<void>

export interface SupervisorOptions {
  readonly settings: Settings
  readonly logger: ChannelLogger
  readonly ownerUserId?: string
  /** Owner display name for the `@nick` addressed fallback. */
  readonly ownerNick?: string
  /** Binary override for tests; defaults to `settings.dws.binaryPath`. */
  readonly command?: string
  /** Base argv before the dws command; tests pass `[fakeScript]` with `process.execPath`. */
  readonly baseArgs?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly spawn?: SpawnFn
  readonly graceMs?: number
  readonly termMs?: number
  /** Backoff override for tests; production derives the cap from settings. */
  readonly backoff?: { readonly baseMs?: number; readonly maxMs?: number }
  readonly now?: () => Date
  /** Poll interval of `whenReady`. */
  readonly pollMs?: number
}

/** Warn once when a sink falls this far behind; events are still delivered. */
const PENDING_WARN_THRESHOLD = 500
/** Guard against `2 ** n` overflow when a custom base backoff is huge. */
const MAX_BACKOFF_EXPONENT = 10

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One non-empty string field of a server error object. */
function errorText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

interface TargetRuntime {
  readonly target: DwsTarget
  readonly key: string
  state: ProcessState
  process: DwsProcess | undefined
  timer: NodeJS.Timeout | undefined
  /** Consecutive failures since the last ready, used for the backoff exponent. */
  failures: number
  /** Lifetime restart count, surfaced in health. */
  restarts: number
  readyAt: string | undefined
  subscribeId: string | undefined
  lastError: string | undefined
  /** Consecutive server-side rejections since the last ready. */
  serverFailures: number
  /** Retry hint the server attached to this attempt's rejection, in milliseconds. */
  retryAfterMs: number | undefined
  /** Redacted rejection reason of this attempt; undefined when it ended any other way. */
  serverReason: string | undefined
  pending: number
  malformed: number
  chain: Promise<void>
  warnedBacklog: boolean
}

export class ChannelSupervisor {
  readonly #settings: Settings
  readonly #logger: ChannelLogger
  readonly #ownerUserId: string
  readonly #ownerNick: string | undefined
  readonly #command: string
  #resolvedCommand: string
  readonly #baseArgs: readonly string[]
  readonly #env: NodeJS.ProcessEnv | undefined
  readonly #cwd: string | undefined
  readonly #spawn: SpawnFn | undefined
  readonly #graceMs: number | undefined
  readonly #termMs: number | undefined
  readonly #baseBackoffMs: number
  readonly #maxBackoffMs: number
  readonly #now: () => Date
  readonly #pollMs: number
  readonly #runtimes = new Map<string, TargetRuntime>()
  #sink: EventSink = () => undefined
  #running = false
  #stopping = false

  constructor(options: SupervisorOptions) {
    this.#settings = options.settings
    this.#logger = options.logger
    this.#ownerUserId = resolveOwnerUserId(options.ownerUserId)
    this.#ownerNick = options.ownerNick
    this.#command = options.command ?? options.settings.dws.binaryPath
    this.#resolvedCommand = this.#command
    this.#baseArgs = options.baseArgs ?? []
    this.#env = options.env
    this.#cwd = options.cwd
    this.#spawn = options.spawn
    this.#graceMs = options.graceMs
    this.#termMs = options.termMs
    this.#baseBackoffMs = options.backoff?.baseMs ?? 1_000
    this.#maxBackoffMs = options.backoff?.maxMs ?? options.settings.dws.restartBackoffMaxSeconds * 1_000
    this.#now = options.now ?? (() => new Date())
    this.#pollMs = options.pollMs ?? 50
  }

  get running(): boolean {
    return this.#running
  }

  /**
   * Subscribe every enabled target.
   *
   * The call returns once every process has been spawned; readiness is reported
   * through `health()` or awaited with `whenReady`.
   */
  start(targets: readonly DwsTarget[], sink: EventSink): void {
    const selected = dedupeTargets(targets)
    // Fail closed: without the owner id, a message written by the assistant
    // itself cannot be recognized as `self`, which risks a reply loop.
    if (selected.length > 0 && this.#ownerUserId === '') {
      throw new ChannelError('owner-unknown', 'owner identity is required before subscribing')
    }
    if (this.#running) throw new ChannelError('invalid-state', 'channel supervisor is already started')
    // One resolution for the whole supervisor run, logged once so a host PATH
    // problem is visible without exposing any account data.
    this.#resolvedCommand = resolveDwsCommand(this.#command, this.#env ?? process.env)
    this.#logger.info(`channel: dws command ${this.#resolvedCommand}`)
    this.#sink = sink
    this.#running = true
    this.#stopping = false
    for (const target of selected) {
      const runtime: TargetRuntime = {
        target,
        key: targetKey(target),
        state: 'starting',
        process: undefined,
        timer: undefined,
        failures: 0,
        restarts: 0,
        readyAt: undefined,
        subscribeId: undefined,
        lastError: undefined,
        serverFailures: 0,
        retryAfterMs: undefined,
        serverReason: undefined,
        pending: 0,
        malformed: 0,
        chain: Promise.resolve(),
        warnedBacklog: false,
      }
      this.#runtimes.set(runtime.key, runtime)
      this.#launch(runtime)
    }
  }

  /** Stop every subscription and wait until all children have converged. */
  async stop(): Promise<void> {
    this.#running = false
    this.#stopping = true
    const runtimes = [...this.#runtimes.values()]
    await Promise.all(runtimes.map((runtime) => this.#stopRuntime(runtime)))
    this.#runtimes.clear()
  }

  /** Stop one target; accepts its id or its `kind:id` key. Keeps it visible in health. */
  async stopTarget(id: string): Promise<void> {
    const target = id.trim()
    const runtime =
      this.#runtimes.get(target) ?? [...this.#runtimes.values()].find((candidate) => candidate.target.id === target)
    if (!runtime) return
    await this.#stopRuntime(runtime)
  }

  /** Current health, safe for the panel: no ids beyond the configured target id. */
  health(): ChannelHealth {
    const targets = [...this.#runtimes.values()].map((runtime) => this.#healthOf(runtime))
    return {
      state: this.#aggregate(targets),
      running: this.#running,
      targets,
    }
  }

  /** Resolve true once every subscription is ready, false on timeout or failure. */
  async whenReady(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const states = [...this.#runtimes.values()].map((runtime) => runtime.state)
      if (states.length === 0) return false
      if (states.every((state) => state === 'ready')) return true
      if (states.some((state) => state === 'orphaned')) return false
      if (Date.now() >= deadline) return false
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#pollMs)
        timer.unref?.()
      })
    }
  }

  #launch(runtime: TargetRuntime): void {
    if (!this.#running || this.#stopping) return
    // One process per target, always: a restart timer or a live child blocks a
    // second launch, which is what keeps overlapping subscriptions impossible.
    if (runtime.process || runtime.timer) return

    let args: readonly string[]
    try {
      args = consumeSpec(runtime.target, this.#settings).args
    } catch (error) {
      // A bad target id is a configuration error, not a transient failure; a
      // restart would only repeat the same mistake.
      runtime.state = 'failed'
      runtime.lastError = describeError(error)
      this.#logger.error(`channel: ${runtime.target.kind} target is invalid: ${runtime.lastError}`)
      return
    }

    runtime.state = 'starting'
    // A rejection belongs to one attempt: a new process starts with no server
    // verdict and no server-supplied retry hint of its own.
    runtime.serverReason = undefined
    runtime.retryAfterMs = undefined
    const process = new DwsProcess({
      command: this.#resolvedCommand,
      baseArgs: this.#baseArgs,
      args,
      env: this.#env,
      cwd: this.#cwd,
      graceMs: this.#graceMs,
      termMs: this.#termMs,
      spawn: this.#spawn,
      onLine: (line) => this.#handleLine(runtime, line),
      onStderrLine: (line) => {
        const text = line.trim()
        if (text !== '') this.#logger.debug(`channel stderr: ${redact(text)}`)
      },
      onReady: (info) => this.#handleReady(runtime, info),
      onExit: (exit) => this.#handleExit(runtime, exit),
    })
    runtime.process = process
    try {
      process.start()
    } catch (error) {
      runtime.process = undefined
      this.#fail(runtime, error)
    }
  }

  #handleReady(runtime: TargetRuntime, info: ReadyInfo): void {
    runtime.state = 'ready'
    runtime.readyAt = this.#now().toISOString()
    runtime.subscribeId = info.subscribeId
    runtime.failures = 0
    runtime.lastError = undefined
    runtime.serverFailures = 0
    runtime.retryAfterMs = undefined
    runtime.serverReason = undefined
    this.#logger.info(`channel: ${runtime.target.kind} subscription ready`)
  }

  #handleExit(runtime: TargetRuntime, exit: DwsExitInfo): void {
    runtime.process = undefined
    const detail = exit.error ?? describeExit(exit.code, exit.signal, exit.expected)
    if (this.#stopping || !this.#running || exit.expected) {
      runtime.state = 'stopped'
      this.#logger.debug(`channel: ${runtime.target.kind} subscription stopped`)
      return
    }
    this.#fail(runtime, new Error(detail))
  }

  /** Record a failure and schedule one bounded restart. */
  #fail(runtime: TargetRuntime, error: unknown): void {
    const rejection = runtime.serverReason
    runtime.state = 'failed'
    // A server-side rejection is the reason the operator has to see; the exit
    // that follows it adds nothing.
    runtime.lastError = rejection ?? describeError(error)
    this.#logger.warn(`channel: ${runtime.target.kind} subscription failed: ${runtime.lastError}`)
    if (!this.#running || this.#stopping || runtime.timer) return
    // Repeated rejections with no server-supplied retry hint mean the target
    // itself is wrong (a malformed id, a refused subscription): retrying would
    // only replace the real reason with more exit noise.
    if (rejection !== undefined && runtime.serverFailures >= 3 && runtime.retryAfterMs === undefined) {
      this.#logger.error(
        `channel: ${runtime.target.kind} subscription was rejected ${runtime.serverFailures} times; not restarting`,
      )
      return
    }
    runtime.failures += 1
    runtime.restarts += 1
    const exponent = Math.min(runtime.failures - 1, MAX_BACKOFF_EXPONENT)
    const backoff = this.#baseBackoffMs * 2 ** exponent
    // Honour the server's retry hint when it asks for longer than the local
    // backoff, but never exceed the configured cap.
    const delay = Math.min(this.#maxBackoffMs, Math.max(backoff, runtime.retryAfterMs ?? 0))
    this.#logger.info(`channel: restarting ${runtime.target.kind} subscription in ${delay}ms`)
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      this.#launch(runtime)
    }, delay)
    runtime.timer.unref?.()
  }

  /** Record one structured server rejection without counting it as malformed. */
  #handleServerError(runtime: TargetRuntime, error: Record<string, unknown>): void {
    const text =
      errorText(error.message) ??
      errorText(error.cause) ??
      errorText(error.reason) ??
      'dws rejected the subscription without a reason'
    const detail = truncate(redact(text).replace(/\s+/g, ' ').trim(), 240)
    runtime.lastError = detail
    runtime.serverReason = detail
    runtime.serverFailures += 1
    const retryAfter = error.retry_after_seconds
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
      runtime.retryAfterMs = retryAfter * 1_000
    }
    this.#logger.warn(`channel: ${runtime.target.kind} subscription rejected: ${detail}`)
  }

  #handleLine(runtime: TargetRuntime, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      runtime.malformed += 1
      this.#logger.debug('channel: dropped a line that is not JSON')
      return
    }

    // `dws` reports a refused subscription as a structured `error` object on
    // stdout, not as an event: consuming it as one would label a server verdict
    // as a malformed payload and hide the only description of what went wrong.
    if (isRecord(parsed) && isRecord(parsed.error)) {
      this.#handleServerError(runtime, parsed.error)
      return
    }

    const debugEnabled = this.#settings.dws.debug || this.#settings.advanced.debugPayloads
    if (debugEnabled) {
      // Whitelisted, truncated fields only; never the raw payload.
      const summary = summarizeRawEvent(parsed)
      this.#logger.debug(`channel event keys=${summary.keys.join(',')} fields=${JSON.stringify(summary.fields)}`)
    }

    const result = normalizeEvent(parsed, {
      ownerUserId: this.#ownerUserId,
      ...(this.#ownerNick ? { ownerNick: this.#ownerNick } : {}),
      target: runtime.target,
      ignoreBroadcast: this.#settings.reply.ignoreBroadcast,
      now: this.#now,
    })
    if ('skip' in result) {
      if (result.skip === 'malformed') runtime.malformed += 1
      this.#logger.debug(
        `channel: skipped event reason=${result.skip}${result.detail ? ` detail=${result.detail}` : ''}`,
      )
      return
    }
    this.#dispatch(runtime, result)
  }

  #dispatch(runtime: TargetRuntime, message: InboundMessage): void {
    runtime.pending += 1
    if (!runtime.warnedBacklog && runtime.pending >= PENDING_WARN_THRESHOLD) {
      runtime.warnedBacklog = true
      this.#logger.warn(`channel: event sink is ${runtime.pending} messages behind`)
    }
    const sink = this.#sink
    runtime.chain = runtime.chain.then(async () => {
      try {
        await sink(message)
      } catch (error) {
        this.#logger.warn(`channel: event sink failed: ${describeError(error)}`)
      } finally {
        runtime.pending -= 1
        if (runtime.pending === 0) runtime.warnedBacklog = false
      }
    })
  }

  async #stopRuntime(runtime: TargetRuntime): Promise<void> {
    if (runtime.timer) {
      clearTimeout(runtime.timer)
      runtime.timer = undefined
    }
    const process = runtime.process
    runtime.process = undefined
    if (process) {
      const outcome = await process.stop()
      runtime.state = outcome === 'orphaned' ? 'orphaned' : 'stopped'
      if (outcome === 'orphaned') {
        runtime.lastError = 'dws did not exit after stdin end and SIGTERM'
        this.#logger.error('channel: subscription is orphaned; dws ignored stdin end and SIGTERM')
        await this.#cleanupSubscription(runtime)
      }
    } else if (runtime.state !== 'orphaned') {
      runtime.state = 'stopped'
    }
    await runtime.chain
  }

  /**
   * Best-effort removal of an orphaned subscription.
   *
   * `dws event stop <subscribe_id> --yes` is the documented cleanup; it may fail
   * (for example because dws itself is wedged), and that failure must never mask
   * the orphaned state the operator has to see.
   */
  async #cleanupSubscription(runtime: TargetRuntime): Promise<void> {
    const subscribeId = runtime.subscribeId
    if (!subscribeId) return
    try {
      const args = withProfile(['event', 'stop', subscribeId, '--yes'], this.#settings)
      await runOnce({
        command: this.#command,
        baseArgs: this.#baseArgs,
        args,
        env: this.#env,
        cwd: this.#cwd,
        timeoutMs: 5_000,
        spawn: this.#spawn,
      })
      this.#logger.info('channel: best-effort subscription cleanup requested')
    } catch (error) {
      this.#logger.debug(`channel: subscription cleanup failed: ${describeError(error)}`)
    }
  }

  #healthOf(runtime: TargetRuntime): TargetHealth {
    return {
      targetId: runtime.target.id,
      kind: runtime.target.kind,
      ...(runtime.target.label ? { label: runtime.target.label } : {}),
      state: runtime.state,
      ...(runtime.subscribeId ? { subscribeId: runtime.subscribeId } : {}),
      restarts: runtime.restarts,
      ...(runtime.readyAt ? { readyAt: runtime.readyAt } : {}),
      ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
      pending: runtime.pending,
      malformed: runtime.malformed,
      command: this.#resolvedCommand,
    }
  }

  #aggregate(targets: readonly TargetHealth[]): ChannelHealth['state'] {
    if (!this.#running || targets.length === 0) return 'stopped'
    if (targets.every((target) => target.state === 'ready')) return 'ready'
    if (targets.every((target) => target.state === 'starting' || target.state === 'ready')) return 'starting'
    return 'degraded'
  }
}
