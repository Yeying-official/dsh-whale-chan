import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, fetchState, isStateView } from '../src/client/api.ts'
import { API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE, apiUrl } from '../src/shared/api.ts'

const valid = {
  ok: true,
  name: 'dsh-whale-chan-assistant',
  version: '0.1.0',
  stateDir: 'C:\\Users\\example\\.dsh-whale-chan',
  startedAt: '2026-11-02T00:00:00.000Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client state API', () => {
  it('accepts only the complete state shape', () => {
    expect(isStateView(valid)).toBe(true)
    expect(isStateView({ ...valid, ok: false })).toBe(false)
    expect(isStateView({ ...valid, stateDir: undefined })).toBe(false)
    expect(isStateView(null)).toBe(false)
  })

  it('returns the state from a same-origin response with the request guard header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(valid), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchState(new AbortController().signal)).resolves.toEqual(valid)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(apiUrl('GET state'))
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({
        accept: 'application/json',
        [API_REQUEST_HEADER]: API_REQUEST_HEADER_VALUE,
      }),
    })
  })

  it('reports HTTP failures with their status and server code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: { code: 'state_unavailable', message: 'starting' } }), {
            status: 503,
          }),
      ),
    )
    const failure = await fetchState(new AbortController().signal).catch((error) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 503, code: 'state_unavailable' })
  })

  it('reports an unreachable host as status 0 and invalid JSON separately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('network down'))),
    )
    await expect(fetchState(new AbortController().signal)).rejects.toMatchObject({ status: 0 })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    )
    await expect(fetchState(new AbortController().signal)).rejects.toMatchObject({ status: 200 })
  })
})
