import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effects, Later, MAX_BACKOFF_MS } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'

let root = ''
let store: Store

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-effects-'))
  store = Store.open(root)
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

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

describe('effects queue', () => {
  it('runs due effects in due order and waits for start', async () => {
    let now = 1_000_000
    const effects = new Effects(store, { now: () => now })
    const seen: string[] = []
    effects.handle('send', (payload) => {
      seen.push((payload as { id: string }).id)
    })
    effects.enqueue('send', 'a', { id: 'a' })
    now += 10
    effects.enqueue('send', 'b', { id: 'b' })
    await flush()
    expect(seen).toEqual([])

    effects.start({ concurrency: 1 })
    await effects.idle()
    expect(seen).toEqual(['a', 'b'])
    expect(effects.pending()).toEqual([])
  })

  it('limits concurrent attempts and continues afterwards', async () => {
    const gate = deferred()
    let started = 0
    const effects = new Effects(store, { now: () => 1_000_000 })
    effects.handle('job', async () => {
      started += 1
      await gate.promise
    })
    for (const key of ['a', 'b', 'c']) effects.enqueue('job', key, { key })
    effects.start({ concurrency: 2 })
    await flush()
    expect(started).toBe(2)
    expect(effects.pending().filter((row) => row.state === 'running')).toHaveLength(2)

    gate.resolve()
    await effects.idle()
    expect(started).toBe(3)
    expect(effects.pending()).toEqual([])
  })

  it('coalesces a waiting row into the latest payload', async () => {
    const seen: unknown[] = []
    const effects = new Effects(store, { now: () => 1_000_000 })
    effects.handle('job', (payload) => {
      seen.push(payload)
    })
    effects.enqueue('job', 'k', { n: 1 })
    effects.enqueue('job', 'k', { n: 2 })
    expect(effects.pending()).toHaveLength(1)
    expect(effects.pending()[0]?.payload).toEqual({ n: 2 })

    effects.start({ concurrency: 1 })
    await effects.idle()
    expect(seen).toEqual([{ n: 2 }])
  })

  it('keeps a re-enqueue that arrives while the effect is running', async () => {
    const gate = deferred()
    const seen: unknown[] = []
    let calls = 0
    const effects = new Effects(store, { now: () => 1_000_000 })
    effects.handle('job', async (payload) => {
      calls += 1
      seen.push(payload)
      if (calls === 1) await gate.promise
    })
    effects.enqueue('job', 'k', { n: 1 })
    effects.start({ concurrency: 1 })
    await flush()
    expect(calls).toBe(1)

    effects.enqueue('job', 'k', { n: 2 })
    expect(effects.pending()).toHaveLength(1)
    gate.resolve()
    await effects.idle()
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
    expect(effects.pending()).toEqual([])
  })

  it('backs off exponentially', async () => {
    let now = 1_000_000
    let attempts = 0
    const effects = new Effects(store, { now: () => now, random: () => 0 })
    effects.handle(
      'job',
      () => {
        attempts += 1
        throw new Error('boom')
      },
      { maxAttempts: 5, baseDelayMs: 1_000 },
    )
    effects.enqueue('job', 'k', {})
    effects.start({ concurrency: 1 })
    await effects.idle()
    expect(effects.pending()[0]).toMatchObject({ attempts: 1, dueAt: now + 1_000 })

    now += 1_000
    await effects.idle()
    expect(effects.pending()[0]).toMatchObject({ attempts: 2, dueAt: now + 2_000 })

    now += 2_000
    await effects.idle()
    expect(effects.pending()[0]).toMatchObject({ attempts: 3, dueAt: now + 4_000 })
    expect(attempts).toBe(3)
  })

  it('caps retries at five minutes', async () => {
    let now = 1_000_000
    const effects = new Effects(store, { now: () => now, random: () => 0 })
    effects.handle('job', () => Promise.reject(new Error('boom')), { maxAttempts: 6, baseDelayMs: 200_000 })
    effects.enqueue('job', 'k', {})
    effects.start({ concurrency: 1 })

    await effects.idle()
    const first = effects.pending()[0]
    expect(first?.attempts).toBe(1)
    expect(first?.dueAt).toBe(now + 200_000)

    now = first?.dueAt as number
    await effects.idle()
    const second = effects.pending()[0]
    expect(second?.attempts).toBe(2)
    expect(second?.dueAt).toBe(now + 300_000)
    expect((second?.dueAt as number) - now).toBe(MAX_BACKOFF_MS)
  })

  it('defers a Later attempt without counting it as a failure', async () => {
    let now = 1_000_000
    let calls = 0
    const effects = new Effects(store, { now: () => now })
    effects.handle('job', async () => {
      calls += 1
      if (calls === 1) throw new Later()
    })
    effects.enqueue('job', 'k', {})
    effects.start({ concurrency: 1 })
    await effects.idle()
    expect(calls).toBe(1)
    expect(effects.pending()[0]).toMatchObject({ state: 'waiting', attempts: 0, lastError: null })

    now += 1_000
    await effects.idle()
    expect(calls).toBe(2)
    expect(effects.pending()).toEqual([])
  })

  it('marks an effect dead after its attempt limit and records the error', async () => {
    let now = 1_000_000
    let calls = 0
    const effects = new Effects(store, { now: () => now, random: () => 0 })
    effects.handle(
      'job',
      () => {
        calls += 1
        throw new Error('boom')
      },
      { maxAttempts: 2, baseDelayMs: 1_000 },
    )
    effects.enqueue('job', 'k', {})
    effects.start({ concurrency: 1 })
    await effects.idle()
    expect(calls).toBe(1)

    now += 1_000
    await effects.idle()
    expect(calls).toBe(2)
    expect(effects.pending()).toEqual([])
    expect(effects.dead()[0]).toMatchObject({ state: 'dead', attempts: 2, lastError: 'boom' })

    await effects.idle()
    expect(calls).toBe(2)
  })

  it('drain waits for running attempts and leaves the rest waiting', async () => {
    const gate = deferred()
    let completed = 0
    const effects = new Effects(store, { now: () => 1_000_000 })
    effects.handle('job', async () => {
      await gate.promise
      completed += 1
    })
    effects.enqueue('job', 'a', {})
    effects.enqueue('job', 'b', {})
    effects.start({ concurrency: 1 })
    await flush()

    const draining = effects.drain()
    await flush()
    expect(completed).toBe(0)
    gate.resolve()
    await draining
    expect(completed).toBe(1)
    expect(effects.pending().map((row) => row.key)).toEqual(['b'])

    effects.start({ concurrency: 1 })
    await effects.idle()
    expect(completed).toBe(2)
    expect(effects.pending()).toEqual([])
  })

  it('leaves rows of a kind without a handler waiting', async () => {
    const effects = new Effects(store, { now: () => 1_000_000 })
    effects.enqueue('unhandled', 'k', {})
    effects.start({ concurrency: 1 })
    await effects.idle()
    expect(effects.pending().map((row) => row.kind)).toEqual(['unhandled'])
  })
})
