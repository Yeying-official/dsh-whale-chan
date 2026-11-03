/** Session navigation failure and its localized message. */
import { errorText } from './errors.ts'
import type { T } from './locale.ts'

/** The catalog is not ready, or it does not list the requested session. */
export class SessionNavigationError extends Error {
  constructor(readonly reason: 'not-ready' | 'not-listed') {
    super(reason)
    this.name = 'SessionNavigationError'
  }
}

/** Prefer the session-specific copy; every other failure falls back to the API message. */
export function sessionErrorText(error: Error, t: T): string {
  if (error instanceof SessionNavigationError) {
    return t(error.reason === 'not-ready' ? 'session.notReady' : 'session.notListed')
  }
  return errorText(error, t)
}
