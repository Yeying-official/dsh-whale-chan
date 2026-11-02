/** Same-origin client for the read-only WS0 management route and its polling hook. */
import { useCallback, useEffect, useState } from 'react'
import { API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE, apiUrl } from '../shared/api.ts'
import type { StateView } from '../shared/models.ts'

const STATE_URL = apiUrl('GET state')

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isStateView(value: unknown): value is StateView {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.name === 'string' &&
    typeof value.version === 'string' &&
    typeof value.stateDir === 'string' &&
    typeof value.startedAt === 'string'
  )
}

/** Read the state route; all failures become `ApiError` with a status. */
export async function fetchState(signal: AbortSignal): Promise<StateView> {
  let response: Response
  try {
    response = await fetch(STATE_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        [API_REQUEST_HEADER]: API_REQUEST_HEADER_VALUE,
      },
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new ApiError('The DSH Web host is unreachable', 0)
  }

  const text = await response.text()
  let value: unknown
  try {
    value = text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    throw new ApiError('The host returned invalid JSON', response.status)
  }

  if (!response.ok) {
    const code =
      isRecord(value) && isRecord(value.error) && typeof value.error.code === 'string' ? value.error.code : undefined
    throw new ApiError(`The host returned HTTP ${response.status}`, response.status, code)
  }
  if (!isStateView(value)) throw new ApiError('The host returned an invalid state', response.status)
  return value
}

export interface PollResult<T> {
  readonly data: T | undefined
  readonly error: Error | undefined
  readonly loading: boolean
  readonly reload: () => void
}

/**
 * Poll one loader while mounted. A reload aborts the current request and starts
 * a new subscription, so a slow response can never overwrite newer state.
 */
export function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs = 5000): PollResult<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const poll = async (): Promise<void> => {
      try {
        const next = await load(controller.signal)
        if (!active) return
        setData(next)
        setError(undefined)
      } catch (failure) {
        if (!active || controller.signal.aborted) return
        setError(failure instanceof Error ? failure : new Error(String(failure)))
      } finally {
        if (!active) return
        setLoading(false)
        timer = setTimeout(() => void poll(), intervalMs)
      }
    }

    void poll()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
  }, [generation, intervalMs, load])

  return { data, error, loading, reload }
}
