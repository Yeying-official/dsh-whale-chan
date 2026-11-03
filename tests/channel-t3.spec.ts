/**
 * T3 captured the real flattened group event: snake_case, no atUsers, the
 * sender's open id as the only identity, and `@nick` only inside `content`.
 *
 * The WS2 decoder had been built from the help text and camelCase guesses, so
 * every T3 line was skipped as `malformed`. These tests pin the real shape and
 * the rules derived from it (ownerNick, self-detection, title fallback).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { InboundMessage } from '../src/core/model.ts'
import { probeAuth } from '../src/channel/auth.ts'
import { normalizeEvent } from '../src/channel/normalize.ts'
import { createRunner } from '../src/channel/process.ts'
import type { DwsTarget } from '../src/channel/types.ts'
import { SettingsSchema } from '../src/shared/settings.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))
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

const realGroupEvent = {
  type: 'user_im_message_receive_group',
  event_id: 'evt-real-1',
  timestamp: 1793685862067,
  subscribe_id: 'sub-real',
  message_id: 'msg-real-1',
  conversation_id: 'cid-real',
  sender: '张三',
  sender_open_dingtalk_id: 'od-sender',
  content: '@鲸鱼酱 T3 抓包',
  create_time: '2026-11-03 14:04:17',
  event_time: 1793685857502,
}

const labeledGroup: DwsTarget = { ...groupTarget, label: 'AI工程师孵化中心' }

describe('normalizeEvent: T3 flattened shape', () => {
  it('reads the snake_case fields and prefers message_id over event_id', () => {
    const message = asMessage(normalize(realGroupEvent, labeledGroup, { ownerNick: '鲸鱼酱' }))
    expect(message.id).toBe('msg-real-1')
    expect(message.conversationId).toBe('cid-real')
    expect(message.conversationType).toBe('group')
    expect(message.title).toBe('AI工程师孵化中心')
    expect(message.sender).toEqual({ userId: 'od-sender', openDingTalkId: 'od-sender', nick: '张三' })
    expect(message.text).toBe('@鲸鱼酱 T3 抓包')
    expect(message.addressed).toBe(true)
    expect(message.at).toBe(new Date(1793685857502).toISOString())
    expect(message.mentions).toEqual(['鲸鱼酱'])
  })

  it('does not treat a group message as addressed without the owner nick', () => {
    const message = asMessage(normalize(realGroupEvent, labeledGroup))
    expect(message.addressed).toBe(false)
  })

  it('leaves an unmentioned group message unaddressed even with a known owner', () => {
    const message = asMessage(
      normalize({ ...realGroupEvent, content: '大家好' }, labeledGroup, { ownerNick: '鲸鱼酱' }),
    )
    expect(message.addressed).toBe(false)
  })

  it('recognizes the owner by open id or display name for self filtering', () => {
    expect(skipOf(normalize({ ...realGroupEvent, sender_open_dingtalk_id: ownerUserId }, labeledGroup))).toBe('self')
    expect(skipOf(normalize(realGroupEvent, labeledGroup, { ownerNick: '张三' }))).toBe('self')
  })

  it('derives the conversation type from the target when the event omits it', () => {
    const group = asMessage(normalize(realGroupEvent, labeledGroup))
    expect(group.conversationType).toBe('group')
    const dm = asMessage(
      normalize(
        { ...realGroupEvent, message_id: 'msg-dm', conversation_id: undefined, sender_open_dingtalk_id: 'od-peer' },
        dmTarget,
      ),
    )
    expect(dm.conversationType).toBe('direct')
    expect(dm.conversationId).toBe('od-peer')
    expect(dm.threadKey).toBe('dm:od-peer')
  })

  it('parses create_time in the host local timezone when no epoch time exists', () => {
    const message = asMessage(
      normalize({ ...realGroupEvent, event_time: undefined, timestamp: undefined }, labeledGroup),
    )
    expect(message.at).toBe(new Date(2026, 10, 3, 14, 4, 17).toISOString())
  })

  it('parses @mentions out of the plain-text body with dedupe', () => {
    const message = asMessage(normalize({ ...realGroupEvent, content: '@张三 @李四 @张三 看下' }, labeledGroup))
    expect(message.mentions).toEqual(['张三', '李四'])
  })

  it('prefers a staff id and keeps the open id when both are present', () => {
    const message = asMessage(
      normalize({ ...realGroupEvent, sender_staff_id: 'staff-1' }, labeledGroup, { ownerNick: '鲸鱼酱' }),
    )
    expect(message.sender).toEqual({ userId: 'staff-1', openDingTalkId: 'od-sender', nick: '张三' })
  })

  it('returns the owner display name from auth status', async () => {
    const runner = createRunner({
      command: process.execPath,
      baseArgs: [fakeDws],
      env: {
        ...process.env,
        FAKE_DWS_AUTH_RAW: '{"authenticated":true,"token_valid":true,"user_id":"u-1","user_name":"鲸鱼酱"}',
      },
    })
    const state = await probeAuth(SettingsSchema.parse({}), { runner })
    expect(state.userName).toBe('鲸鱼酱')
  })
})
