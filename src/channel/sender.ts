/**
 * The one outbound path of the channel.
 *
 * A send carries an explicit idempotency key and asks dws to wait for delivery,
 * so one key maps to at most one external message. The result vocabulary is
 * intentionally conservative:
 *
 * - `sent`    — dws returned a receipt that confirms delivery;
 * - `failed`  — dws definitely rejected the message before delivery;
 * - `gone`    — the target conversation no longer exists;
 * - `unknown` — the outcome cannot be proven (timeout, no receipt, unclassified
 *               non-zero exit), and the caller **must not retry**.
 *
 * The mapping lives here, not in the caller, because retrying an `unknown` send
 * is the one mistake the Outbox design forbids.
 */
import type { Outbound } from '../core/model.ts'
import type { Settings } from '../shared/settings.ts'
import { ChannelError } from './errors.ts'
import { describeError, redact, truncate } from './log.ts'
import { createRunner, shortStderr } from './process.ts'
import { parsePeerAddress, withProfile } from './targets.ts'
import type { CommandResult, CommandRunner, SendResult } from './types.ts'

/** A send outcome plus the receipt/error detail kept for the Outbox record. */
export interface SendDetail {
  readonly result: SendResult
  readonly receipt?: string
  readonly error?: string
}

export interface SenderIo {
  readonly runner?: CommandRunner
  readonly timeoutMs?: number
}

/** Phrases that prove the conversation is unusable, which is not a retryable failure. */
const GONE_MARKERS = [
  /not\s+found/i,
  /not[_-]found/i,
  /not\s+exist/i,
  /not[_-]exist/i,
  /does\s+not\s+exist/i,
  /no\s+such/i,
  /chat\s+(?:is\s+)?(?:invalid|missing|not)/i,
  /target\s+(?:is\s+)?(?:invalid|missing|not)/i,
  /不存在/,
  /未找到/,
  /已被?解散/,
  /不是(?:该群|群)?成员/,
  /不在(?:该)?群/,
]

/** A duplicate idempotency key proves the message was already accepted; never resend it. */
const DUPLICATE_MARKERS = [
  /request\s+is\s+repeated/i,
  /repeated\s+with\s+uuid/i,
  /conflict_error/i,
  /duplicate\s+(?:idempotency|request|message|uuid)/i,
]

/** Delivery states that prove the message reached the conversation. */
const DELIVERED_STATUS = new Set(['delivered', 'sent', 'ok'])

/** Phrases that prove a definite rejection rather than an uncertain outcome. */
const REJECT_MARKERS = [
  /invalid/i,
  /denied/i,
  /forbidden/i,
  /rejected/i,
  /not\s+allowed/i,
  /unauthori[sz]ed/i,
  /bad\s+request/i,
  /confirmation_required/i,
  /validation/i,
  /需要用户确认/,
  /无权限/,
  /权限不足/,
  /参数错误/,
  /发送失败/,
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonDocument(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const attempts = [trimmed]
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1))
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt)
      if (isRecord(parsed)) return parsed
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

function failureCode(payload: Record<string, unknown> | undefined): unknown {
  if (!payload) return undefined
  const nested = isRecord(payload.error) ? payload.error : undefined
  return payload.errcode ?? payload.errCode ?? payload.errorCode ?? payload.code ?? nested?.code ?? nested?.errcode
}

function isFailureCode(code: unknown): boolean {
  if (code === undefined || code === null) return false
  if (typeof code === 'number') return code !== 0
  if (typeof code === 'string') return code.trim() !== '' && code.trim() !== '0' && code.trim().toLowerCase() !== 'ok'
  return true
}

function receiptOf(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined
  for (const field of ['openMessageId', 'messageId', 'msgId', 'processQueryKey', 'requestId', 'id']) {
    const value = payload[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function explicitFailure(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  return payload.success === false || payload.ok === false || isFailureCode(failureCode(payload))
}

function explicitSuccess(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  if (payload.success === true || payload.ok === true) return true
  if (failureCode(payload) === 0 || failureCode(payload) === '0') return true
  return receiptOf(payload) !== undefined
}

function failureText(payload: Record<string, unknown> | undefined, stderr: string): string {
  const parts: string[] = [stderr]
  const readFields = (record: Record<string, unknown>): void => {
    for (const field of [
      'message',
      'errorMsg',
      'errorMessage',
      'errmsg',
      'reason',
      'category',
      'errorCode',
      'errCode',
    ]) {
      const value = record[field]
      if (typeof value === 'string') parts.push(value)
      else if (typeof value === 'number') parts.push(String(value))
    }
  }
  if (payload) {
    readFields(payload)
    // dws wraps rejections as `{"error": {"category": ..., "reason": ...}}`.
    if (isRecord(payload.error)) readFields(payload.error)
  }
  return parts.filter((part) => part.trim() !== '').join(' ')
}

/** Classify one finished dws invocation; exported so the mapping is testable on its own. */
export function classifySendOutcome(result: CommandResult): SendDetail {
  if (result.error) return { result: 'failed', error: truncate(redact(result.error), 200) }
  if (result.timedOut) return { result: 'unknown', error: 'dws send timed out; delivery cannot be proven' }

  // A rejected send may print its JSON on stderr; treat both streams as receipts.
  const payload = parseJsonDocument(result.stdout) ?? parseJsonDocument(result.stderr)
  const text = failureText(payload, result.stderr)
  const gone = GONE_MARKERS.some((marker) => marker.test(text))
  const rejected = REJECT_MARKERS.some((marker) => marker.test(text))

  // A repeated uuid means the first attempt was already accepted. It is not a
  // failure and definitely not a reason to resend: the caller must treat the
  // outbound as unknown and reconcile by the idempotency key.
  if (DUPLICATE_MARKERS.some((marker) => marker.test(text))) {
    return {
      result: 'unknown',
      error: 'duplicate idempotency key; the message was already accepted, do not retry',
    }
  }

  if (result.code === 0) {
    if (explicitFailure(payload)) {
      if (gone) return { result: 'gone', error: truncate(redact(text), 200) }
      return {
        result: 'failed',
        error: truncate(redact(text || `dws reported failure code ${String(failureCode(payload))}`), 200),
      }
    }
    const deliveryStatus =
      typeof payload?.deliveryStatus === 'string' ? payload.deliveryStatus.trim().toLowerCase() : undefined
    if (deliveryStatus !== undefined) {
      if (!DELIVERED_STATUS.has(deliveryStatus)) {
        return {
          result: 'unknown',
          error: truncate(redact(`dws reported deliveryStatus=${deliveryStatus}`), 200),
        }
      }
      const statusReceipt = receiptOf(payload)
      return { result: 'sent', ...(statusReceipt ? { receipt: statusReceipt } : {}) }
    }
    if (!payload || !explicitSuccess(payload)) {
      // Exit 0 without a confirming receipt is not proof of delivery.
      return { result: 'unknown', error: 'dws send returned no confirming receipt' }
    }
    const receipt = receiptOf(payload)
    return { result: 'sent', ...(receipt ? { receipt } : {}) }
  }

  if (gone) return { result: 'gone', error: truncate(redact(text), 200) }
  if (rejected) return { result: 'failed', error: truncate(redact(text), 200) }
  if (isFailureCode(failureCode(payload))) {
    return {
      result: 'failed',
      error: truncate(redact(text || `dws rejected the send (code=${String(failureCode(payload))})`), 200),
    }
  }
  if (payload && (payload.success === false || payload.ok === false)) {
    return { result: 'failed', error: truncate(redact(text || 'dws rejected the send'), 200) }
  }
  const detail = shortStderr(result.stderr) || `exit ${result.code ?? 'null'} with no classified reason`
  return { result: 'unknown', error: truncate(redact(detail), 200) }
}

/**
 * Build the `+messages-send` argument array.
 *
 * Every value is one argv element; nothing is concatenated into a shell string.
 * The markdown body is passed after the target flags so a body that starts with
 * `-` is still a value of `--markdown`.
 */
export function buildSendArgs(outbound: Outbound, settings: Settings): string[] {
  const key = outbound.idempotencyKey.trim()
  if (key === '') throw new ChannelError('invalid-outbound', 'outbound message has no idempotency key')
  if (outbound.text.trim() === '') throw new ChannelError('invalid-outbound', 'outbound message has no text')

  const args = [
    'chat',
    '+messages-send',
    '--as',
    'user',
    '--ai-tag',
    '--idempotency-key',
    key,
    '--wait-delivery',
    '-f',
    'json',
    // Non-interactive confirmation. Sending is always part of a flow the owner
    // already configured or approved; dws rejects the call without `--yes`
    // (T2: exit 3, `confirmation_required`).
    '--yes',
  ]

  const target = outbound.target
  if (target.kind === 'dm') {
    const address = parsePeerAddress(target.peerUserId?.trim() || target.conversationId)
    args.push(address.flag, address.value)
  } else {
    const conversationId = target.conversationId.trim()
    if (conversationId === '') throw new ChannelError('invalid-target', 'outbound target has no conversation id')
    // An at-me event answers inside its group, so it uses the same chat flag.
    args.push('--chat-id', conversationId)
  }

  args.push('--markdown', outbound.text)
  return withProfile(args, settings)
}

/**
 * Send one queued outbound message.
 *
 * A message without an idempotency key is refused before spawning: without the
 * key there is no way to prove that a retry is safe.
 */
export async function sendDetailed(outbound: Outbound, settings: Settings, io: SenderIo = {}): Promise<SendDetail> {
  let args: string[]
  try {
    args = buildSendArgs(outbound, settings)
  } catch (error) {
    return { result: 'failed', error: describeError(error) }
  }

  const runner = io.runner ?? createRunner({ command: settings.dws.binaryPath })
  let result: CommandResult
  try {
    result = await runner.run(args, { timeoutMs: io.timeoutMs ?? 30_000 })
  } catch (error) {
    return { result: 'failed', error: describeError(error) }
  }
  return classifySendOutcome(result)
}

/** Send one queued outbound message and return only its result. */
export async function send(outbound: Outbound, settings: Settings, io: SenderIo = {}): Promise<SendResult> {
  return (await sendDetailed(outbound, settings, io)).result
}
