import { describe, expect, it } from 'vitest'
import type { InboundMessage } from '../src/core/model.ts'
import { normalizeEvent, summarizeRawEvent, toConversationType, toIsoTime } from '../src/channel/normalize.ts'
import type { DwsTarget } from '../src/channel/types.ts'

const ownerUserId = 'u-owner'
const atMe: DwsTarget = { kind: 'at-me', id: 'at-me', mentionOnly: true, enabled: true }
const groupTarget: DwsTarget = { kind: 'group', id: 'cid-1', mentionOnly: true, enabled: true }
const dmTarget: DwsTarget = { kind: 'dm', id: 'u-peer', mentionOnly: true, enabled: true }
const now = () => new Date('2026-11-03T00:00:00.000Z')

function normalize(raw: unknown, target: DwsTarget = atMe, extra: Record<string, unknown> = {}) {
  return normalizeEvent(raw, { ownerUserId, target, now, ...extra })
}

function asMessage(result: ReturnType<typeof normalize>): InboundMessage {
  if ('skip' in result) throw new Error(`expected a message, got skip=${result.skip}`)
  return result
}

function skipOf(result: ReturnType<typeof normalize>): string {
  if (!('skip' in result)) throw new Error('expected a skip')
  return result.skip
}

const atEvent = {
  eventType: 'user_im_message_receive_at',
  msgId: 'msg-1',
  conversationId: 'cid-1',
  conversationType: 'group',
  conversationTitle: 'AI工程师孵化中心',
  senderStaffId: 'u-alice',
  senderNick: 'Alice',
  text: '@鲸鱼酱 帮我看看',
  createAt: 1_760_000_000_000,
  atUsers: ['u-owner'],
}

describe('normalizeEvent: kinds and addressing', () => {
  it('turns an at-me event into a group-thread message addressed to the owner', () => {
    const message = asMessage(normalize(atEvent))
    expect(message.kind).toBe('at-me')
    expect(message.targetId).toBe('at-me')
    expect(message.id).toBe('msg-1')
    expect(message.threadKey).toBe('group:cid-1')
    expect(message.conversationType).toBe('group')
    expect(message.title).toBe('AI工程师孵化中心')
    expect(message.addressed).toBe(true)
    expect(message.sender).toEqual({ userId: 'u-alice', nick: 'Alice' })
    expect(message.text).toBe('@鲸鱼酱 帮我看看')
    expect(message.at).toBe('2025-10-09T08:53:20.000Z')
    expect(message.receivedAt).toBe('2026-11-03T00:00:00.000Z')
  })

  it('marks an unmentioned group message as not addressed and keeps it for the decision layer', () => {
    const result = normalize({ ...atEvent, msgId: 'msg-2', text: '大家好', atUsers: ['u-other'] }, groupTarget)
    const message = asMessage(result)
    expect(message.kind).toBe('group')
    expect(message.addressed).toBe(false)
  })

  it('treats a literal @我 in a group text as addressed when the owner nick is known', () => {
    const message = asMessage(
      normalize({ ...atEvent, text: '@我 帮忙看一下', atUsers: [] }, groupTarget, { ownerNick: '鲸鱼酱' }),
    )
    expect(message.addressed).toBe(true)
  })

  it('keeps structured atUsers as mentions and still addresses by text', () => {
    const message = asMessage(
      normalize({ ...atEvent, text: '@鲸鱼酱 帮我', atUsers: [{ userId: 'u-owner', name: '主人' }] }, groupTarget, {
        ownerNick: '鲸鱼酱',
      }),
    )
    expect(message.addressed).toBe(true)
    expect(message.mentions).toContain('u-owner')
  })

  it('always addresses a one-to-one message and keys its thread by peer', () => {
    const message = asMessage(
      normalize(
        {
          msgId: 'dm-1',
          conversationType: 'direct',
          senderStaffId: 'u-peer',
          senderNick: '张三',
          text: '在吗',
          createTime: '2026-11-02T10:00:00.000Z',
        },
        dmTarget,
      ),
    )
    expect(message.kind).toBe('dm')
    expect(message.conversationType).toBe('direct')
    expect(message.conversationId).toBe('u-peer')
    expect(message.threadKey).toBe('dm:u-peer')
    expect(message.addressed).toBe(true)
    expect(message.at).toBe('2026-11-02T10:00:00.000Z')
  })

  it('maps the DingTalk numeric conversation type onto the two domain values', () => {
    expect(toConversationType('1')).toBe('direct')
    expect(toConversationType('2')).toBe('group')
    expect(toConversationType('p2p')).toBe('direct')
    expect(toConversationType('mystery')).toBeUndefined()
    expect(toConversationType(undefined)).toBeUndefined()
  })
})

describe('normalizeEvent: skips', () => {
  it('skips a message written by the authorized account itself', () => {
    const result = normalize({ ...atEvent, senderStaffId: ownerUserId, text: 'echo' })
    expect(skipOf(result)).toBe('self')
  })

  it('skips an @所有人 broadcast when ignoreBroadcast is on', () => {
    const result = normalize({ ...atEvent, text: '@所有人 十点开会', atUsers: ['@all'] }, groupTarget)
    expect(skipOf(result)).toBe('broadcast')
  })

  it('keeps a broadcast when ignoreBroadcast is off', () => {
    const message = asMessage(
      normalize({ ...atEvent, text: '@所有人 十点开会', atUsers: ['@all'] }, groupTarget, {
        ignoreBroadcast: false,
      }),
    )
    expect(message.addressed).toBe(false)
    expect(message.mentions).toEqual(['@all', '所有人'])
  })

  it('keeps a broadcast that also mentions the owner directly', () => {
    const message = asMessage(
      normalize({ ...atEvent, text: '@所有人 @鲸鱼酱 你看', atUsers: ['@all', 'u-owner'] }, groupTarget, {
        ownerNick: '鲸鱼酱',
      }),
    )
    expect(message.addressed).toBe(true)
  })

  it('skips an empty text without media', () => {
    const result = normalize({ ...atEvent, text: '   ' }, groupTarget)
    expect(skipOf(result)).toBe('empty')
  })

  it('skips a media-only message as unsupported', () => {
    const result = normalize({ ...atEvent, msgtype: 'picture', text: undefined }, groupTarget)
    expect(result).toMatchObject({ skip: 'unsupported', detail: 'media-only' })
  })

  it('rejects a line without a stable message id', () => {
    const { msgId: _drop, ...raw } = atEvent
    expect(skipOf(normalize(raw))).toBe('malformed')
  })

  it('rejects a group line without a conversation id', () => {
    const raw = { ...atEvent, conversationId: undefined, openConversationId: undefined }
    expect(skipOf(normalize(raw, groupTarget))).toBe('malformed')
  })

  it('rejects a non-object line', () => {
    expect(skipOf(normalize('not-json'))).toBe('malformed')
    expect(skipOf(normalize([]))).toBe('malformed')
  })

  it('skips recall and system events as unsupported', () => {
    expect(skipOf(normalize({ ...atEvent, msgtype: 'revoke' }))).toBe('unsupported')
    expect(skipOf(normalize({ ...atEvent, eventType: 'system', msgId: 's-1' }))).toBe('unsupported')
  })
})

describe('normalizeEvent: field aliases', () => {
  it('accepts snake_case keys and a nested content object', () => {
    const message = asMessage(
      normalize({
        message_id: 'alias-1',
        openConversationId: 'cid-alias',
        conversation_type: '2',
        senderId: 'u-bob',
        senderName: 'Bob',
        content: { text: 'hello via content' },
        timestamp: '1760000000000',
        mentions: ['u-owner'],
      }),
    )
    expect(message.id).toBe('alias-1')
    expect(message.conversationId).toBe('cid-alias')
    expect(message.conversationType).toBe('group')
    expect(message.sender).toEqual({ userId: 'u-bob', nick: 'Bob' })
    expect(message.text).toBe('hello via content')
    expect(message.at).toBe('2025-10-09T08:53:20.000Z')
  })

  it('reads a text object carried under text.content', () => {
    const message = asMessage(normalize({ ...atEvent, text: { content: 'nested text' } }))
    expect(message.text).toBe('nested text')
  })

  it('truncates an oversized body to the configured ceiling', () => {
    const message = asMessage(
      normalize({ ...atEvent, text: 'x'.repeat(40), msgId: 'long-1' }, atMe, { maxTextChars: 10 }),
    )
    expect(message.text).toHaveLength(10)
  })

  it('parses epoch seconds, epoch milliseconds and ISO dates', () => {
    expect(toIsoTime(1_760_000_000)).toBe('2025-10-09T08:53:20.000Z')
    expect(toIsoTime(1_760_000_000_000)).toBe('2025-10-09T08:53:20.000Z')
    expect(toIsoTime('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z')
    expect(toIsoTime('not-a-date')).toBeUndefined()
  })
})

describe('summarizeRawEvent', () => {
  it('lists unknown field names but never their values', () => {
    const summary = summarizeRawEvent({
      ...atEvent,
      secretPayload: 'very sensitive body',
      senderStaffId: 'u-alice',
    })
    const serialized = JSON.stringify(summary.fields)
    expect(summary.keys).toContain('secretPayload')
    expect(serialized).not.toContain('very sensitive body')
    expect(serialized).not.toContain('u-alice')
    expect(serialized).not.toContain('msg-1')
    // Structural fields are still visible for debugging.
    expect(summary.fields.eventType).toBe('user_im_message_receive_at')
    expect(summary.fields.conversationType).toBe('group')
  })

  it('truncates and redacts the whitelisted values it does keep', () => {
    const summary = summarizeRawEvent({ ...atEvent, title: `token=abc123 ${'z'.repeat(300)}` }, 40)
    expect(summary.fields.title).not.toContain('abc123')
    expect((summary.fields.title ?? '').length).toBeLessThanOrEqual(40)
  })
})
