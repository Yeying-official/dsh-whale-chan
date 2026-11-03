/** Localized copy for every API failure the panel can show. */
import { ApiError } from './api.ts'
import type { T } from './locale.ts'

/** Human-readable message for any thrown value. */
export function errorText(error: Error, t: T): string {
  if (!(error instanceof ApiError)) return error.message || t('common.error')
  if (error.status === 0) return error.code === 'timeout' ? t('errors.timeout') : t('overview.errorOffline')
  if (error.status === 400) {
    return error.issues.length > 0
      ? t('errors.issuesTitle', { count: error.issues.length })
      : t('errors.invalid', { status: 400 })
  }
  if (error.status === 403) return t('errors.forbidden')
  if (error.status === 404) return t('errors.missing')
  if (error.status === 409) {
    return error.conflict ? t('errors.conflict') : t('errors.refused', { code: error.code ?? 'conflict' })
  }
  if (error.status === 503) {
    return error.code === 'channel_unavailable' ? t('errors.channelUnavailable') : t('errors.notReady')
  }
  if (error.status >= 500) return t('errors.server', { status: error.status })
  return t('errors.request', { status: error.status })
}

/** Short code label for logs and detail rows; never a raw stack. */
export function errorCode(error: Error): string {
  if (error instanceof ApiError) return error.code ?? String(error.status)
  return 'error'
}

/** Turn a thrown value into an Error without losing the message. */
export function asError(failure: unknown): Error {
  return failure instanceof Error ? failure : new Error(String(failure))
}
