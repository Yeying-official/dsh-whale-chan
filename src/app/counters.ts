/**
 * Durable sliding-window counters for the reply gate.
 *
 * The gate needs two numbers per conversation: how many replies went out in the
 * last hour, and how long ago the last one did. WS3 ships an in-memory
 * implementation for tests, but a restart must not forget a reply: forgetting a
 * rate would let the assistant talk more than the owner allowed. This store
 * keeps the timestamps in the state database's generic `kv` table, one key per
 * conversation, and prunes them on every write.
 *
 * Time is always passed in, so a test can drive the window without waiting.
 */
import { HOUR_MS, type CounterStore } from '../brain/index.ts'
import type { Kv } from './kv.ts'

/** Prefix of every counter key; the thread key follows it verbatim. */
export const COUNTER_KEY_PREFIX = 'rate:'

/** Key one conversation's timestamps are stored under. */
export function counterKey(threadKey: string): string {
  return `${COUNTER_KEY_PREFIX}${threadKey}`
}

function timestamps(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const kept: number[] = []
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item)) kept.push(item)
  }
  return kept
}

/**
 * `CounterStore` over one `Kv`.
 *
 * `hit` records and returns the window count; `count` and `gapMs` are the
 * read-only views the gate needs. A key whose stored JSON is unreadable is
 * treated as empty and rewritten on the next hit: a corrupt counter must not
 * stop the assistant from replying safely, and the safe interpretation of a
 * corrupt rate is "no recent reply".
 */
export class KvCounterStore implements CounterStore {
  private readonly now: () => number

  constructor(
    private readonly kv: Kv,
    options: { readonly now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => Date.now())
  }

  /** Record one reply at `at` and return how many hits fall inside the window. */
  hit(key: string, at: number = this.now(), windowMs: number = HOUR_MS): number {
    const kept = this.prune(this.read(key), at, windowMs)
    let index = kept.length
    while (index > 0 && (kept[index - 1] ?? 0) > at) index -= 1
    kept.splice(index, 0, at)
    this.kv.set(key, kept)
    return kept.filter((value) => value <= at).length
  }

  /** Count hits inside the window without recording one. */
  count(key: string, at: number = this.now(), windowMs: number = HOUR_MS): number {
    return this.prune(this.read(key), at, windowMs).filter((value) => value <= at).length
  }

  /** Milliseconds since the most recent hit at or before `at`; `Infinity` when none. */
  gapMs(key: string, at: number = this.now()): number {
    const kept = this.read(key)
    let latest = Number.NEGATIVE_INFINITY
    for (const value of kept) {
      if (value <= at && value > latest) latest = value
    }
    return latest === Number.NEGATIVE_INFINITY ? Number.POSITIVE_INFINITY : at - latest
  }

  /** Drop one conversation's history, for example when its target is removed. */
  forget(key: string): void {
    this.kv.delete(key)
  }

  private read(key: string): number[] {
    try {
      return timestamps(this.kv.get<unknown>(key))
    } catch {
      // A corrupt counter is reset rather than allowed to break the gate.
      this.kv.delete(key)
      return []
    }
  }

  private prune(values: readonly number[], at: number, windowMs: number): number[] {
    const cutoff = at - windowMs
    return values.filter((value) => value > cutoff).sort((left, right) => left - right)
  }
}

/** The two numbers `GateInput` needs for one conversation. */
export interface GateCounterSnapshot {
  readonly hour: number
  readonly gapMs: number
}

/** Read the gate's counters for one thread key, so callers do not repeat window sizes. */
export function readGateCounters(counter: KvCounterStore, threadKey: string, at: number): GateCounterSnapshot {
  const key = counterKey(threadKey)
  return { hour: counter.count(key, at, HOUR_MS), gapMs: counter.gapMs(key, at) }
}
