import { describe, expect, it } from 'vitest'
import { HOUR_MS, SlidingWindowCounter, readGateCounters } from '../src/brain/rate-limit.ts'

describe('SlidingWindowCounter', () => {
  it('counts the hits that fall inside the window', () => {
    const counter = new SlidingWindowCounter()
    expect(counter.hit('thread-1', 0, HOUR_MS)).toBe(1)
    expect(counter.hit('thread-1', 1_000, HOUR_MS)).toBe(2)
    expect(counter.hit('thread-1', 2_000, HOUR_MS)).toBe(3)
    // A hit exactly one window old has already left the window.
    expect(counter.hit('thread-1', HOUR_MS, HOUR_MS)).toBe(3)
  })

  it('forgets hits that left the window', () => {
    const counter = new SlidingWindowCounter()
    counter.hit('thread-1', 0, HOUR_MS)
    counter.hit('thread-1', 10_000, HOUR_MS)
    expect(counter.count('thread-1', HOUR_MS + 1, HOUR_MS)).toBe(1)
    expect(counter.count('thread-1', HOUR_MS + 11_000, HOUR_MS)).toBe(0)
    expect(counter.size()).toBe(0)
  })

  it('keeps keys independent', () => {
    const counter = new SlidingWindowCounter()
    counter.hit('a', 0)
    counter.hit('b', 0)
    counter.hit('b', 1)
    expect(counter.count('a', 2)).toBe(1)
    expect(counter.count('b', 2)).toBe(2)
  })

  it('answers gapMs from the most recent hit at or before the instant', () => {
    const counter = new SlidingWindowCounter()
    expect(counter.gapMs('thread-1', 0)).toBe(Number.POSITIVE_INFINITY)
    counter.hit('thread-1', 1_000)
    expect(counter.gapMs('thread-1', 1_000)).toBe(0)
    expect(counter.gapMs('thread-1', 4_500)).toBe(3_500)
    // A hit in the future does not count as the previous one.
    expect(counter.gapMs('thread-1', 500)).toBe(Number.POSITIVE_INFINITY)
  })

  it('accepts out-of-order hits and still answers correctly', () => {
    const counter = new SlidingWindowCounter()
    counter.hit('thread-1', 20_000)
    counter.hit('thread-1', 10_000)
    expect(counter.count('thread-1', 20_000)).toBe(2)
    expect(counter.count('thread-1', 30_000, 30_000)).toBe(2)
    expect(counter.gapMs('thread-1', 30_000)).toBe(10_000)
  })

  it('uses an injected clock when no instant is given', () => {
    let now = 5_000
    const counter = new SlidingWindowCounter({ now: () => now })
    expect(counter.hit('thread-1')).toBe(1)
    now += 2_000
    expect(counter.gapMs('thread-1')).toBe(2_000)
    expect(counter.count('thread-1')).toBe(1)
  })

  it('evicts the oldest key when the store is full', () => {
    const counter = new SlidingWindowCounter({ maxKeys: 2 })
    counter.hit('a', 0)
    counter.hit('b', 1)
    counter.hit('c', 2)
    expect(counter.size()).toBe(2)
    expect(counter.count('a', 3)).toBe(0)
    expect(counter.count('c', 3)).toBe(1)
  })

  it('can forget one conversation and be cleared', () => {
    const counter = new SlidingWindowCounter()
    counter.hit('a', 0)
    counter.forget('a')
    expect(counter.count('a', 1)).toBe(0)
    counter.hit('b', 0)
    counter.clear()
    expect(counter.size()).toBe(0)
  })

  it('exposes the two numbers the gate needs', () => {
    const counter = new SlidingWindowCounter()
    counter.hit('thread-1', 0)
    counter.hit('thread-1', 2_000)
    expect(readGateCounters(counter, 'thread-1', 3_000)).toEqual({ hour: 2, gapMs: 1_000 })
    expect(readGateCounters(counter, 'thread-2', 3_000)).toEqual({
      hour: 0,
      gapMs: Number.POSITIVE_INFINITY,
    })
  })
})
