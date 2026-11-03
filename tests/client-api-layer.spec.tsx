// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ApiError, call, getJson, postJson, putJson, useApi, useMutation } from '../src/client/api.ts'
import { API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE } from '../src/shared/api.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response
}

describe('api layer', () => {
  it('sends the same-origin guard header on every verb', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await getJson('/whale-chan/api/state')
    await postJson('/whale-chan/api/monitor/pause', { paused: true })
    await putJson('/whale-chan/api/settings/monitor', { value: {}, revision: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ [API_REQUEST_HEADER]: API_REQUEST_HEADER_VALUE })
    }
    const post = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(post.method).toBe('POST')
    expect(post.body).toBe(JSON.stringify({ paused: true }))
    expect((post.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('parses the structured error body, including issues and actualRevision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(400, {
          ok: false,
          error: {
            code: 'invalid_settings',
            message: 'bad',
            issues: [{ path: 'intervalSeconds', message: 'too small' }],
          },
        }),
      ),
    )
    const failure = await getJson('/x').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 400, code: 'invalid_settings' })
    expect((failure as ApiError).issues).toEqual([{ path: 'intervalSeconds', message: 'too small' }])

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, { ok: false, error: { code: 'settings_conflict', message: 'stale', actualRevision: 7 } }),
      ),
    )
    const conflict = await getJson('/x').catch((error: unknown) => error)
    expect(conflict).toBeInstanceOf(ApiError)
    expect((conflict as ApiError).conflict).toBe(true)
    expect((conflict as ApiError).actualRevision).toBe(7)
  })

  it('maps an unreachable host and invalid JSON to distinct failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('down'))),
    )
    await expect(getJson('/x')).rejects.toMatchObject({ status: 0, code: 'offline' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => 'not json' }) as unknown as Response),
    )
    await expect(getJson('/x')).rejects.toMatchObject({ status: 200 })
  })

  it('aborts a request that exceeds its timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
      ),
    )
    const promise = getJson('/x', undefined, 10)
    const assertion = expect(promise).rejects.toMatchObject({ status: 0, code: 'timeout' })
    await vi.advanceTimersByTimeAsync(20)
    await assertion
  })

  it('builds encoded query strings through the typed route caller', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { items: [], nextOffset: null }))
    vi.stubGlobal('fetch', fetchMock)
    await call('GET tasks', { query: { status: 'failed', offset: 0 } })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/whale-chan/api/tasks?status=failed&offset=0')
  })
})

describe('api hooks', () => {
  it('aborts the in-flight loader when the component unmounts', async () => {
    let signal: AbortSignal | undefined
    const loader = vi.fn(
      (next: AbortSignal) =>
        new Promise<number>((_resolve, reject) => {
          signal = next
          next.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const { unmount } = renderHook(() => useApi(loader))
    await act(async () => {
      await Promise.resolve()
    })
    expect(loader).toHaveBeenCalledTimes(1)
    unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('polls while mounted and stops after unmount', async () => {
    vi.useFakeTimers()
    const loader = vi.fn(async () => 1)
    const { unmount } = renderHook(() => useApi(loader, { intervalMs: 1000 }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(loader).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(loader).toHaveBeenCalledTimes(2)
    unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('runs a mutation and keeps its error available', async () => {
    const action = vi.fn(async (value: number) => {
      if (value < 0) throw new Error('bad input')
      return value * 2
    })
    const { result } = renderHook(() => useMutation(action))
    await act(async () => {
      await expect(result.current.run(2)).resolves.toBe(4)
    })
    expect(result.current.error).toBeUndefined()
    await act(async () => {
      await result.current.run(-1).catch(() => undefined)
    })
    expect(result.current.error?.message).toBe('bad input')
    act(() => result.current.reset())
    expect(result.current.error).toBeUndefined()
  })
})
