/**
 * Cooperative periodic passes.
 *
 * A pass is a small, re-entrant phase advance: it reads the current state and
 * stages effects, and running it twice on the same input is harmless. This
 * scheduler only decides *when* passes run; it never interprets them.
 *
 * Rules:
 *
 * - A pass runs at most once at a time (single flight); a tick that arrives
 *   while it runs is skipped instead of queued, so a slow pass cannot build up
 *   a backlog.
 * - A failing pass is reported through `onError` and does not stop the other
 *   passes or later rounds.
 * - `tick(now)` takes the wall clock as an argument, which is how tests drive
 *   the schedule without waiting on timers.
 * - `stop()` clears the timer and waits for the rounds already in flight.
 */
import type { Clock } from '../core/index.ts'

export type PassRunner = (now: Date) => void | Promise<void>

export interface PassOptions {
  /** Delay between two starts of this pass. */
  readonly intervalMs: number
  /** Run once on `start`, before the first interval elapses. */
  readonly runAtStart?: boolean
}

export interface PassesOptions {
  readonly clock: Clock
  /** Receives a pass failure; the scheduler never throws it. */
  readonly onError?: (name: string, error: unknown) => void
}

interface PassState {
  readonly name: string
  readonly run: PassRunner
  readonly intervalMs: number
  /** Epoch milliseconds of the next allowed start. */
  nextAt: number
  running: boolean
}

export class Passes {
  private readonly passes = new Map<string, PassState>()
  private readonly running = new Set<Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private started = false
  private stopped = false

  constructor(private readonly options: PassesOptions) {}

  /** Register one pass; the name identifies it in errors and must be unique. */
  register(name: string, run: PassRunner, options: PassOptions): void {
    if (this.passes.has(name)) throw new Error(`A pass named "${name}" is already registered`)
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error(`The interval of pass "${name}" must be positive`)
    }
    this.passes.set(name, {
      name,
      run,
      intervalMs: options.intervalMs,
      nextAt: options.runAtStart ? 0 : this.options.clock.now().getTime() + options.intervalMs,
      running: false,
    })
  }

  /** Start the timer and run the `runAtStart` passes once. */
  start(): void {
    if (this.started && !this.stopped) return
    this.started = true
    this.stopped = false
    const period = Math.max(25, Math.min(1000, Math.floor(this.shortestInterval() / 2)))
    this.timer = setInterval(() => {
      void this.tick(this.options.clock.now())
    }, period)
    ;(this.timer as { unref?: () => void }).unref?.()
    void this.tick(this.options.clock.now())
  }

  /** Stop scheduling and wait for the rounds already running. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (let guard = 0; guard < 1000 && this.running.size > 0; guard += 1) {
      await Promise.allSettled([...this.running])
    }
  }

  /**
   * Run every pass whose interval elapsed, starting each at most once.
   * `now` defaults to the injected clock; tests pass a fixed instant.
   */
  async tick(now: Date = this.options.clock.now()): Promise<void> {
    if (this.stopped) return
    const at = now.getTime()
    const rounds: Promise<void>[] = []
    for (const pass of this.passes.values()) {
      if (pass.running) continue
      if (at < pass.nextAt) continue
      pass.running = true
      pass.nextAt = at + pass.intervalMs
      const round = (async () => {
        try {
          await pass.run(now)
        } catch (error) {
          this.report(pass.name, error)
        } finally {
          pass.running = false
        }
      })()
      this.running.add(round)
      round.then(
        () => this.running.delete(round),
        () => this.running.delete(round),
      )
      rounds.push(round)
    }
    await Promise.allSettled(rounds)
  }

  private shortestInterval(): number {
    let shortest = 1000
    for (const pass of this.passes.values()) shortest = Math.min(shortest, pass.intervalMs)
    return shortest
  }

  private report(name: string, error: unknown): void {
    try {
      this.options.onError?.(name, error)
    } catch {
      // An error reporter must not break the scheduler.
    }
  }
}
