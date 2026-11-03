/**
 * Same-origin client for the management API.
 *
 * Every request carries `x-whale-chan-request: 1`, is cancellable through an
 * `AbortController`, and has a hard timeout. Failures become `ApiError` with
 * the HTTP status plus the structured `ErrorBody` fields the panel needs
 * (`code`, `issues`, `actualRevision`, `values`).
 *
 * `useApi` polls one loader while mounted (polling is opt-in per page) and
 * `useMutation` runs one action with pending/error state. Both abort in-flight
 * work on unmount, so a panel tab never leaks a request.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE, apiUrl } from '../shared/api.ts'
import type { ApiResponse, ApiRoute } from '../shared/api.ts'
import type { Health, StateView } from '../shared/models.ts'

/** Wire issues returned by `400 invalid_settings`. */
export interface ApiIssue {
  readonly path: string
  readonly message: string
}

export interface ApiErrorOptions {
  readonly code?: string | undefined
  readonly issues?: readonly ApiIssue[] | undefined
  readonly actualRevision?: number | undefined
  readonly values?: Readonly<Record<string, string>> | undefined
}

/** A failed management request; `status` is 0 when the host could not be reached. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly issues: readonly ApiIssue[]
  readonly actualRevision: number | undefined
  readonly values: Readonly<Record<string, string>> | undefined

  constructor(message: string, status: number, options: ApiErrorOptions = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = options.code
    this.issues = options.issues ?? []
    this.actualRevision = options.actualRevision
    this.values = options.values
  }

  /** True when the failure is a settings revision conflict. */
  get conflict(): boolean {
    return this.status === 409 && this.code === 'settings_conflict'
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** Build one URL from a route, path parameters and a query object. */
export function buildUrl(
  route: ApiRoute,
  params: Readonly<Record<string, string>> = {},
  query: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const search = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join('&')
  const url = apiUrl(route, params)
  return search ? `${url}?${search}` : url
}

interface SendOptions {
  readonly body?: unknown
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

interface ParsedFailure {
  readonly code?: string | undefined
  readonly message?: string | undefined
  readonly issues: readonly ApiIssue[]
  readonly actualRevision?: number | undefined
  readonly values?: Readonly<Record<string, string>> | undefined
}

function parseIssues(value: unknown): readonly ApiIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ApiIssue[] => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.message !== 'string') return []
    return [{ path: item.path, message: item.message }]
  })
}

/** Read the structured host failure, tolerating any extra or missing member. */
export function parseFailure(value: unknown): ParsedFailure {
  const error = isRecord(value) && isRecord(value.error) ? value.error : undefined
  if (!error) return { issues: [] }
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    message: typeof error.message === 'string' ? error.message : undefined,
    issues: parseIssues(error.issues),
    actualRevision: typeof error.actualRevision === 'number' ? error.actualRevision : undefined,
    values: isRecord(error.values)
      ? Object.fromEntries(
          Object.entries(error.values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : undefined,
  }
}

async function send(method: 'GET' | 'POST' | 'PUT', url: string, options: SendOptions = {}): Promise<unknown> {
  const controller = new AbortController()
  const external = options.signal
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abort = () => controller.abort()
  if (external?.aborted) controller.abort()
  external?.addEventListener('abort', abort, { once: true })

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        [API_REQUEST_HEADER]: API_REQUEST_HEADER_VALUE,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })
  } catch (error) {
    if (external?.aborted) throw error
    throw new ApiError(timedOut ? 'The request timed out' : 'The DSH Web host is unreachable', 0, {
      code: timedOut ? 'timeout' : 'offline',
    })
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', abort)
  }

  const text = await response.text()
  let value: unknown
  if (text) {
    try {
      value = JSON.parse(text) as unknown
    } catch {
      throw new ApiError('The host returned invalid JSON', response.status)
    }
  }

  if (!response.ok) {
    const failure = parseFailure(value)
    throw new ApiError(failure.message ?? `The host returned HTTP ${response.status}`, response.status, {
      code: failure.code,
      issues: failure.issues,
      actualRevision: failure.actualRevision,
      values: failure.values,
    })
  }
  return value
}

/** GET one JSON resource with the same-origin guard header. */
export function getJson<T>(url: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  return send('GET', url, { signal, timeoutMs }) as Promise<T>
}

/** POST one JSON body; resolves the parsed response. */
export function postJson<T>(url: string, body: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  return send('POST', url, { body, signal, timeoutMs }) as Promise<T>
}

/** PUT one JSON body; resolves the parsed response. */
export function putJson<T>(url: string, body: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  return send('PUT', url, { body, signal, timeoutMs }) as Promise<T>
}

/** Read `GET state`; kept as the smallest end-to-end API example. */
export async function fetchState(signal: AbortSignal): Promise<StateView> {
  const value = await getJson<unknown>(apiUrl('GET state'), signal)
  if (!isStateView(value)) throw new ApiError('The host returned an invalid state', 200)
  return value
}

export interface CallOptions {
  readonly params?: Readonly<Record<string, string>> | undefined
  readonly query?: Readonly<Record<string, string | number | undefined>> | undefined
  /** Request body; action bodies extend the frozen contract, so this stays unknown at the call site. */
  readonly body?: unknown
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

/** Call one typed management route and get its typed response. */
export function call<K extends ApiRoute>(route: K, options: CallOptions = {}): Promise<ApiResponse<K>> {
  const method = route.slice(0, route.indexOf(' ')) as 'GET' | 'POST' | 'PUT'
  const url = buildUrl(route, options.params, options.query)
  if (method === 'GET') return getJson<ApiResponse<K>>(url, options.signal, options.timeoutMs)
  if (method === 'PUT') return putJson<ApiResponse<K>>(url, options.body, options.signal, options.timeoutMs)
  return postJson<ApiResponse<K>>(url, options.body, options.signal, options.timeoutMs)
}

/** Read `GET health`; the shell badge polls this. */
export function fetchHealth(signal: AbortSignal): Promise<Health> {
  return call('GET health', { signal })
}

export interface ApiQueryState<T> {
  readonly data: T | undefined
  readonly error: Error | undefined
  readonly loading: boolean
  readonly reload: () => void
}

export interface ApiQueryOptions {
  /** Poll interval in milliseconds; omit or `false` for a manual page. */
  readonly intervalMs?: number | false
  /** Extra dependencies that restart the subscription (for example a refresh token). */
  readonly deps?: readonly unknown[]
}

/**
 * Run one loader while mounted.
 *
 * The loader is read through a ref, so an inline arrow does not restart the
 * subscription on every render. The previous value survives a reload until the
 * next response arrives, which keeps forms and lists from flashing.
 */
export function useApi<T>(load: (signal: AbortSignal) => Promise<T>, options: ApiQueryOptions = {}): ApiQueryState<T> {
  const loader = useRef(load)
  loader.current = load
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true })
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  const intervalMs = options.intervalMs ?? false
  const deps = options.deps ?? []

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const run = async (): Promise<void> => {
      try {
        const next = await loader.current(controller.signal)
        if (!active) return
        setState({ data: next, loading: false })
      } catch (failure) {
        if (!active || controller.signal.aborted) return
        setState((previous) => ({
          ...(previous.data === undefined ? {} : { data: previous.data }),
          error: failure instanceof Error ? failure : new Error(String(failure)),
          loading: false,
        }))
      } finally {
        if (active && intervalMs !== false) timer = setTimeout(() => void run(), intervalMs)
      }
    }

    setState((previous) => ({ ...previous, loading: previous.data === undefined }))
    void run()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, intervalMs, ...deps])

  return { data: state.data, error: state.error, loading: state.loading, reload }
}

export interface MutationState<Args extends unknown[], Result> {
  readonly run: (...args: Args) => Promise<Result>
  readonly pending: boolean
  readonly error: Error | undefined
  readonly reset: () => void
}

/** Run one action at a time; errors stay available until the next run. */
export function useMutation<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
): MutationState<Args, Result> {
  const current = useRef(action)
  current.current = action
  const active = useRef(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Error>()
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const run = useCallback(async (...args: Args): Promise<Result> => {
    setPending(true)
    setError(undefined)
    try {
      return await current.current(...args)
    } catch (failure) {
      const next = failure instanceof Error ? failure : new Error(String(failure))
      if (active.current) setError(next)
      throw next
    } finally {
      if (active.current) setPending(false)
    }
  }, [])

  const reset = useCallback(() => setError(undefined), [])
  return { run, pending, error, reset }
}

export interface PagedState<T> {
  readonly items: readonly T[]
  readonly error: Error | undefined
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly hasMore: boolean
  readonly reload: () => void
  readonly loadMore: () => void
}

export interface PagedOptions {
  readonly deps?: readonly unknown[]
}

interface PageLike<T> {
  readonly items: readonly T[]
  readonly nextOffset: number | null
}

interface PagedInternal<T> {
  readonly items: readonly T[]
  readonly next: number | null
  readonly error?: Error
  readonly loading: boolean
  readonly loadingMore: boolean
}

/**
 * Offset-paged list with an explicit "load more" action.
 *
 * Pages append in request order and a reload resets to the first page; an
 * aborted page (tab switch, unmount) never lands in state.
 */
export function usePaged<T>(
  load: (offset: number, signal: AbortSignal) => Promise<PageLike<T>>,
  options: PagedOptions = {},
): PagedState<T> {
  const loader = useRef(load)
  loader.current = load
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<PagedInternal<T>>({ items: [], next: 0, loading: true, loadingMore: false })
  const latest = useRef(state)
  latest.current = state
  const request = useRef<AbortController | undefined>(undefined)
  const deps = options.deps ?? []

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    request.current = controller
    setState({ items: [], next: 0, loading: true, loadingMore: false })
    void (async () => {
      try {
        const page = await loader.current(0, controller.signal)
        if (!active) return
        setState({ items: page.items, next: page.nextOffset, loading: false, loadingMore: false })
      } catch (failure) {
        if (!active || controller.signal.aborted) return
        setState({ items: [], next: null, loading: false, loadingMore: false, error: asError(failure) })
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps])

  const reload = useCallback(() => setVersion((value) => value + 1), [])
  const loadMore = useCallback(() => {
    const current = latest.current
    if (current.loading || current.loadingMore || current.next === null) return
    const offset = current.next
    const controller = new AbortController()
    request.current?.abort()
    request.current = controller
    setState((previous) => ({ ...previous, loadingMore: true, error: undefined }))
    void (async () => {
      try {
        const page = await loader.current(offset, controller.signal)
        if (controller.signal.aborted) return
        setState((previous) =>
          previous.next === offset
            ? {
                ...previous,
                items: [...previous.items, ...page.items],
                next: page.nextOffset,
                loadingMore: false,
                error: undefined,
              }
            : previous,
        )
      } catch (failure) {
        if (controller.signal.aborted) return
        setState((previous) => ({ ...previous, loadingMore: false, error: asError(failure) }))
      }
    })()
  }, [])

  return {
    items: state.items,
    error: state.error,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.next !== null,
    reload,
    loadMore,
  }
}

function asError(failure: unknown): Error {
  return failure instanceof Error ? failure : new Error(String(failure))
}
