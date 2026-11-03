/**
 * Errors the executor raises for failures the app layer has to tell apart.
 *
 * Domain refusals keep using `UserError` (`notApproved` when a task runs
 * without approval); this module covers the executor's own refusals plus the
 * model adapter's failures, which the brain maps onto its `ComposeFailure`
 * reasons. Every error carries a stable `code`, so a caller never has to parse
 * a message and a locale file can key on the code.
 */

/** Stable codes of an executor failure. */
export const EXECUTOR_ERRORS = {
  alreadyRunning: 'The task is already running',
  unsafeTaskId: 'The task id is not a single safe path segment',
  missingWorkspace: 'The task has no usable workspace directory',
  /**
   * The approval named a workspace that is not an absolute path.
   *
   * It is an executor error rather than a `UserError` because the domain's code
   * table in `src/core/errors.ts` is closed and this layer does not write it; a
   * relative path is refused before any directory or session is created, which
   * is the property the domain care about.
   */
  invalidWorkspace: 'The approved workspace must be an absolute path',
  sessionUnavailable: 'The worker session could not be created',
  modelTimeout: 'The session did not end its turn in time',
  modelAborted: 'The session turn was aborted',
  modelFailed: 'The session turn failed',
  disposed: 'The executor was disposed',
} as const

export type ExecutorErrorCode = keyof typeof EXECUTOR_ERRORS

/** One executor failure with a stable code. */
export class ExecutorError extends Error {
  constructor(
    readonly code: ExecutorErrorCode,
    readonly detail?: string,
  ) {
    super(detail === undefined || detail.length === 0 ? EXECUTOR_ERRORS[code] : `${EXECUTOR_ERRORS[code]}: ${detail}`)
    this.name = 'ExecutorError'
  }
}

/**
 * A model call ran out of its wall-clock budget.
 *
 * It is a `ModelPort` rejection, so the brain turns it into `model_error` when
 * its own deadline has not fired first; the `reason` field is what a wrapper
 * maps to the brain's `timeout` failure instead of a generic error.
 */
export class ModelTimeoutError extends ExecutorError {
  readonly reason = 'timeout' as const

  constructor(detail?: string) {
    super('modelTimeout', detail)
    this.name = 'ModelTimeoutError'
  }
}

/** A model call was cancelled by its caller's `AbortSignal`. */
export class ModelAbortedError extends ExecutorError {
  readonly reason = 'aborted' as const

  constructor(detail?: string) {
    super('modelAborted', detail)
    this.name = 'ModelAbortedError'
  }
}

/** The session turn ended in failure, such as a model-provider error inside DSH. */
export class ModelFailedError extends ExecutorError {
  readonly reason = 'error' as const

  constructor(detail?: string) {
    super('modelFailed', detail)
    this.name = 'ModelFailedError'
  }
}

/** Whether `error` is one of this layer's own failures, including the model adapter's. */
export function isExecutorError(error: unknown): error is ExecutorError {
  return error instanceof ExecutorError
}
