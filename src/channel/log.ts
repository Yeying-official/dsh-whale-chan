/**
 * Redaction helpers for channel logs.
 *
 * Hard rules from `docs/010-design.md` §8 and `docs/013-security.md`: default
 * logs never carry message text, tokens, client secrets, account ids or a raw
 * payload. `redact` masks credential-shaped key/value pairs and every URL query
 * value; `describeError` reduces an error to one line without a stack or body.
 */
import { isChannelError } from './errors.ts'

const MASK = '[redacted]'

/**
 * Keys whose values never reach a log line. Names cover the dws credential and
 * account surface (`corpId`, `userId`, open ids) plus the usual token spellings.
 */
const SENSITIVE_KEY =
  /^(?:access[_-]?token|refresh[_-]?token|token|idempotency[_-]?key|client[_-]?id|client[_-]?secret|app[_-]?key|app[_-]?secret|secret|password|passwd|authorization|cookie|credential|corp[_-]?id|user[_-]?id|staff[_-]?id|sender[_-]?id|open[_-]?dingtalk[_-]?id|open[_-]?conversation[_-]?id|chat[_-]?id|subscribe[_-]?id|bus[_-]?pid)$/i

/** `Bearer <token>` and `Basic <blob>` authorization headers. */
const AUTHORIZATION = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi

/** Every URL query value, masked wholesale so no parameter spelling has to be guessed. */
const QUERY = /([?&])([^=&\s#]+)=([^&\s#]*)/g

/**
 * `key=value`, `key: value` and `"key":"value"` pairs. The value class stops at
 * whitespace, quotes, commas and closing braces so a pair inside JSON is masked
 * without swallowing the rest of the line.
 */
/** Quoted JSON pairs such as `"clientSecret":"x"`, whose key is wrapped in quotes. */
const JSON_PAIR = /"([A-Za-z0-9_.-]+)"(\s*:\s*)"([^"]*)"/g

const PAIR = /([A-Za-z0-9_.-]+)(\s*[=:]\s*)("?)([^"&\s,}]+)\3/g

/** Truncate to `maxLength` characters, marking that bytes were dropped. */
export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

/**
 * Mask credentials, account identifiers and URL query values.
 *
 * The function is deliberately textual: it runs on strings the channel already
 * owns (stderr lines, error messages) and never parses a payload.
 */
export function redact(text: string): string {
  if (!text) return text
  return text
    .replace(QUERY, (_all, separator: string, key: string) => `${separator}${key}=${MASK}`)
    .replace(AUTHORIZATION, (_all, scheme: string) => `${scheme} ${MASK}`)
    .replace(JSON_PAIR, (all, key: string, separator: string) =>
      SENSITIVE_KEY.test(key) ? `"${key}"${separator}"${MASK}"` : all,
    )
    .replace(PAIR, (all, key: string, separator: string, quote: string) =>
      SENSITIVE_KEY.test(key) ? `${key}${separator}${quote}${MASK}${quote}` : all,
    )
}

/**
 * One-line, redacted description of a failure.
 *
 * Stacks and causes are dropped: a stack can embed the payload that caused the
 * failure, and the channel has no business writing it to a log.
 */
export function describeError(error: unknown, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? 180
  const line = (text: string): string => truncate(redact(text).replace(/\s+/g, ' ').trim(), maxLength)
  if (isChannelError(error)) return line(`channel-error code=${error.code} ${error.message}`)
  if (error instanceof Error) {
    const rawCode = (error as { code?: unknown }).code
    const code = typeof rawCode === 'string' ? ` code=${rawCode}` : ''
    return line(`error name=${error.name}${code} ${error.message}`)
  }
  if (typeof error === 'string') return line(`text ${error}`)
  return line(`value ${typeof error}`)
}

/** Summarize a process exit without any payload. */
export function describeExit(code: number | null, signal: string | null, expected: boolean): string {
  return `exit code=${code ?? 'null'} signal=${signal ?? 'null'} expected=${expected}`
}
