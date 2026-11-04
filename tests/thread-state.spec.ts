/**
 * The thread projections that stand between the domain and the channel.
 *
 * A one-to-one event may carry only the sender's open id, and that id cannot be
 * passed to `--user`. These tests pin the `open:` spelling on the outbound
 * target, and the loop-guard queries that must keep matching replies queued
 * before and after that spelling changed.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine, type InboundMessage, type Thread } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { threadKeyOf } from '../src/app/effects-chat.ts'
import { consecutiveAiReplies, recentOutboundTexts, threadTarget } from '../src/app/thread-state.ts'

let root = ''
let store: Store | undefined
let engine: Engine | undefined
let now = Date.parse('2026-11-02T09:00:00.000Z')

function open(): { store: Store; engine: Engine } {
  store = Store.open(root)
  const clock = { now: () => new Date(now) }
  let sequence = 0
  engine = new Engine({ repos: store, ids: { next: (prefix) => `${prefix}-${(sequence += 1)}` }, clock })
  return { store, engine }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-thread-state-'))
  now = Date.parse('2026-11-02T09:00:00.000Z')
})

afterEach(async () => {
  store?.close()
  store = undefined
  engine = undefined
  await rm(root, { recursive: true, force: true })
})

function dmInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'dm-1',
    targetId: 'target-dm',
    threadKey: 'dm:user-9',
    kind: 'dm',
    conversationId: 'user-9',
    conversationType: 'direct',
    sender: { userId: 'user-9', nick: 'Bob' },
    text: '在吗？',
    addressed: true,
    at: '2026-11-02T08:59:00.000Z',
    receivedAt: '2026-11-02T09:00:00.000Z',
    mentions: [],
    ...overrides,
  }
}

function groupInbound(): InboundMessage {
  return {
    id: 'group-1',
    targetId: 'target-group',
    threadKey: 'group:cid-1',
    kind: 'group',
    conversationId: 'cid-1',
    conversationType: 'group',
    sender: { userId: 'user-1', nick: 'Alice' },
    text: '@Whale 在吗？',
    addressed: true,
    at: '2026-11-02T08:59:00.000Z',
    receivedAt: '2026-11-02T09:00:00.000Z',
    mentions: ['@Whale'],
  }
}

describe('threadTarget', () => {
  it('keeps the open id on a direct-message target', () => {
    const { engine } = open()
    engine.receive(
      dmInbound({
        threadKey: 'dm:staff-1',
        conversationId: 'staff-1',
        sender: { userId: 'staff-1', openDingTalkId: 'DO2...', nick: 'Bob' },
      }),
    )
    const thread = engine.thread('dm:staff-1')
    expect(threadTarget(thread!)).toEqual({
      kind: 'dm',
      conversationId: 'staff-1',
      peerUserId: 'open:DO2...',
    })
  })

  it('falls back to the user id when no open id is known', () => {
    const { engine } = open()
    engine.receive(dmInbound())
    const thread = engine.thread('dm:user-9')
    expect(threadTarget(thread!)).toEqual({
      kind: 'dm',
      conversationId: 'user-9',
      peerUserId: 'user-9',
    })
  })

  it('omits an empty peer instead of persisting an empty id', () => {
    const thread: Thread = {
      key: 'dm:conv-9',
      targetId: 'target-dm',
      kind: 'dm',
      title: 'Bob',
      peer: null,
      lastMessageAt: '2026-11-02T09:00:00.000Z',
      createdAt: '2026-11-02T09:00:00.000Z',
      counts: { inbound: 1, replied: 0, tasks: 0 },
    }
    expect(threadTarget(thread)).toEqual({ kind: 'dm', conversationId: 'conv-9' })
    expect(threadTarget(thread)).not.toHaveProperty('peerUserId')
  })

  it('keeps a group target on the conversation id', () => {
    const { engine } = open()
    engine.receive(groupInbound())
    const thread = engine.thread('group:cid-1')
    expect(threadTarget(thread!)).toEqual({ kind: 'group', conversationId: 'cid-1' })
  })
})

describe('threadKeyOf', () => {
  it('strips the send-only open prefix from a direct message', () => {
    expect(threadKeyOf({ kind: 'dm', conversationId: 'ignored', peerUserId: 'open:x' })).toBe('dm:x')
    expect(threadKeyOf({ kind: 'dm', conversationId: 'ignored', peerUserId: 'x' })).toBe('dm:x')
  })
})

describe('loop-guard queries across the open-id change', () => {
  /** A dm thread whose only identity is the open id: userId mirrors it. */
  function openIdThread(engine: Engine): void {
    engine.receive(
      dmInbound({
        threadKey: 'dm:x',
        conversationId: 'thread-conv',
        sender: { userId: 'x', openDingTalkId: 'x', nick: 'Bob' },
      }),
    )
  }

  /** One dm outbound row under an explicit conversation and peer spelling. */
  function followup(
    engine: Engine,
    options: {
      readonly text: string
      readonly conversationId: string
      readonly peerUserId: string
      readonly at: number
    },
  ): string {
    const key = `followup-${options.peerUserId}`
    engine.queueFollowup({
      threadKey: 'dm:x',
      target: { kind: 'dm', conversationId: options.conversationId, peerUserId: options.peerUserId },
      text: options.text,
      idempotencyKey: key,
      kind: 'reply',
      outboundId: key,
    })
    now = options.at
    engine.outboundSent(key)
    return key
  }

  it('matches both the legacy bare open id and the prefixed one', () => {
    const { store, engine } = open()
    openIdThread(engine)
    followup(engine, {
      text: '旧回复',
      conversationId: 'conv-legacy',
      peerUserId: 'x',
      at: Date.parse('2026-11-02T09:01:00.000Z'),
    })
    followup(engine, {
      text: '新回复',
      conversationId: 'conv-open',
      peerUserId: 'open:x',
      at: Date.parse('2026-11-02T09:02:00.000Z'),
    })
    // Neither conversation id is the thread's latest one, so only the peer
    // spelling can have matched these rows.
    expect(recentOutboundTexts(store, 'dm:x')).toEqual(['新回复', '旧回复'])
  })

  it('counts the reply streak for both spellings', () => {
    const { store, engine } = open()
    openIdThread(engine)
    followup(engine, {
      text: '旧回复',
      conversationId: 'conv-legacy',
      peerUserId: 'x',
      at: Date.parse('2026-11-02T09:01:00.000Z'),
    })
    followup(engine, {
      text: '新回复',
      conversationId: 'conv-open',
      peerUserId: 'open:x',
      at: Date.parse('2026-11-02T09:02:00.000Z'),
    })
    expect(consecutiveAiReplies(store, 'dm:x')).toBe(2)
  })
})
