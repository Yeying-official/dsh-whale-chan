/**
 * Keeps the assistant from talking to itself.
 *
 * With a personal `dws` authorization the assistant posts as the owner, so its
 * own message can come back through the next poll as a brand new inbound
 * message. Replying to that echo produces another echo, and a two-message loop
 * can run all night. Three independent checks cover it:
 *
 * - `isSelf` drops a message the owner's own account produced;
 * - `isEcho` drops a message whose body is one of the recent outbound texts,
 *   even when it is wrapped in a quote;
 * - `consecutiveCap` stops the conversation once three assistant messages in a
 *   row went unanswered, which also covers an echo that was edited slightly.
 *
 * Nothing here reads state: the caller passes the recent outbound texts and the
 * current streak, so the decision is reproducible and the streak survives a
 * restart.
 */
import { normalizeWhitespace } from './format.ts'

/** Assistant messages in a row without a human answer before the thread is left alone. */
export const LOOP_CONSECUTIVE_CAP = 3

/** Shortest outbound body that can be recognised inside a longer message. */
const CONTAINMENT_MIN_CHARS = 8

/** The sender fields the loop guard compares. */
export interface LoopSender {
  readonly userId?: string
  readonly nick?: string
}

/** The owner's identity, as settings and the channel report it. */
export interface LoopOwner {
  readonly userId?: string
  /** Names the owner posts under; the channel may report either the id or the nick. */
  readonly nicks?: readonly string[]
}

function sameName(left: string | undefined, right: string | undefined): boolean {
  const a = (left ?? '').trim().toLowerCase()
  const b = (right ?? '').trim().toLowerCase()
  return a.length > 0 && a === b
}

/** Whether this message was produced by the owner's own account. */
export function isSelf(sender: LoopSender, owner: LoopOwner): boolean {
  const ownerId = (owner.userId ?? '').trim()
  const senderId = (sender.userId ?? '').trim()
  if (ownerId.length > 0 && senderId === ownerId) return true
  const nicks = owner.nicks ?? []
  return nicks.some((nick) => sameName(nick, sender.nick))
}

/**
 * Comparison form for echo detection: NFKC, all whitespace removed, lowercased.
 *
 * Whitespace is removed rather than collapsed because DingTalk re-wraps long
 * messages, and a wrapped copy is still the same message.
 */
export function normalizeForEcho(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
}

/** Drop quote markers (`>`, `|`, a `引用：` label) so an echo can be compared with what was sent. */
export function stripQuotePrefix(text: string): string {
  return text
    .replace(/^\s*[>|]+\s*/gmu, '')
    .replace(/^\s*(?:引用|回复|quoted|re)\s*[：:]\s*/iu, '')
    .trim()
}

/**
 * Whether `text` repeats something the assistant recently sent.
 *
 * A reply may legitimately be quoted by the next message ("她刚才说的那句…"),
 * so the check compares the whole body, the body with quote markers removed, and
 * each quoted line on its own. A long outbound text is also accepted when it is
 * embedded in a longer message. Short outbound texts are only matched whole,
 * because "好的" appears everywhere.
 */
export function isEcho(text: string, recentOutbound: readonly string[]): boolean {
  const incoming = normalizeForEcho(text)
  if (incoming.length === 0) return false
  const withoutQuote = normalizeForEcho(stripQuotePrefix(text))
  const lines = text
    .split('\n')
    .map((line) => normalizeForEcho(line.replace(/^\s*[>|]+\s*/u, '')))
    .filter((line) => line.length > 0)
  for (const outbound of recentOutbound) {
    const sent = normalizeForEcho(outbound)
    if (sent.length === 0) continue
    if (incoming === sent || withoutQuote === sent) return true
    if (lines.includes(sent)) return true
    if ([...sent].length >= CONTAINMENT_MIN_CHARS && incoming.includes(sent)) return true
  }
  return false
}

/** Whether the streak reached the cap; the gate turns this into an `off` decision. */
export function consecutiveCap(count: number, cap: number = LOOP_CONSECUTIVE_CAP): boolean {
  return !Number.isNaN(count) && count >= cap
}
