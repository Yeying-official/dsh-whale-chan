import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, archiveTargetSessions, fetchState, isStateView } from '../src/client/api.ts'
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

describe('target session archive API', () => {
  const result = {
    targetId: 'group 1',
    threadKey: 'group:group 1',
    workspace: { path: 'E:/state/workspaces/group-1', title: '钉钉 · 项目群' },
    archived: ['session-1'],
    alreadyArchived: ['session-2'],
    refused: [],
    missing: [],
    failed: [],
    replySessionRotated: true,
    nextReplySessionId: 'session-3',
    stopActivity: true,
    truncated: false,
    candidateCount: 2,
  }

  it('posts the stop flag to the encoded archive route and returns the result', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(result), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(archiveTargetSessions('group 1', { stopActivity: true })).resolves.toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/whale-chan/api/targets/group%201/archive-sessions')
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        accept: 'application/json',
        [API_REQUEST_HEADER]: API_REQUEST_HEADER_VALUE,
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ stopActivity: true }),
    })
  })

  it('sends an empty confirmation body when no options are given', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(result), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await archiveTargetSessions('group-1')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBe('{}')
  })

  it('exposes the per-conversation refusal code on ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { code: 'per_conversation_workspace', message: 'no single workspace' },
            }),
            { status: 400 },
          ),
      ),
    )
    const failure = await archiveTargetSessions('at-me').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 400, code: 'per_conversation_workspace' })
  })

  it('exposes unknown_target and state_unavailable failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: { code: 'unknown_target', message: 'gone' } }), {
            status: 404,
          }),
      ),
    )
    await expect(archiveTargetSessions('missing')).rejects.toMatchObject({
      status: 404,
      code: 'unknown_target',
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: { code: 'state_unavailable', message: 'starting' } }), {
            status: 503,
          }),
      ),
    )
    await expect(archiveTargetSessions('group-1')).rejects.toMatchObject({
      status: 503,
      code: 'state_unavailable',
    })
  })
})
