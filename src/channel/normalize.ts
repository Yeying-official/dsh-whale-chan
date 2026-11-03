/**
 * Turn one raw NDJSON line from `dws event consume --flatten` into the core
 * `InboundMessage`, or into an explicit skip reason.
 *
 * The decoder is deliberately tolerant about field names (dws has shipped both
 * snake_case and camelCase spellings) and deliberately strict about identity:
 * a line without a stable message id, a sender or a resolvable conversation is
 * rejected rather than guessed. Unknown top-level fields never reach a log; the
 * debug summary exposes their *names* only.
 */
import type { InboundMessage } from '../core/model.ts'
import type { DwsTarget, SkipReason } from './types.ts'
import { redact, truncate } from './log.ts'

/** A raw line that must not become an event. */
export interface NormalizeSkip {
  readonly skip: SkipReason
  readonly detail?: string
}

export type NormalizeResult = InboundMessage | NormalizeSkip

export interface NormalizeContext {
  /** The authorized account; used for self-detection and mention matching. */
  readonly ownerUserId: string
  /** Display name used for the `@nick` fallback; optional. */
  readonly ownerNick?: string
  readonly target: DwsTarget
  /** Skip `@所有人` broadcasts; defaults to `true`. */
  readonly ignoreBroadcast?: boolean
  readonly now?: () => Date
  /** Hard ceiling for one message body; defaults to 20 000 characters. */
  readonly maxTextChars?: number
}

/** Maximum body length kept from one event. */
export const DEFAULT_MAX_TEXT_CHARS = 20_000

/** Shallow envelopes dws may wrap the flattened fields in. */
const WRAPPERS = ['data', 'event', 'message', 'payload'] as const

// T3 captured the flattened shape: all snake_case, and `event_id` is the event
// id, not the message id. `message_id` must win when both are present.
const MSG_ID_FIELDS = ['message_id', 'msgId', 'messageId', 'msg_id', 'eventId', 'event_id'] as const
const CONVERSATION_FIELDS = ['conversation_id', 'conversationId', 'openConversationId', 'chatId', 'chat_id'] as const
const CONVERSATION_TYPE_FIELDS = ['conversationType', 'conversation_type', 'chatType'] as const
// Group flatten carries no staff id; `sender_open_dingtalk_id` is the only
// sender identity there, so it is the fallback rather than a separate field.
const SENDER_STAFF_FIELDS = [
  'sender_staff_id',
  'senderStaffId',
  'senderId',
  'sender_id',
  'userId',
  'sender_user_id',
  'sender_userid',
] as const
const SENDER_NICK_FIELDS = ['senderNick', 'senderName', 'sender_name', 'nick', 'sender'] as const
const SENDER_OPEN_FIELDS = ['sender_open_dingtalk_id', 'senderOpenDingTalkId', 'openDingTalkId'] as const
const TEXT_FIELDS = ['text', 'content', 'messageText', 'body', 'msgContent'] as const
const TIME_FIELDS = [
  'event_time',
  'eventTime',
  'timestamp',
  'create_time',
  'createTime',
  'createAt',
  'createdAt',
  'msgTimestamp',
] as const
const MENTION_FIELDS = ['atUsers', 'mentions', 'atUsersList', 'mentionedUsers', 'at_users'] as const
const TITLE_FIELDS = ['conversationTitle', 'chatName', 'groupName', 'title', 'conversation_title'] as const
const MEDIA_FIELDS = [
  'downloadCode',
  'pictureDownloadCode',
  'imageDownloadCodes',
  'fileId',
  'mediaId',
  'richText',
  'image',
] as const
const TYPE_FIELDS = ['eventType', 'msgtype', 'msgType', 'messageType', 'event_type'] as const

/** Event types the channel does not turn into messages. */
const UNSUPPORTED_TYPES = new Set([
  'recall',
  'revoke',
  'revoked',
  'system',
  'event',
  'conversation_change',
  'member_change',
  'member_join',
  'member_leave',
  'reaction',
  'read',
  'read_receipt',
  'typing',
  'chat_update',
])

/** Message types that carry media; dws spells them in several ways. */
const MEDIA_TYPES = new Set(['image', 'picture', 'file', 'audio', 'voice', 'video', 'richText', 'richtext'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Find the first alias, descending into known envelopes at most twice. */
function search(record: Record<string, unknown>, aliases: readonly string[], depth = 0): unknown {
  for (const alias of aliases) {
    const value = record[alias]
    if (value !== undefined && value !== null) return value
  }
  if (depth >= 2) return undefined
  for (const wrapper of WRAPPERS) {
    const nested = record[wrapper]
    if (isRecord(nested)) {
      const found = search(nested, aliases, depth + 1)
      if (found !== undefined && found !== null) return found
    }
  }
  return undefined
}

function readScalar(record: Record<string, unknown>, aliases: readonly string[]): string | undefined {
  const value = search(record, aliases)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** Read a possibly nested text body: `text`, `content`, `content.text`, `text.content`. */
function readText(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || depth > 3) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['text', 'content', 'message', 'body']) {
    const nested = record[key]
    if (typeof nested === 'string') return nested
    if (isRecord(nested)) {
      const deeper = readText(nested, depth + 1)
      if (deeper !== undefined) return deeper
    }
  }
  return undefined
}

/** ISO time from epoch seconds, epoch milliseconds or a parseable date string. */
export function toIsoTime(value: unknown): string | undefined {
  let millis: number | undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    millis = value < 1e11 ? value * 1_000 : value
  } else if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed)
      millis = trimmed.length <= 10 ? numeric * 1_000 : numeric
    } else {
      const parsed = Date.parse(trimmed)
      if (!Number.isNaN(parsed)) millis = parsed
    }
  }
  if (millis === undefined) return undefined
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** The conversation shape dws reports, reduced to the two the domain knows. */
export function toConversationType(value: string | undefined): 'group' | 'direct' | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase()
  if (['direct', 'p2p', 'single', '1', 'one-to-one', 'one_to_one'].includes(normalized)) return 'direct'
  if (['group', '2', 'chat', 'groupchat', 'group_chat'].includes(normalized)) return 'group'
  return undefined
}

function mentionTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tokens: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') {
      tokens.push(item.trim())
      continue
    }
    if (!isRecord(item)) continue
    if (item.type === 'all' || item.isAll === true) tokens.push('@all')
    for (const key of ['userId', 'staffId', 'openDingTalkId', 'user', 'id', 'name', 'nick', 'displayName']) {
      const candidate = item[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        tokens.push(candidate.trim())
        break
      }
    }
  }
  return tokens
}

/** Mentions in the flattened shape exist only inside the plain-text body. */
function mentionsFromText(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(/@([^\s@]{1,32})/g)) {
    const token = match[1]
    if (token !== undefined && token.trim() !== '') tokens.push(token.trim())
  }
  return tokens
}

function isBroadcastToken(token: string): boolean {
  const normalized = token.trim().toLowerCase().replace(/^@/, '')
  return normalized === 'all' || normalized === 'everyone' || normalized === '所有人' || token.includes('所有人')
}

function hasMedia(record: Record<string, unknown>, msgtype: string | undefined): boolean {
  if (msgtype && MEDIA_TYPES.has(msgtype)) return true
  return MEDIA_FIELDS.some((field) => search(record, [field]) !== undefined)
}

function unsupportedType(record: Record<string, unknown>): string | undefined {
  for (const field of TYPE_FIELDS) {
    const value = readScalar(record, [field])
    if (value && UNSUPPORTED_TYPES.has(value.toLowerCase())) return value.toLowerCase()
  }
  if (search(record, ['recallAt', 'revokeAt', 'isRecall']) !== undefined) return 'recall'
  return undefined
}

/**
 * Normalize one parsed line.
 *
 * Skip order is fixed: unsupported → malformed → self → broadcast → media-only
 * → empty. The first two reject the line's shape; the rest describe a real
 * message the assistant must not answer.
 */
export function normalizeEvent(raw: unknown, context: NormalizeContext): NormalizeResult {
  if (!isRecord(raw)) return { skip: 'malformed', detail: 'not-an-object' }

  const unsupported = unsupportedType(raw)
  if (unsupported) return { skip: 'unsupported', detail: unsupported }

  const msgId = readScalar(raw, MSG_ID_FIELDS)
  if (!msgId) return { skip: 'malformed', detail: 'missing-msg-id' }

  const senderOpenId = readScalar(raw, SENDER_OPEN_FIELDS)
  const senderUserId = readScalar(raw, SENDER_STAFF_FIELDS) ?? senderOpenId
  if (!senderUserId) return { skip: 'malformed', detail: 'missing-sender' }
  const senderNick = readScalar(raw, SENDER_NICK_FIELDS) ?? ''

  const conversationField = readScalar(raw, CONVERSATION_FIELDS)
  const declaredType = toConversationType(readScalar(raw, CONVERSATION_TYPE_FIELDS))
  // The flattened event has no conversationType; the subscribed target decides.
  const conversationType = declaredType ?? (context.target.kind === 'dm' ? 'direct' : 'group')
  const conversationId = conversationField ?? (conversationType === 'direct' ? senderUserId : undefined)
  if (!conversationId) return { skip: 'malformed', detail: 'missing-conversation' }

  // Group events do not carry the owner's staff id, so a matching open id is the
  // primary self-check; a matching display name is the second signal.
  const selfById =
    context.ownerUserId !== '' && (senderUserId === context.ownerUserId || senderOpenId === context.ownerUserId)
  const ownerNick = context.ownerNick?.trim()
  const selfByNick = ownerNick !== undefined && ownerNick !== '' && senderNick === ownerNick
  if (selfById || selfByNick) return { skip: 'self', detail: 'sender-is-owner' }

  const rawText = readText(search(raw, TEXT_FIELDS))
  const text = rawText ?? ''
  const media = hasMedia(raw, readScalar(raw, ['msgtype', 'msgType', 'messageType'])?.toLowerCase())
  const structuredMentions = mentionTokens(search(raw, MENTION_FIELDS))
  const textMentions = mentionsFromText(text)
  const mentions = [...new Set([...structuredMentions, ...textMentions])]

  // Group addressing is text-only: the flattened shape has no atUsers, and a
  // bare '@' is not proof. Without the owner's display name a group message is
  // never addressed.
  let addressed: boolean
  if (context.target.kind === 'at-me' || context.target.kind === 'dm') {
    addressed = true
  } else {
    addressed = ownerNick !== undefined && ownerNick !== '' && (text.includes(`@${ownerNick}`) || text.includes('@我'))
  }

  const broadcastMention = mentions.some(isBroadcastToken) || text.includes('@所有人')
  const ignoreBroadcast = context.ignoreBroadcast !== false
  if (broadcastMention && !addressed && ignoreBroadcast) {
    return { skip: 'broadcast', detail: 'broadcast-mention' }
  }

  if (text.trim() === '') {
    // v1 does not answer a media-only event: the core message has no attachment
    // slot, and replying to an image with no caption is not useful.
    if (media) return { skip: 'unsupported', detail: 'media-only' }
    return { skip: 'empty', detail: 'empty-text' }
  }

  const now = context.now?.() ?? new Date()
  const receivedAt = now.toISOString()
  const maxTextChars = context.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
  const boundedText = text.length > maxTextChars ? text.slice(0, maxTextChars) : text
  // The flattened event carries no title; the configured target label keeps the
  // thread named after the group instead of falling back to its id.
  const title = readScalar(raw, TITLE_FIELDS) ?? context.target.label?.trim()
  const at = toIsoTime(search(raw, TIME_FIELDS)) ?? receivedAt
  const threadKey = conversationType === 'direct' ? `dm:${senderUserId}` : `group:${conversationId}`

  return {
    id: msgId,
    targetId: context.target.id,
    threadKey,
    kind: context.target.kind,
    conversationId,
    conversationType,
    ...(title ? { title } : {}),
    sender: {
      userId: senderUserId,
      ...(senderOpenId ? { openDingTalkId: senderOpenId } : {}),
      nick: senderNick,
    },
    text: boundedText,
    addressed,
    at,
    receivedAt,
    mentions: mentions.slice(0, 50),
  }
}

/** Top-level field names and a value summary for a whitelisted, non-identifying subset. */
export interface RawEventSummary {
  readonly keys: readonly string[]
  readonly fields: Readonly<Record<string, string>>
}

/**
 * The debug view of one raw event.
 *
 * Field names are listed (they are schema hints), values are limited to a
 * structural whitelist — no ids, no sender, no body — then redacted and
 * truncated.
 */
const DEBUG_VALUE_FIELDS = [
  'eventType',
  'msgtype',
  'msgType',
  'conversationType',
  'createAt',
  'createTime',
  'timestamp',
  'title',
  'conversationTitle',
] as const

export function summarizeRawEvent(raw: unknown, maxValueChars = 120): RawEventSummary {
  const record = isRecord(raw) ? raw : {}
  const keys = Object.keys(record).slice(0, 40)
  const fields: Record<string, string> = {}
  for (const field of DEBUG_VALUE_FIELDS) {
    const value = search(record, [field])
    if (value === undefined) continue
    if (typeof value === 'string') fields[field] = truncate(redact(value), maxValueChars)
    else if (typeof value === 'number' && Number.isFinite(value)) fields[field] = String(value)
    else if (typeof value === 'boolean') fields[field] = String(value)
    else if (Array.isArray(value)) fields[field] = `[${value.length} items]`
    else if (isRecord(value)) fields[field] = `{keys:${Object.keys(value).slice(0, 8).join(',')}}`
  }
  return { keys, fields }
}
