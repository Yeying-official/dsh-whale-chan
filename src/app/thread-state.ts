/**
 * App-layer reads that turn stored domain rows into the shapes the brain and
 * the outbox need.
 *
 * They live here, not in a repository, because they are read-only projections
 * over columns the domain already owns: the recent outbound texts for the loop
 * guard, the consecutive-reply streak, a thread's delivery target and the
 * bounded conversation window. Nothing here writes.
 */
import type { InboundMessage, OutboundTarget, Thread } from '../core/index.ts'
import type { BrainMessage, ThreadWindow } from '../brain/index.ts'
import type { Store } from './store.ts'

/** Default number of recent messages handed to a classifier or replier. */
export const THREAD_WINDOW_SIZE = 20

/** The newest inbound message of a thread, or undefined before its first one. */
export function latestMessage(store: Store, threadKey: string): InboundMessage | undefined {
  return store.read.threadMessages(threadKey, { limit: 1 }).items.at(-1)
}

/** The two identities a direct peer may be known by. */
interface PeerRefs {
  readonly userId: string
  readonly openId: string
}

/**
 * The peer's user id and open id for one conversation.
 *
 * A one-to-one event may carry only `sender_open_dingtalk_id`, in which case
 * the channel also copies it into `userId`. Keeping both lets the send path use
 * the open-id flag and lets the loop-guard queries match either spelling.
 */
function peerRefs(thread: Thread, message: InboundMessage | undefined): PeerRefs {
  return {
    userId: (thread.peer?.userId ?? message?.sender.userId ?? '').trim(),
    openId: (thread.peer?.openDingTalkId ?? message?.sender.openDingTalkId ?? '').trim(),
  }
}

function conversationOf(thread: Thread, message: InboundMessage | undefined): string {
  return message?.conversationId ?? conversationFromKey(thread.key)
}

/**
 * The three `peer_user_id` values a stored outbound row may hold.
 *
 * Replies queued before the open-id fix stored the bare open id; afterwards
 * they store `open:<open id>`. The SQL keeps exactly three placeholders so its
 * shape is stable, and a repeated value only narrows the `IN` list.
 */
function peerColumns(refs: PeerRefs): readonly [string, string, string] {
  const values = [
    ...new Set([refs.userId, refs.openId, refs.openId === '' ? '' : `open:${refs.openId}`].filter((v) => v !== '')),
  ]
  const [first = '', second = first, third = second] = values
  return [first, second, third]
}

/** Recover a conversation id from a normalized thread key; empty when unknowable. */
export function conversationFromKey(threadKey: string): string {
  for (const prefix of ['group:', 'dm:'] as const) {
    if (threadKey.startsWith(prefix)) return threadKey.slice(prefix.length)
  }
  return ''
}

/** Where a message queued on this thread must be delivered. */
export function threadTarget(thread: Thread, message?: InboundMessage): OutboundTarget | undefined {
  const conversation = conversationOf(thread, message)
  if (conversation.trim() === '') return undefined
  if (thread.kind === 'dm') {
    // A bare open id would be sent as `--user` and fail to resolve; the prefix
    // is the channel's contract for `--open-dingtalk-id`.
    const { userId, openId } = peerRefs(thread, message)
    const peer = openId === '' ? userId : `open:${openId}`
    return {
      kind: 'dm',
      conversationId: conversation,
      ...(peer === '' ? {} : { peerUserId: peer }),
    }
  }
  return { kind: thread.kind, conversationId: conversation }
}

/**
 * Recent outbound bodies of one conversation, newest first.
 *
 * The loop guard needs them to recognise its own message coming back through
 * the event stream. Every non-dropped, non-failed delivery counts: a `pending`
 * or `unknown` row may already have reached the chat, and treating it as
 * absent would create the echo the guard exists to stop.
 *
 * A direct-message row may have been stored under the bare user id, the bare
 * open id, or `open:<open id>`; matching all three keeps the guard working for
 * replies queued on either side of the open-id fix.
 */
export function recentOutboundTexts(store: Store, threadKey: string, limit = 20): string[] {
  const thread = store.threads.get(threadKey)
  if (!thread) return []
  const message = latestMessage(store, threadKey)
  const conversation = conversationOf(thread, message)
  if (conversation.trim() === '') return []
  const peers = peerColumns(peerRefs(thread, message))
  const rows = store.db
    .prepare(
      `SELECT text FROM outbound
       WHERE status IN ('sent', 'pending', 'unknown')
         AND (conversation_id = ? OR peer_user_id IN (?, ?, ?))
       ORDER BY rowid DESC LIMIT ?`,
    )
    .all(conversation, ...peers, Math.max(1, Math.floor(limit))) as readonly Record<string, unknown>[]
  return rows.map((row) => String(row['text'] ?? '')).filter((text) => text.length > 0)
}

/**
 * How many assistant messages went out since the last inbound message.
 *
 * The domain counts replies in total, but the loop guard needs the streak. A
 * person's message resets it, so the streak is exactly the sent follow-ups and
 * replies whose `sent_at` is later than the newest inbound message.
 */
export function consecutiveAiReplies(store: Store, threadKey: string): number {
  const thread = store.threads.get(threadKey)
  if (!thread) return 0
  const message = latestMessage(store, threadKey)
  if (!message) return 0
  const conversation = conversationOf(thread, message)
  if (conversation.trim() === '') return 0
  const peers = peerColumns(peerRefs(thread, message))
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM outbound
       WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at >= ?
         AND (conversation_id = ? OR peer_user_id IN (?, ?, ?))`,
    )
    .get(message.receivedAt, conversation, ...peers) as Record<string, unknown> | undefined
  return Number(row?.['n'] ?? 0)
}

/** Whether this message is a broadcast (@all / @所有人) rather than a person addressing the assistant. */
export function isBroadcast(message: InboundMessage): boolean {
  if (message.text.includes('@所有人')) return true
  return message.mentions.some((token) => {
    const normalized = token.trim().toLowerCase().replace(/^@/u, '')
    return normalized === 'all' || normalized === 'everyone' || normalized === '所有人'
  })
}

/** Map one domain message onto the brain's narrow message shape. */
export function toBrainMessage(message: InboundMessage): BrainMessage {
  return {
    id: message.id,
    text: message.text,
    senderId: message.sender.userId,
    senderName: message.sender.nick,
    kind: message.kind,
    conversationType: message.conversationType,
    addressed: message.addressed,
    broadcast: isBroadcast(message),
    at: message.at,
  }
}

/** Bounded recent history of one thread, oldest first. */
export function threadWindow(
  store: Store,
  threadKey: string,
  ownerUserId: string,
  limit = THREAD_WINDOW_SIZE,
): ThreadWindow {
  const messages = store.read.threadMessages(threadKey, { limit: Math.max(1, Math.floor(limit)) }).items
  return messages.map((message) => ({
    author: message.sender.nick,
    text: message.text,
    at: message.at,
    self: ownerUserId !== '' && message.sender.userId === ownerUserId,
  }))
}
