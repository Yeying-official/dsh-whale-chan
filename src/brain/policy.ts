/**
 * Decides whether one message may be answered, and whether the answer may be
 * sent automatically or only offered for review.
 *
 * This is a pure function: it reads the settings the caller passes, the instant
 * the caller injects and the counters the caller already read. It performs no
 * I/O, starts no timer and never sends anything. The same input always produces
 * the same decision, which is what makes the matrix in
 * `docs/002-authorization.md` testable.
 *
 * Precedence is deliberate:
 *
 * 1. a hard off (monitoring, target, sender, addressing, broadcast, loop) wins
 *    over everything, because drafting for it would be wasted work;
 * 2. a soft limit then downgrades to `review` (quiet hours, auto reply off,
 *    conversation rate, minimum gap);
 * 3. the target's own `replyMode` can still tighten the result, never loosen it.
 *
 * The gate decides replies only. It grants no task authority: capturing a task
 * still ends in `awaiting-approval`, and a person approves it in the panel.
 */
import type { Settings, TargetRow } from '../shared/settings.ts'
import { consecutiveCap } from './loop-guard.ts'
import type { GateDecision, GateInput, GateReason } from './types.ts'

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/u

function parseHour(value: string, fallback: number): number {
  const match = TIME_OF_DAY.exec(value.trim())
  return match ? Number(match[1]) : fallback
}

/**
 * Whether `hour` (0–23, local time) falls in `[start, end)`.
 *
 * A window whose start is after its end crosses midnight (22:00–08:00 covers
 * 22 and 23 and 0–7). A window with equal ends covers nothing, which is how an
 * operator disables it without turning the switch off.
 */
export function isQuietHour(hour: number, start: string, end: string): boolean {
  const from = parseHour(start, 22)
  const to = parseHour(end, 8)
  if (from === to) return false
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

function matchesSender(list: readonly string[], senderId: string, senderName: string): boolean {
  const id = senderId.trim()
  const name = senderName.trim().toLowerCase()
  return list.some((entry) => {
    const value = entry.trim()
    if (value.length === 0) return false
    return value === id || value.toLowerCase() === name
  })
}

function findTarget(input: GateInput): TargetRow | undefined {
  return input.settings.targets.rows.find((row) => row.id === input.thread.targetId)
}

function deny(reason: GateReason): GateDecision {
  return { act: false, reason }
}

function review(reason: GateReason): GateDecision {
  return { act: true, mode: 'review', reason }
}

/** Gate one message. See the module comment for the precedence rules. */
export function gateReply(input: GateInput): GateDecision {
  const { settings, message, counters, loop } = input

  // 1. Hard offs, cheapest and most authoritative first.
  if (!settings.monitor.enabled) return deny('monitor_disabled')
  if (settings.monitor.paused) return deny('monitor_paused')

  const target = findTarget(input)
  if (!target) return deny('target_missing')
  if (!target.enabled) return deny('target_disabled')
  if (target.replyMode === 'off') return deny('target_off')

  if (matchesSender(settings.reply.blockedSenders, message.senderId, message.senderName)) {
    return deny('sender_blocked')
  }
  const allowed = settings.reply.allowedSenders
  if (allowed.length > 0 && !matchesSender(allowed, message.senderId, message.senderName)) {
    return deny('sender_not_allowed')
  }

  if (message.conversationType === 'group' && settings.reply.requireMentionInGroups && !message.addressed) {
    return deny('not_addressed')
  }
  if (settings.reply.ignoreBroadcast && message.broadcast) return deny('broadcast')
  if (consecutiveCap(loop.consecutiveAiReplies)) return deny('loop_guard')

  // 2. Soft limits downgrade to review; nothing leaves the machine.
  const quiet = settings.monitor.quietHours
  if (
    quiet.enabled &&
    !settings.monitor.replyDuringQuiet &&
    isQuietHour(input.now.getHours(), quiet.start, quiet.end)
  ) {
    return review('quiet_hours')
  }
  if (!settings.reply.autoReply) return review('auto_reply_off')
  if (counters.hour >= settings.reply.maxPerConversationPerHour) return review('rate_limited')
  if (counters.gapMs < settings.reply.minGapSeconds * 1000) return review('min_gap')

  // 3. The target may still tighten an automatic reply, never loosen an off.
  if (target.replyMode === 'review') return review('target_review')

  return { act: true, mode: 'auto', reason: 'allowed' }
}
