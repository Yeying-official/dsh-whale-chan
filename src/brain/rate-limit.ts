/**
 * Sliding-window counters for the reply gate.
 *
 * The gate needs two numbers per conversation: how many replies went out in the
 * last hour, and how long ago the last one did. Both are readable from one map
 * of timestamps. The counter is in-memory on purpose — a restart may forget a
 * reply, which is safer than persisting a wrong rate and refusing to talk.
 *
 * Time is always passed in, so a test can drive the window without waiting.
 */
import type { CounterStore } from './types.ts'

/** Default window: the reply limits are expressed per hour. */
export const HOUR_MS = 60 * 60 * 1000

export interface SlidingWindowCounterOptions {
  /** Clock used when a caller omits `at`; defaults to `Date.now`. */
  readonly now?: () => number
  /** Upper bound on tracked keys, so a busy account cannot grow the map forever. */
  readonly maxKeys?: number
}

/**
 * Records one hit per reply and answers windowed counts.
 *
 * Hits are kept ascending per key and pruned to the requested window on every
 * read, so the map only ever holds the timestamps the gate can still ask about.
 * Out-of-order timestamps are inserted in place; a caller replaying history in
 * any order still gets correct counts.
 */
export class SlidingWindowCounter implements CounterStore {
  private readonly hits = new Map<string, number[]>()
  private readonly now: () => number
  private readonly maxKeys: number

  constructor(options: SlidingWindowCounterOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.maxKeys = options.maxKeys ?? 500
  }

  /** Record one reply at `at` and return how many hits fall inside the window. */
  hit(key: string, at: number = this.now(), windowMs: number = HOUR_MS): number {
    const timestamps = this.entries(key)
    // Insert in place so a caller replaying history out of order still counts correctly.
    let index = timestamps.length
    while (index > 0 && (timestamps[index - 1] ?? 0) > at) index -= 1
    timestamps.splice(index, 0, at)
    const cutoff = at - windowMs
    // Keep future hits: they belong to a replay that has not caught up yet.
    const kept = timestamps.filter((value) => value > cutoff)
    this.hits.set(key, kept)
    this.evict()
    return kept.filter((value) => value <= at).length
  }

  /** Count hits inside the window without recording one. */
  count(key: string, at: number = this.now(), windowMs: number = HOUR_MS): number {
    const timestamps = this.hits.get(key)
    if (!timestamps) return 0
    const cutoff = at - windowMs
    const kept = timestamps.filter((value) => value > cutoff)
    if (kept.length === 0) this.hits.delete(key)
    else this.hits.set(key, kept)
    return kept.filter((value) => value <= at).length
  }

  /** Milliseconds since the most recent hit at or before `at`; `Infinity` when none. */
  gapMs(key: string, at: number = this.now()): number {
    const timestamps = this.hits.get(key)
    if (!timestamps) return Number.POSITIVE_INFINITY
    let latest = Number.NEGATIVE_INFINITY
    for (const value of timestamps) {
      if (value <= at && value > latest) latest = value
    }
    return latest === Number.NEGATIVE_INFINITY ? Number.POSITIVE_INFINITY : at - latest
  }

  /** Drop one key's history, for example when its thread is archived. */
  forget(key: string): void {
    this.hits.delete(key)
  }

  /** Number of tracked keys, exposed for the panel and for tests. */
  size(): number {
    return this.hits.size
  }

  clear(): void {
    this.hits.clear()
  }

  private entries(key: string): number[] {
    const existing = this.hits.get(key)
    if (existing) return existing
    const created: number[] = []
    this.hits.set(key, created)
    return created
  }

  private evict(): void {
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value
      if (oldest === undefined) break
      this.hits.delete(oldest)
    }
  }
}

/** The two numbers `GateInput` needs for one conversation. */
export interface GateCounterSnapshot {
  readonly hour: number
  readonly gapMs: number
}

/** Read the gate's counters from one store, so callers do not repeat window sizes. */
export function readGateCounters(
  store: SlidingWindowCounter,
  key: string,
  at: number = Date.now(),
): GateCounterSnapshot {
  return { hour: store.count(key, at, HOUR_MS), gapMs: store.gapMs(key, at) }
}
