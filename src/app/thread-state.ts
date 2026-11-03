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

function conversationColumns(
  thread: Thread,
  message: InboundMessage | undefined,
): { conversation: string; peer: string } {
  return {
    conversation: message?.conversationId ?? conversationFromKey(thread.key),
    peer: thread.peer?.userId ?? message?.sender.userId ?? '',
  }
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
  const columns = conversationColumns(thread, message)
  if (columns.conversation.trim() === '') return undefined
  if (thread.kind === 'dm') {
    return {
      kind: 'dm',
      conversationId: columns.conversation,
      ...(columns.peer.trim() === '' ? {} : { peerUserId: columns.peer }),
    }
  }
  return { kind: thread.kind, conversationId: columns.conversation }
}

/**
 * Recent outbound bodies of one conversation, newest first.
 *
 * The loop guard needs them to recognise its own message coming back through
 * the event stream. Every non-dropped, non-failed delivery counts: a `pending`
 * or `unknown` row may already have reached the chat, and treating it as
 * absent would create the echo the guard exists to stop.
 */
export function recentOutboundTexts(store: Store, threadKey: string, limit = 20): string[] {
  const thread = store.threads.get(threadKey)
  if (!thread) return []
  const message = latestMessage(store, threadKey)
  const columns = conversationColumns(thread, message)
  if (columns.conversation.trim() === '') return []
  const rows = store.db
    .prepare(
      `SELECT text FROM outbound
       WHERE status IN ('sent', 'pending', 'unknown')
         AND (conversation_id = ? OR peer_user_id = ?)
       ORDER BY rowid DESC LIMIT ?`,
    )
    .all(columns.conversation, columns.peer, Math.max(1, Math.floor(limit))) as readonly Record<string, unknown>[]
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
  const columns = conversationColumns(thread, message)
  if (columns.conversation.trim() === '') return 0
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM outbound
       WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at >= ?
         AND (conversation_id = ? OR peer_user_id = ?)`,
    )
    .get(message.receivedAt, columns.conversation, columns.peer) as Record<string, unknown> | undefined
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
