/**
 * Channel-local error type.
 *
 * `code` is stable and machine-readable; `message` is already redacted by the
 * caller and never carries message text, tokens or raw payloads.
 */
export type ChannelErrorCode =
  | 'dws-missing'
  | 'dws-failed'
  | 'dws-timeout'
  | 'dws-output'
  | 'auth-missing'
  | 'invalid-target'
  | 'invalid-outbound'
  | 'owner-unknown'
  | 'invalid-state'

export class ChannelError extends Error {
  readonly code: ChannelErrorCode

  constructor(code: ChannelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ChannelError'
    this.code = code
  }
}

export function isChannelError(value: unknown): value is ChannelError {
  return value instanceof ChannelError
}
