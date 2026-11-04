import { describe, expect, it } from 'vitest'
import { gateReply, isQuietHour } from '../src/brain/policy.ts'
import type { GateInput } from '../src/brain/types.ts'
import type { Settings } from '../src/shared/settings.ts'
import { makeGateInput, makeSettings, makeTarget, localTime, settingsWithTarget } from './fixtures/brain.ts'

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

  it('honours the sender allow list and block list by user id', () => {
    const blocked = settingsWithTarget({ reply: { blockedSenders: ['user-1'] } })
    expect(gateReply(makeGateInput({ settings: blocked }))).toEqual({ act: false, reason: 'sender_blocked' })

    const allowedOther = settingsWithTarget({ reply: { allowedSenders: ['user-2'] } })
    expect(gateReply(makeGateInput({ settings: allowedOther }))).toEqual({
      act: false,
      reason: 'sender_not_allowed',
    })

    const allowed = settingsWithTarget({ reply: { allowedSenders: [' user-1 '] } })
    expect(gateReply(makeGateInput({ settings: allowed }))).toEqual({ act: true, mode: 'auto', reason: 'allowed' })
  })

  it('never authorizes by display name, so a rename cannot borrow an identity', () => {
    // The same display name as the allow-listed person, but a different user id.
    const allowed = settingsWithTarget({ reply: { allowedSenders: ['user-1'] } })
    const impostor = makeGateInput({
      settings: allowed,
      message: { senderId: 'user-9', senderName: '小明' },
    })
    expect(gateReply(impostor)).toEqual({ act: false, reason: 'sender_not_allowed' })

    // A name in the block list is not an id either: it matches nobody.
    const blockedByName = settingsWithTarget({ reply: { blockedSenders: ['小明'] } })
    expect(gateReply(makeGateInput({ settings: blockedByName }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
  })

  it('requires a mention in groups unless the owner turned that off', () => {
    const settings = settingsWithTarget()
    const unaddressed = makeGateInput({ settings, message: { kind: 'group', conversationType: 'group' } })
    expect(gateReply(unaddressed)).toEqual({ act: false, reason: 'not_addressed' })

    const addressed = makeGateInput({
      settings,
      message: { kind: 'group', conversationType: 'group', addressed: true },
    })
    expect(gateReply(addressed)).toEqual({ act: true, mode: 'auto', reason: 'allowed' })

    const lenient = settingsWithTarget({ reply: { requireMentionInGroups: false } }, { mentionOnly: false })
    expect(
      gateReply(makeGateInput({ settings: lenient, message: { kind: 'group', conversationType: 'group' } })),
    ).toEqual({
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

  it('keeps a quiet-hours reply at review so nothing can be queued automatically', () => {
    const settings = settingsWithTarget({
      monitor: { quietHours: { enabled: true, start: '22:00', end: '08:00' } },
    })
    // `review` carries no send authority: the caller may only store a draft, and
    // the owner decides in the panel whether to send it. Quiet hours ending later
    // cannot turn this decision into an `auto` send, because the gate does not run
    // again for a message that was already decided.
    for (const hour of [22, 23, 0, 3, 7]) {
      expect(gateReply(makeGateInput({ settings, now: localTime(hour) })), String(hour)).toStrictEqual({
        act: true,
        mode: 'review',
        reason: 'quiet_hours',
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
      reply: { blockedSenders: ['user-1'], autoReply: false },
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

describe('group addressing and target selection', () => {
  function groupInput(settings: Settings, addressed = false): GateInput {
    return makeGateInput({
      settings,
      thread: { key: 'group:cid-1', targetId: 'target-1', kind: 'group' },
      message: { kind: 'group', conversationType: 'group', addressed },
    })
  }

  it('uses the conversation row instead of the at-me row for a group thread', () => {
    const settings = makeSettings({
      targets: {
        rows: [
          makeTarget({ kind: 'group', id: 'cid-1' }),
          makeTarget({ kind: 'at-me', id: 'at-me-1', enabled: false }),
        ],
      },
    })
    // The at-me subscription created the thread; the group message that follows
    // must be governed by the conversation's own row, not by that at-me row.
    const input = makeGateInput({
      settings,
      thread: { key: 'group:cid-1', targetId: 'at-me-1', kind: 'at-me' },
      message: { kind: 'group', conversationType: 'group' },
    })
    // The at-me row would answer `target_disabled`; the group row is what
    // governs the conversation, so its mention requirement fires first.
    expect(gateReply(input)).toEqual({ act: false, reason: 'not_addressed' })
    expect(gateReply({ ...input, message: { ...input.message, addressed: true } })).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
  })

  it('keeps an at-me message on the at-me row when the group row is disabled', () => {
    const settings = makeSettings({
      targets: {
        rows: [
          makeTarget({ kind: 'at-me', id: 'at-me-1', enabled: true }),
          makeTarget({ kind: 'group', id: 'cid-1', enabled: false }),
        ],
      },
    })
    // The owner enabled the at-me subscription and disabled the group one: a
    // mention must still be answered.
    expect(
      gateReply(
        makeGateInput({
          settings,
          thread: { key: 'group:cid-1', targetId: 'at-me-1', kind: 'at-me' },
          message: { kind: 'at-me', conversationType: 'group', addressed: true },
        }),
      ),
    ).toEqual({ act: true, mode: 'auto', reason: 'allowed' })
  })

  it('lets a disabled at-me row refuse a mention even when the group row is enabled', () => {
    const settings = makeSettings({
      targets: {
        rows: [
          makeTarget({ kind: 'at-me', id: 'at-me-1', enabled: false }),
          makeTarget({ kind: 'group', id: 'cid-1' }),
        ],
      },
    })
    expect(
      gateReply(
        makeGateInput({
          settings,
          thread: { key: 'group:cid-1', targetId: 'at-me-1', kind: 'at-me' },
          message: { kind: 'at-me', conversationType: 'group', addressed: true },
        }),
      ),
    ).toEqual({ act: false, reason: 'target_disabled' })
  })

  it('falls back to the conversation row for a mention when no at-me row exists', () => {
    const settings = makeSettings({
      targets: { rows: [makeTarget({ kind: 'group', id: 'cid-1', enabled: false })] },
    })
    expect(
      gateReply(
        makeGateInput({
          settings,
          thread: { key: 'group:cid-1', targetId: 'at-me-1', kind: 'at-me' },
          message: { kind: 'at-me', conversationType: 'group', addressed: true },
        }),
      ),
    ).toEqual({ act: false, reason: 'target_disabled' })
  })

  it('falls back to the row that created the thread when no group row matches', () => {
    const settings = makeSettings({
      targets: { rows: [makeTarget({ kind: 'at-me', id: 'at-me-1', enabled: false })] },
    })
    expect(
      gateReply(
        makeGateInput({
          settings,
          thread: { key: 'group:cid-1', targetId: 'at-me-1', kind: 'at-me' },
          message: { kind: 'group', conversationType: 'group', addressed: true },
        }),
      ),
    ).toEqual({ act: false, reason: 'target_disabled' })
  })

  it('requires a mention when either the target or the global switch asks for one', () => {
    const groupRow = makeTarget({ kind: 'group', id: 'cid-1', mentionOnly: false })
    const globalOn = makeSettings({
      targets: { rows: [groupRow] },
      reply: { requireMentionInGroups: true },
    })
    expect(gateReply(groupInput(globalOn))).toEqual({ act: false, reason: 'not_addressed' })

    const bothOff = makeSettings({
      targets: { rows: [groupRow] },
      reply: { requireMentionInGroups: false },
    })
    expect(gateReply(groupInput(bothOff))).toEqual({ act: true, mode: 'auto', reason: 'allowed' })

    // A target that turns its own switch on still requires the mention even
    // when the global default is off.
    const targetOn = makeSettings({
      targets: { rows: [makeTarget({ kind: 'group', id: 'cid-1', mentionOnly: true })] },
      reply: { requireMentionInGroups: false },
    })
    expect(gateReply(groupInput(targetOn))).toEqual({ act: false, reason: 'not_addressed' })
  })

  it('does not apply group addressing to a direct message', () => {
    const settings = makeSettings({
      targets: { rows: [makeTarget({ kind: 'dm', id: 'target-1', mentionOnly: true })] },
    })
    expect(gateReply(makeGateInput({ settings, message: { conversationType: 'direct', addressed: false } }))).toEqual({
      act: true,
      mode: 'auto',
      reason: 'allowed',
    })
  })
})
