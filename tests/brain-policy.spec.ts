import { describe, expect, it } from 'vitest'
import { gateReply, isQuietHour } from '../src/brain/policy.ts'
import { makeGateInput, makeTarget, localTime, settingsWithTarget } from './fixtures/brain.ts'

describe('gateReply', () => {
  it('allows an automatic reply to an ordinary direct message', () => {
    expect(gateReply(makeGateInput())).toEqual({ act: true, mode: 'auto', reason: 'allowed' })
  })

  it('turns everything off when monitoring is disabled or paused', () => {
    expect(gateReply(makeGateInput({ settings: settingsWithTarget({ monitor: { enabled: false } }) }))).toEqual({
      act: false,
      reason: 'monitor_disabled',
    })
    // A hard stop outranks the target's own mode.
    const paused = settingsWithTarget({ monitor: { paused: true } }, { replyMode: 'off' })
    expect(gateReply(makeGateInput({ settings: paused }))).toEqual({ act: false, reason: 'monitor_paused' })
  })

  it('refuses a conversation that is not a configured target', () => {
    const settings = settingsWithTarget()
    expect(gateReply(makeGateInput({ settings, thread: { targetId: 'other-target' } }))).toEqual({
      act: false,
      reason: 'target_missing',
    })
    const disabled = settingsWithTarget({}, { enabled: false })
    expect(gateReply(makeGateInput({ settings: disabled }))).toEqual({ act: false, reason: 'target_disabled' })
  })

  it('lets a target force off or review, never loosen an off', () => {
    expect(gateReply(makeGateInput({ settings: settingsWithTarget({}, { replyMode: 'off' }) }))).toEqual({
      act: false,
      reason: 'target_off',
    })
    expect(gateReply(makeGateInput({ settings: settingsWithTarget({}, { replyMode: 'review' }) }))).toEqual({
      act: true,
      mode: 'review',
      reason: 'target_review',
    })
  })

  it('honours the sender allow list and block list', () => {
    const blocked = settingsWithTarget({ reply: { blockedSenders: ['小明'] } })
    expect(gateReply(makeGateInput({ settings: blocked }))).toEqual({ act: false, reason: 'sender_blocked' })

    const allowedOther = settingsWithTarget({ reply: { allowedSenders: ['别人'] } })
    expect(gateReply(makeGateInput({ settings: allowedOther }))).toEqual({
      act: false,
      reason: 'sender_not_allowed',
    })

    const allowed = settingsWithTarget({ reply: { allowedSenders: ['user-1'] } })
    expect(gateReply(makeGateInput({ settings: allowed }))).toEqual({ act: true, mode: 'auto', reason: 'allowed' })
  })

  it('requires a mention in groups unless the owner turned that off', () => {
    const settings = settingsWithTarget()
    const unaddressed = makeGateInput({ settings, message: { conversationType: 'group' } })
    expect(gateReply(unaddressed)).toEqual({ act: false, reason: 'not_addressed' })

    const addressed = makeGateInput({ settings, message: { conversationType: 'group', addressed: true } })
    expect(gateReply(addressed)).toEqual({ act: true, mode: 'auto', reason: 'allowed' })

    const lenient = settingsWithTarget({ reply: { requireMentionInGroups: false } })
    expect(gateReply(makeGateInput({ settings: lenient, message: { conversationType: 'group' } }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
  })

  it('ignores broadcasts unless the owner accepts them', () => {
    expect(gateReply(makeGateInput({ message: { broadcast: true } }))).toEqual({ act: false, reason: 'broadcast' })
    const lenient = settingsWithTarget({ reply: { ignoreBroadcast: false } })
    expect(gateReply(makeGateInput({ settings: lenient, message: { broadcast: true } }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
  })

  it('downgrades to review inside a same-day quiet window', () => {
    const settings = settingsWithTarget({
      monitor: { quietHours: { enabled: true, start: '12:00', end: '14:00' } },
    })
    expect(gateReply(makeGateInput({ settings, now: localTime(13) }))).toEqual({
      act: true,
      mode: 'review',
      reason: 'quiet_hours',
    })
    expect(gateReply(makeGateInput({ settings, now: localTime(15) }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
  })

  it('downgrades to review across midnight', () => {
    const settings = settingsWithTarget({
      monitor: { quietHours: { enabled: true, start: '22:00', end: '08:00' } },
    })
    for (const hour of [22, 23, 0, 7]) {
      expect(gateReply(makeGateInput({ settings, now: localTime(hour) })), String(hour)).toEqual({
        act: true,
        mode: 'review',
        reason: 'quiet_hours',
      })
    }
    for (const hour of [8, 12, 21]) {
      expect(gateReply(makeGateInput({ settings, now: localTime(hour) })), String(hour)).toEqual({
        act: true,
        mode: 'auto',
        reason: 'allowed',
      })
    }
  })

  it('lets the owner reply during quiet hours or turn the window off', () => {
    const permissive = settingsWithTarget({
      monitor: { quietHours: { enabled: true, start: '22:00', end: '08:00' }, replyDuringQuiet: true },
    })
    expect(gateReply(makeGateInput({ settings: permissive, now: localTime(23) }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })

    const disabled = settingsWithTarget({
      monitor: { quietHours: { enabled: false, start: '22:00', end: '08:00' } },
    })
    expect(gateReply(makeGateInput({ settings: disabled, now: localTime(23) }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
  })

  it('downgrades to review when automatic replies are off', () => {
    const settings = settingsWithTarget({ reply: { autoReply: false } })
    expect(gateReply(makeGateInput({ settings }))).toEqual({ act: true, mode: 'review', reason: 'auto_reply_off' })
  })

  it('downgrades to review at the hourly cap and inside the minimum gap', () => {
    const settings = settingsWithTarget({ reply: { maxPerConversationPerHour: 3, minGapSeconds: 8 } })
    expect(gateReply(makeGateInput({ settings, counters: { hour: 3 } }))).toEqual({
      act: true,
      mode: 'review',
      reason: 'rate_limited',
    })
    expect(gateReply(makeGateInput({ settings, counters: { gapMs: 7_999 } }))).toEqual({
      act: true,
      mode: 'review',
      reason: 'min_gap',
    })
    expect(gateReply(makeGateInput({ settings, counters: { gapMs: 8_000 } }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
  })

  it('stops a conversation after three assistant messages in a row', () => {
    expect(gateReply(makeGateInput({ loop: { consecutiveAiReplies: 2 } }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
    expect(gateReply(makeGateInput({ loop: { consecutiveAiReplies: 3 } }))).toEqual({
      act: false,
      reason: 'loop_guard',
    })
  })

  it('reports the most authoritative reason when several rules would fire', () => {
    const settings = settingsWithTarget({
      reply: { blockedSenders: ['小明'], autoReply: false },
      monitor: { quietHours: { enabled: true, start: '22:00', end: '08:00' } },
    })
    expect(gateReply(makeGateInput({ settings, now: localTime(23) }))).toEqual({
      act: false,
      reason: 'sender_blocked',
    })
  })
})

describe('isQuietHour', () => {
  it('handles windows that do not cross midnight', () => {
    expect(isQuietHour(9, '09:00', '17:00')).toBe(true)
    expect(isQuietHour(8, '09:00', '17:00')).toBe(false)
    expect(isQuietHour(17, '09:00', '17:00')).toBe(false)
  })

  it('handles windows that cross midnight', () => {
    expect(isQuietHour(23, '22:00', '08:00')).toBe(true)
    expect(isQuietHour(0, '22:00', '08:00')).toBe(true)
    expect(isQuietHour(7, '22:00', '08:00')).toBe(true)
    expect(isQuietHour(8, '22:00', '08:00')).toBe(false)
    expect(isQuietHour(21, '22:00', '08:00')).toBe(false)
  })

  it('treats equal ends as a disabled window and a bad time as the default', () => {
    expect(isQuietHour(22, '22:00', '22:00')).toBe(false)
    expect(isQuietHour(22, 'not-a-time', '08:00')).toBe(true)
  })
})

describe('target rows', () => {
  it('matches a target by its exact id, not by kind alone', () => {
    const settings = settingsWithTarget({}, { id: 'group-42', kind: 'group' })
    expect(gateReply(makeGateInput({ settings, thread: { targetId: 'group-42', kind: 'group' } }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
    expect(makeTarget({ id: 'group-42' }).id).toBe('group-42')
  })
})
