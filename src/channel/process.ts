/**
 * The only module allowed to start a `dws` process.
 *
 * Two shapes:
 *
 * - `runOnce` performs one bounded, non-interactive invocation (version, auth
 *   status, discovery, `--dry-run`, one send) and returns its exit status.
 * - `DwsProcess` owns one long-lived `event consume` subscription, splits its
 *   NDJSON stdout into lines and stops it without ever sending `SIGKILL`.
 *
 * Every child is spawned with an argument array (never a shell string), with
 * `windowsHide` set and with explicit UTF-8 decoding on both pipes.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { ChannelError } from './errors.ts'
import { describeError, truncate } from './log.ts'
import type { CommandResult, CommandRunner } from './types.ts'

/** The spawn seam; tests may inject their own, production uses cross-spawn. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

const defaultSpawn: SpawnFn = (command, args, options) => crossSpawn.spawn(command, [...args], options)

/** Default ceiling for one one-shot invocation's captured output. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** What the ready line of `event consume` reports. */
export interface ReadyInfo {
  readonly eventKey: string
  readonly subscribeId: string
  readonly busPid?: string
}

/**
 * Parse `[event] ready event_key=<key> bus_pid=<n> subscribe_id=<id>`.
 *
 * Returns `undefined` for any other line, including a ready line that omits the
 * subscribe id, because an id is what makes the subscription stoppable.
 */
export function parseReadyLine(line: string): ReadyInfo | undefined {
  if (!line.includes('[event]') || !line.includes('ready')) return undefined
  const tokens = new Map<string, string>()
  for (const match of line.matchAll(/([A-Za-z0-9_.-]+)=([^\s]+)/g)) {
    const key = match[1]
    const value = match[2]
    if (key && value) tokens.set(key, value)
  }
  const subscribeId = tokens.get('subscribe_id')
  if (!subscribeId) return undefined
  const busPid = tokens.get('bus_pid')
  return {
    eventKey: tokens.get('event_key') ?? '',
    subscribeId,
    ...(busPid ? { busPid } : {}),
  }
}

/** Split a UTF-8 byte stream into lines, keeping the trailing partial line. */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void
  flush(): void
} {
  let buffer = ''
  return {
    push(chunk: string): void {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) return
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim() !== '') onLine(line)
      }
    },
    flush(): void {
      const line = buffer.replace(/\r$/, '')
      buffer = ''
      if (line.trim() !== '') onLine(line)
    },
  }
}

export interface RunOnceOptions {
  readonly command: string
  readonly baseArgs?: readonly string[]
  readonly args: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly timeoutMs?: number
  /** How long to wait for the child to exit after the timeout `SIGTERM`. */
  readonly graceMs?: number
  readonly maxOutputBytes?: number
  readonly spawn?: SpawnFn
}

/**
 * Run one dws command to completion.
 *
 * On timeout the child receives `SIGTERM` and the call resolves with
 * `timedOut: true` — it is never escalated to `SIGKILL`. Output is capped so a
 * chatty or broken binary cannot exhaust the host's memory.
 */
export function runOnce(options: RunOnceOptions): Promise<CommandResult> {
  const spawnImpl = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? 15_000
  const settleGraceMs = options.graceMs ?? 2_000
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const args = [...(options.baseArgs ?? []), ...options.args]

  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnImpl(options.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: options.env,
        cwd: options.cwd,
      })
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: describeError(error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let spawnError: string | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const settle = (code: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        ...(spawnError ? { error: spawnError } : {}),
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // The process already exited; 'close' will settle the promise.
      }
      // Never escalate to SIGKILL: a process that ignores SIGTERM is reported as
      // timed out and left to the operator, matching the subscription rule.
      graceTimer = setTimeout(() => settle(null, 'SIGTERM'), settleGraceMs)
      graceTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < maxOutput) stdout += chunk
      else child.kill('SIGTERM')
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < maxOutput) stderr += chunk
      else child.kill('SIGTERM')
    })
    child.once('error', (error: Error) => {
      spawnError = describeError(error)
      settle(null, null)
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      settle(code, signal)
    })
  })
}

/**
 * Bind a one-shot runner to one binary and its base arguments.
 *
 * The channel builds it once per settings snapshot; tests build one with
 * `command = process.execPath` and `baseArgs = [fakeScript]`.
 */
export function createRunner(options: {
  readonly command: string
  readonly baseArgs?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly spawn?: SpawnFn
  readonly timeoutMs?: number
}): CommandRunner {
  return {
    run: (args, runOptions) =>
      runOnce({
        command: options.command,
        baseArgs: options.baseArgs,
        args,
        env: options.env,
        cwd: options.cwd,
        spawn: options.spawn,
        timeoutMs: runOptions?.timeoutMs ?? options.timeoutMs,
      }),
  }
}

/** Exit facts of one subscription process. */
export interface DwsExitInfo {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** True when `stop()` caused the exit, so the supervisor must not restart. */
  readonly expected: boolean
  readonly error?: string
}

/** What `stop()` achieved. `orphaned` means the process outlived SIGTERM. */
export type StopOutcome = 'stopped' | 'orphaned'

export interface DwsProcessOptions {
  readonly command: string
  readonly baseArgs?: readonly string[]
  readonly args: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  /** Grace period after `stdin.end()` before SIGTERM. */
  readonly graceMs?: number
  /** Grace period after SIGTERM before the process is reported as orphaned. */
  readonly termMs?: number
  readonly spawn?: SpawnFn
  readonly onLine: (line: string) => void
  readonly onStderrLine: (line: string) => void
  readonly onExit: (exit: DwsExitInfo) => void
  readonly onReady?: (info: ReadyInfo) => void
  readonly onSpawn?: (pid: number | undefined) => void
}

/**
 * One long-lived `dws event consume` subscription.
 *
 * Stopping closes stdin first (the documented graceful stop), then sends
 * `SIGTERM` after a grace period. A process that ignores both is reported as
 * `orphaned`; the channel never sends `SIGKILL`.
 */
export class DwsProcess {
  readonly #options: DwsProcessOptions
  readonly #args: readonly string[]
  readonly #graceMs: number
  readonly #termMs: number
  #child: ChildProcess | undefined
  #state: 'idle' | 'running' | 'stopped' | 'orphaned' = 'idle'
  #stopping = false
  #stopPromise: Promise<StopOutcome> | undefined
  #exited = false
  #exit: DwsExitInfo | undefined
  #waiters = new Set<() => void>()
  #flush: (() => void) | undefined
  #ready: ReadyInfo | undefined

  constructor(options: DwsProcessOptions) {
    this.#options = options
    this.#args = [...(options.baseArgs ?? []), ...options.args]
    this.#graceMs = options.graceMs ?? 5_000
    this.#termMs = options.termMs ?? 3_000
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  get ready(): ReadyInfo | undefined {
    return this.#ready
  }

  get exit(): DwsExitInfo | undefined {
    return this.#exit
  }

  get stopping(): boolean {
    return this.#stopping
  }

  get orphaned(): boolean {
    return this.#state === 'orphaned'
  }

  /** Spawn the subscription. Throws `ChannelError` if a child is already running. */
  start(): void {
    if (this.#child && !this.#exited) {
      throw new ChannelError('invalid-state', 'dws subscription process is already running')
    }
    const spawnImpl = this.#options.spawn ?? defaultSpawn
    const child = spawnImpl(this.#options.command, this.#args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.#options.env,
      cwd: this.#options.cwd,
    })
    this.#child = child
    this.#state = 'running'

    const stdoutSplitter = createLineSplitter((line) => this.#handleLine(line))
    const stderrSplitter = createLineSplitter((line) => this.#handleStderrLine(line))
    this.#flush = () => {
      stdoutSplitter.flush()
      stderrSplitter.flush()
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => stdoutSplitter.push(chunk))
    child.stderr?.on('data', (chunk: string) => stderrSplitter.push(chunk))
    child.once('error', (error: Error) => this.#finish(null, null, describeError(error)))
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => this.#finish(code, signal))
    // A stdin error (EPIPE after the child died) must not crash the host; the
    // exit handler owns the lifecycle.
    child.stdin?.on('error', () => undefined)
    this.#options.onSpawn?.(child.pid)
  }

  /**
   * Stop without `SIGKILL`: end stdin, wait `graceMs`, send `SIGTERM`, wait
   * `termMs`. Idempotent; concurrent callers share one promise.
   */
  stop(): Promise<StopOutcome> {
    if (this.#stopPromise) return this.#stopPromise
    if (!this.#child || this.#exited) {
      this.#state = this.#state === 'orphaned' ? 'orphaned' : 'stopped'
      this.#stopPromise = Promise.resolve(this.#state === 'orphaned' ? 'orphaned' : 'stopped')
      return this.#stopPromise
    }
    this.#stopping = true
    const child = this.#child
    this.#stopPromise = (async (): Promise<StopOutcome> => {
      try {
        child.stdin?.end()
      } catch {
        // Already closed; SIGTERM below still applies.
      }
      if (await this.#waitExit(this.#graceMs)) {
        this.#state = 'stopped'
        return 'stopped'
      }
      try {
        child.kill('SIGTERM')
      } catch {
        // Raced with exit; the wait below settles it.
      }
      if (await this.#waitExit(this.#termMs)) {
        this.#state = 'stopped'
        return 'stopped'
      }
      this.#state = 'orphaned'
      return 'orphaned'
    })()
    return this.#stopPromise
  }

  /** Run the same command with `--dry-run` appended and collect its outcome. */
  dryRun(timeoutMs = 15_000): Promise<CommandResult> {
    return runOnce({
      command: this.#options.command,
      baseArgs: this.#options.baseArgs,
      args: [...this.#options.args, '--dry-run'],
      env: this.#options.env,
      cwd: this.#options.cwd,
      timeoutMs,
      spawn: this.#options.spawn,
    })
  }

  #handleLine(line: string): void {
    const ready = parseReadyLine(line)
    if (ready) this.#markReady(ready)
    this.#options.onLine(line)
  }

  #handleStderrLine(line: string): void {
    const ready = parseReadyLine(line)
    if (ready) this.#markReady(ready)
    this.#options.onStderrLine(line)
  }

  #markReady(ready: ReadyInfo): void {
    this.#ready = ready
    this.#options.onReady?.(ready)
  }

  #finish(code: number | null, signal: NodeJS.Signals | null, error?: string): void {
    if (this.#exited) return
    this.#exited = true
    this.#flush?.()
    // An orphaned process stays orphaned: its late exit does not prove the stop
    // was graceful, and the supervisor must not report a clean shutdown.
    if (this.#state !== 'orphaned') this.#state = 'stopped'
    const exit: DwsExitInfo = { code, signal, expected: this.#stopping, ...(error ? { error } : {}) }
    this.#exit = exit
    for (const waiter of this.#waiters) waiter()
    this.#waiters.clear()
    this.#options.onExit(exit)
  }

  #waitExit(ms: number): Promise<boolean> {
    if (this.#exited) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter)
        resolve(this.#exited)
      }, ms)
      timer.unref?.()
      const waiter = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.#waiters.add(waiter)
    })
  }
}

/** Keep stderr snippets short and payload-free in channel logs. */
export function shortStderr(stderr: string, maxLength = 240): string {
  const line = stderr
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .pop()
  return truncate(line ?? '', maxLength)
}
