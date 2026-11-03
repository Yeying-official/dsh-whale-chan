import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine, type InboundMessage } from '../src/core/index.ts'
import { Kv } from '../src/app/kv.ts'
import { Store } from '../src/app/store.ts'
import { counterKey, KvCounterStore, readGateCounters } from '../src/app/counters.ts'
import {
  consecutiveAiReplies,
  isBroadcast,
  latestMessage,
  recentOutboundTexts,
  threadTarget,
  threadWindow,
  THREAD_WINDOW_SIZE,
} from '../src/app/thread-state.ts'

let root = ''
let store: Store | undefined
let engine: Engine | undefined
let kv: Kv | undefined
let now = Date.parse('2026-11-02T09:00:00.000Z')

const KEY = 'rate:dm:user-1'

function open(): { store: Store; engine: Engine; kv: Kv; counters: KvCounterStore } {
  store = Store.open(root)
  const clock = { now: () => new Date(now) }
  let sequence = 0
  engine = new Engine({
    repos: store,
    ids: { next: (prefix) => `${prefix}-${(sequence += 1)}` },
    clock,
  })
  kv = new Kv(store)
  return { store, engine, kv, counters: new KvCounterStore(kv, { now: () => now }) }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-counters-'))
  now = Date.parse('2026-11-02T09:00:00.000Z')
})

afterEach(async () => {
  store?.close()
  store = undefined
  engine = undefined
  kv = undefined
  await rm(root, { recursive: true, force: true })
})

describe('durable rate counters', () => {
  it('counts hits inside a rolling window and reports the window count', () => {
    const { counters } = open()
    expect(counters.hit(KEY, now)).toBe(1)
    expect(counters.hit(KEY, now + 1_000)).toBe(2)
    expect(counters.count(KEY, now + 1_000)).toBe(2)
    // One hour later the first two are outside the window.
    expect(counters.count(KEY, now + 60 * 60_000 + 2_000)).toBe(0)
  })

  it('prunes timestamps on write instead of growing forever', () => {
    const { counters, kv } = open()
    counters.hit(KEY, now)
    counters.hit(KEY, now + 1_000)
    counters.hit(KEY, now + 60 * 60_000 + 5_000)
    const stored = kv.get<number[]>(counterKey('dm:user-1')) ?? []
    expect(stored).toEqual([now + 60 * 60_000 + 5_000])
  })

  it('keeps counts across a fresh store instance', () => {
    const first = open()
    first.counters.hit(KEY, now)
    first.counters.hit(KEY, now + 5_000)
    const before = first.counters.count(KEY, now + 6_000)
    expect(before).toBe(2)

    // A second counter over the same database still sees both replies.
    const second = new KvCounterStore(new Kv(first.store), { now: () => now + 6_000 })
    expect(second.count(KEY, now + 6_000)).toBe(2)
  })

  it('computes the gap from the newest hit at or before the query instant', () => {
    const { counters } = open()
    expect(counters.gapMs(KEY, now)).toBe(Number.POSITIVE_INFINITY)
    counters.hit(KEY, now)
    expect(counters.gapMs(KEY, now + 2_500)).toBe(2_500)
    // A hit later than the query instant does not make the gap negative.
    expect(counters.gapMs(KEY, now + 1_000)).toBe(1_000)
  })

  it('provides the two gate numbers from one key', () => {
    const { counters } = open()
    counters.hit(counterKey('dm:user-1'), now)
    counters.hit(counterKey('dm:user-1'), now + 3_000)
    counters.hit(counterKey('group:cid-1'), now)
    expect(readGateCounters(counters, 'dm:user-1', now + 4_000)).toEqual({ hour: 2, gapMs: 1_000 })
    expect(readGateCounters(counters, 'group:cid-1', now + 4_000)).toEqual({ hour: 1, gapMs: 4_000 })
    expect(readGateCounters(counters, 'dm:other', now)).toEqual({ hour: 0, gapMs: Number.POSITIVE_INFINITY })
  })

  it('recovers from a corrupt counter instead of breaking the gate', () => {
    const { counters, kv } = open()
    kv.set(KEY, { not: 'timestamps' })
    expect(counters.count(KEY, now)).toBe(0)
    expect(counters.hit(KEY, now)).toBe(1)
  })
})

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'message-1',
    targetId: 'target-1',
    threadKey: 'group:cid-1',
    kind: 'group',
    conversationId: 'cid-1',
    conversationType: 'group',
    sender: { userId: 'user-1', nick: 'Alice' },
    text: '在吗？',
    addressed: true,
    at: '2026-11-02T08:59:00.000Z',
    receivedAt: '2026-11-02T09:00:00.000Z',
    mentions: [],
    ...overrides,
  }
}

describe('thread state used by the reply gate', () => {
  it('reads the recent outbound texts of the conversation', () => {
    const { store, engine } = open()
    engine.receive(inbound())
    engine.queueFollowup({
      threadKey: 'group:cid-1',
      target: { kind: 'group', conversationId: 'cid-1' },
      text: '第一条回复',
      idempotencyKey: 'notice-1',
      kind: 'notice',
      outboundId: 'outbound-1',
    })
    engine.queueFollowup({
      threadKey: 'group:cid-1',
      target: { kind: 'group', conversationId: 'cid-1' },
      text: '第二条回复',
      idempotencyKey: 'notice-2',
      kind: 'notice',
      outboundId: 'outbound-2',
    })
    expect(recentOutboundTexts(store, 'group:cid-1')).toEqual(['第二条回复', '第一条回复'])
    expect(recentOutboundTexts(store, 'group:other')).toEqual([])
  })

  it('counts the reply streak and resets it on a newer inbound message', () => {
    const { store, engine } = open()
    engine.receive(inbound())
    for (const [index, at] of ['2026-11-02T09:01:00.000Z', '2026-11-02T09:02:00.000Z'].entries()) {
      engine.queueFollowup({
        threadKey: 'group:cid-1',
        target: { kind: 'group', conversationId: 'cid-1' },
        text: `回复 ${index}`,
        idempotencyKey: `followup-${index}`,
        kind: 'reply',
        outboundId: `outbound-${index}`,
      })
      engine.outboundSent(`outbound-${index}`)
      now = Date.parse(at)
    }
    expect(consecutiveAiReplies(store, 'group:cid-1')).toBe(2)

    // A person answers: the streak restarts at zero.
    now = Date.parse('2026-11-02T09:03:00.000Z')
    engine.receive(inbound({ id: 'message-2', at: '2026-11-02T09:03:00.000Z', receivedAt: '2026-11-02T09:03:00.000Z' }))
    expect(consecutiveAiReplies(store, 'group:cid-1')).toBe(0)
  })

  it('derives a delivery target from the thread and its latest message', () => {
    const { store, engine } = open()
    engine.receive(inbound())
    const group = engine.thread('group:cid-1')
    expect(threadTarget(group!)).toEqual({ kind: 'group', conversationId: 'cid-1' })

    engine.receive(
      inbound({
        id: 'message-dm',
        threadKey: 'dm:user-9',
        kind: 'dm',
        conversationType: 'direct',
        conversationId: 'user-9',
        sender: { userId: 'user-9', nick: 'Bob' },
      }),
    )
    const dm = engine.thread('dm:user-9')
    expect(threadTarget(dm!)).toEqual({ kind: 'dm', conversationId: 'user-9', peerUserId: 'user-9' })
  })

  it('detects broadcasts from mentions and text', () => {
    expect(isBroadcast(inbound({ mentions: ['@all'], text: '通知' }))).toBe(true)
    expect(isBroadcast(inbound({ mentions: ['所有人'], text: '通知' }))).toBe(true)
    expect(isBroadcast(inbound({ mentions: [], text: '@所有人 开会' }))).toBe(true)
    expect(isBroadcast(inbound({ mentions: ['user-1'], text: '在吗' }))).toBe(false)
  })

  it('bounds the conversation window and marks the owner as self', () => {
    const { store, engine } = open()
    for (let index = 0; index < THREAD_WINDOW_SIZE + 5; index += 1) {
      engine.receive(
        inbound({
          id: `message-${index}`,
          at: `2026-11-02T09:${String(index).padStart(2, '0')}:00.000Z`,
          receivedAt: `2026-11-02T09:${String(index).padStart(2, '0')}:00.000Z`,
          sender:
            index === THREAD_WINDOW_SIZE + 4
              ? { userId: 'owner-1', nick: '主人' }
              : { userId: 'user-1', nick: 'Alice' },
        }),
      )
    }
    const window = threadWindow(store, 'group:cid-1', 'owner-1')
    expect(window).toHaveLength(THREAD_WINDOW_SIZE)
    expect(window.at(-1)).toMatchObject({ author: '主人', self: true })
    expect(latestMessage(store, 'group:cid-1')?.id).toBe(`message-${THREAD_WINDOW_SIZE + 4}`)
  })
})
