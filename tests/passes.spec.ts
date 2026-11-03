import { describe, expect, it } from 'vitest'
import { Passes } from '../src/app/passes.ts'
import { createClock } from './fixtures/domain.ts'

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('passes scheduler', () => {
  it('runs a pass after its interval and not before', async () => {
    const passes = new Passes({ clock: createClock() })
    const runs: Date[] = []
    passes.register(
      'digest',
      (now) => {
        runs.push(now)
      },
      { intervalMs: 1_000 },
    )

    await passes.tick(new Date('2026-11-02T09:00:00.500Z'))
    expect(runs).toHaveLength(0)
    await passes.tick(new Date('2026-11-02T09:00:01.000Z'))
    expect(runs).toHaveLength(1)
    await passes.tick(new Date('2026-11-02T09:00:01.500Z'))
    expect(runs).toHaveLength(1)
    await passes.tick(new Date('2026-11-02T09:00:02.000Z'))
    expect(runs).toHaveLength(2)
    expect(runs[1]?.toISOString()).toBe('2026-11-02T09:00:02.000Z')
  })

  it('runs a runAtStart pass on the first tick', async () => {
    const passes = new Passes({ clock: createClock() })
    let runs = 0
    passes.register(
      'startup',
      () => {
        runs += 1
      },
      { intervalMs: 60_000, runAtStart: true },
    )
    await passes.tick(new Date('2026-11-02T09:00:00.000Z'))
    expect(runs).toBe(1)
    await passes.tick(new Date('2026-11-02T09:00:01.000Z'))
    expect(runs).toBe(1)
  })

  it('never overlaps one pass with itself', async () => {
    const passes = new Passes({ clock: createClock() })
    const gate = deferred()
    let runs = 0
    passes.register(
      'slow',
      async () => {
        runs += 1
        await gate.promise
      },
      { intervalMs: 100 },
    )
    const first = passes.tick(new Date('2026-11-02T09:00:01.000Z'))
    await flush()
    expect(runs).toBe(1)
    await passes.tick(new Date('2026-11-02T09:00:03.000Z'))
    expect(runs).toBe(1)

    gate.resolve()
    await first
    await passes.tick(new Date('2026-11-02T09:00:04.000Z'))
    expect(runs).toBe(2)
  })

  it('isolates a failing pass from the other passes and the next round', async () => {
    const errors: { name: string; error: unknown }[] = []
    const passes = new Passes({
      clock: createClock(),
      onError: (name, error) => errors.push({ name, error }),
    })
    let healthy = 0
    passes.register(
      'sync-failure',
      () => {
        throw new Error('nope')
      },
      { intervalMs: 1_000 },
    )
    passes.register('async-failure', () => Promise.reject(new Error('later')), { intervalMs: 1_000 })
    passes.register(
      'healthy',
      () => {
        healthy += 1
      },
      { intervalMs: 1_000 },
    )

    await passes.tick(new Date('2026-11-02T09:00:01.000Z'))
    expect(healthy).toBe(1)
    expect(errors.map((entry) => entry.name).sort()).toEqual(['async-failure', 'sync-failure'])

    await passes.tick(new Date('2026-11-02T09:00:02.000Z'))
    expect(healthy).toBe(2)
    expect(errors).toHaveLength(4)
  })

  it('stops scheduling and waits for the round already running', async () => {
    const passes = new Passes({ clock: createClock() })
    const gate = deferred()
    let finished = 0
    passes.register(
      'slow',
      async () => {
        await gate.promise
        finished += 1
      },
      { intervalMs: 1_000, runAtStart: true },
    )
    passes.start()
    await flush()
    expect(finished).toBe(0)

    const stopping = passes.stop()
    await flush()
    expect(finished).toBe(0)
    gate.resolve()
    await stopping
    expect(finished).toBe(1)

    await passes.tick(new Date('2026-11-02T09:05:00.000Z'))
    expect(finished).toBe(1)
  })

  it('rejects duplicate names and non-positive intervals', () => {
    const passes = new Passes({ clock: createClock() })
    passes.register('one', () => undefined, { intervalMs: 1_000 })
    expect(() => passes.register('one', () => undefined, { intervalMs: 1_000 })).toThrow(/already registered/)
    expect(() => passes.register('bad', () => undefined, { intervalMs: 0 })).toThrow(/positive/)
  })
})
