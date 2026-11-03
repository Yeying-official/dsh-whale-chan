/**
 * One deadline for every model and retrieval call.
 *
 * The port contract takes an `AbortSignal`, so the brain can bound a call
 * without knowing how the port is implemented. The deadline aborts the port and
 * also settles the turn, so a port that ignores its signal cannot hold a reply
 * open; a rejection that arrives afterwards is observed and dropped, which means
 * a late failure never becomes an unhandled rejection.
 */

export type DeadlineFailureReason = 'timeout' | 'aborted' | 'error'

export type DeadlineOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DeadlineFailureReason; readonly detail?: string }

function describe(error: unknown): string {
  if (error instanceof Error) return (error.message || error.name).slice(0, 200)
  return String(error).slice(0, 200)
}

/**
 * Run `work` under a linked abort signal and a wall-clock budget.
 *
 * - `timeoutMs <= 0`, `NaN` or `Infinity` means "no deadline"; only the caller's
 *   signal bounds the call.
 * - An already-aborted caller signal returns `aborted` without calling `work`.
 * - A port that rejects on its own returns `error`; if the deadline fired
 *   first the outcome stays `timeout`.
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DeadlineOutcome<T>> {
  if (signal.aborted) return { ok: false, reason: 'aborted' }

  const controller = new AbortController()
  let settledBy: 'timeout' | 'aborted' | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settleDeadline: ((outcome: DeadlineOutcome<T>) => void) | undefined

  const deadline = new Promise<DeadlineOutcome<T>>((resolve) => {
    settleDeadline = resolve
  })

  const onAbort = () => {
    if (settledBy !== undefined) return
    settledBy = 'aborted'
    controller.abort()
    settleDeadline?.({ ok: false, reason: 'aborted' })
  }
  signal.addEventListener('abort', onAbort, { once: true })

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      if (settledBy !== undefined) return
      settledBy = 'timeout'
      controller.abort()
      settleDeadline?.({ ok: false, reason: 'timeout' })
    }, timeoutMs)
  }

  const attempted = Promise.resolve()
    .then(() => work(controller.signal))
    .then(
      (value): DeadlineOutcome<T> => ({ ok: true, value }),
      (error: unknown): DeadlineOutcome<T> => {
        if (settledBy === 'timeout') return { ok: false, reason: 'timeout' }
        if (settledBy === 'aborted' || signal.aborted) return { ok: false, reason: 'aborted' }
        return { ok: false, reason: 'error', detail: describe(error) }
      },
    )

  try {
    return await Promise.race([attempted, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
