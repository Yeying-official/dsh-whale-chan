import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHttpHandler, registerHttp } from '../src/app/http.ts'
import { Runtime, resolveStateDir } from '../src/app/runtime.ts'
import { stateView } from '../src/app/views.ts'
import { API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE } from '../src/shared/api.ts'
import { PLUGIN_NAME, PLUGIN_VERSION } from '../src/shared/limits.ts'
import { SETTINGS_BLOCKS, SETTINGS_DEFAULTS } from '../src/shared/settings.ts'

const servers = new Set<Server>()
let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-state-'))
})

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
  servers.clear()
  await rm(root, { recursive: true, force: true })
})

function runtimeAt(stateDir: string, now = new Date('2026-11-02T00:00:00.000Z')): Runtime {
  return new Runtime({ stateDir, logLevel: 'info' }, { now: () => now })
}

async function serve(runtime: Runtime): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(createHttpHandler(runtime))
  servers.add(server)
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      servers.delete(server)
    },
  }
}

function request(baseUrl: string, path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (authenticated) headers.set(API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE)
  return fetch(`${baseUrl}${path}`, { ...init, headers })
}

function writeJson(value: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }
}

describe('runtime state directory', () => {
  it('creates the directory, exposes a stable startedAt and closes idempotently', async () => {
    const stateDir = join(root, 'whale-chan')
    const now = new Date('2026-11-02T03:04:05.000Z')
    const runtime = runtimeAt(stateDir, now)
    await runtime.ready

    const info = runtime.info()
    expect(info.name).toBe(PLUGIN_NAME)
    expect(info.version).toBe(PLUGIN_VERSION)
    expect(info.stateDir).toBe(resolve(stateDir))
    expect(info.startedAt).toBe('2026-11-02T03:04:05.000Z')
    expect((await stat(runtime.stateDir)).isDirectory()).toBe(true)

    await runtime.stop()
    await runtime.stop()
    expect(runtime.closed).toBe(true)
  })

  it('expands every home form, accepts absolute paths and rejects relative paths', () => {
    const home = join(root, 'home')
    expect(resolveStateDir('~', home)).toBe(resolve(home))
    expect(resolveStateDir('~/state', home)).toBe(resolve(home, 'state'))
    expect(resolveStateDir('~\\state', home)).toBe(resolve(home, 'state'))
    expect(resolveStateDir(join(root, 'absolute-state'), home)).toBe(resolve(join(root, 'absolute-state')))
    expect(() => resolveStateDir('relative-state', home)).toThrow(/absolute path or start with ~/)
    expect(() => resolveStateDir('   ', home)).toThrow(/must not be empty/)
  })
})

describe('GET /whale-chan/api/state', () => {
  it('returns exactly the state view of the running runtime', async () => {
    const runtime = runtimeAt(join(root, 'state'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await request(baseUrl, '/whale-chan/api/state')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = (await response.json()) as unknown
      expect(body).toEqual(stateView(runtime))
      expect(body).toMatchObject({
        ok: true,
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        stateDir: resolve(join(root, 'state')),
        startedAt: runtime.startedAt,
      })
    } finally {
      await close()
    }
  })

  it('rejects a request without the same-origin header without leaking stateDir', async () => {
    const stateDir = join(root, 'state-forbidden')
    const runtime = runtimeAt(stateDir)
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await request(baseUrl, '/whale-chan/api/state', {}, false)
      expect(response.status).toBe(403)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      const text = await response.text()
      expect(text).toContain('forbidden')
      expect(text).not.toContain('stateDir')
      expect(text).not.toContain(resolve(stateDir))
    } finally {
      await close()
    }
  })

  it('fails cross-origin preflight closed', async () => {
    const runtime = runtimeAt(join(root, 'state-preflight'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await request(baseUrl, '/whale-chan/api/state', { method: 'OPTIONS' }, false)
      expect(response.status).toBe(403)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(response.headers.get('access-control-allow-headers')).toBeNull()
    } finally {
      await close()
    }
  })

  it('rejects the wrong method with 405 and an Allow header', async () => {
    const runtime = runtimeAt(join(root, 'state-method'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await request(baseUrl, '/whale-chan/api/state', { method: 'POST' })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'method_not_allowed' } })
    } finally {
      await close()
    }
  })

  it('returns 404 for an unknown route', async () => {
    const runtime = runtimeAt(join(root, 'state-missing'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await request(baseUrl, '/whale-chan/api/unknown')
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
    } finally {
      await close()
    }
  })

  it('returns a structured 503 when startup failed', async () => {
    const stateDir = join(root, 'state-is-a-file')
    await writeFile(stateDir, 'not a directory', 'utf8')
    const runtime = runtimeAt(stateDir)
    await runtime.ready.catch(() => undefined)
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await request(baseUrl, '/whale-chan/api/state')
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'state_unavailable' } })
    } finally {
      await close()
    }
  })
})

describe('settings and persona contract routes', () => {
  it('returns SettingsView with every block and its revision', async () => {
    const runtime = runtimeAt(join(root, 'settings-view'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await request(baseUrl, '/whale-chan/api/settings')
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        revision: number
        blocks: Record<string, { block: string; value: unknown; revision: number }>
      }
      expect(body.revision).toBe(0)
      expect(Object.keys(body.blocks).sort()).toEqual([...SETTINGS_BLOCKS].sort())
      for (const block of SETTINGS_BLOCKS) {
        expect(body.blocks[block]).toEqual({
          block,
          value: SETTINGS_DEFAULTS[block],
          revision: 0,
        })
      }
    } finally {
      await close()
    }
  })

  it('requires a revision and reports a stale revision as a conflict', async () => {
    const runtime = runtimeAt(join(root, 'settings-revision'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const missing = await request(baseUrl, '/whale-chan/api/settings/monitor', {
        ...writeJson({ value: { paused: true } }),
      })
      expect(missing.status).toBe(400)
      expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'revision_required' } })

      const written = await request(
        baseUrl,
        '/whale-chan/api/settings/monitor',
        writeJson({ value: { paused: true }, revision: 0 }),
      )
      expect(written.status).toBe(200)
      expect(await written.json()).toMatchObject({ block: 'monitor', revision: 1, value: { paused: true } })

      const stale = await request(
        baseUrl,
        '/whale-chan/api/settings/monitor',
        writeJson({ value: { paused: false }, revision: 0 }),
      )
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ ok: false, error: { code: 'settings_conflict', actualRevision: 1 } })

      const view = (await (await request(baseUrl, '/whale-chan/api/settings')).json()) as {
        revision: number
        blocks: Record<string, { revision: number; value: { paused: boolean } }>
      }
      expect(view.revision).toBe(1)
      expect(view.blocks.monitor?.revision).toBe(1)
      expect(view.blocks.monitor?.value.paused).toBe(true)
      expect(view.blocks.persona?.revision).toBe(0)
    } finally {
      await close()
    }
  })

  it('keeps persona read-only through GET persona and writable through settings', async () => {
    const runtime = runtimeAt(join(root, 'persona-view'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const initial = (await (await request(baseUrl, '/whale-chan/api/persona')).json()) as {
        persona: { name: string }
        revision: number
      }
      expect(initial).toMatchObject({ persona: { name: '鲸鱼酱' }, revision: 0 })

      const readOnly = await request(baseUrl, '/whale-chan/api/persona', {
        ...writeJson({ value: { persona: initial.persona }, revision: 0 }),
      })
      expect(readOnly.status).toBe(405)

      const written = await request(
        baseUrl,
        '/whale-chan/api/settings/persona',
        writeJson({ value: { name: '小鲸鱼' }, revision: 0 }),
      )
      expect(written.status).toBe(200)
      const after = (await (await request(baseUrl, '/whale-chan/api/persona')).json()) as {
        persona: { name: string }
        revision: number
      }
      expect(after).toMatchObject({ persona: { name: '小鲸鱼' }, revision: 1 })
    } finally {
      await close()
    }
  })
})

describe('route registration', () => {
  it('mounts one prefix route and returns an idempotent disposer', async () => {
    const routes: unknown[] = []
    let disposed = 0
    const ctx = {
      webServer: {
        register(route: unknown) {
          routes.push(route)
          return () => {
            disposed += 1
          }
        },
      },
    } as unknown as Context
    const runtime = runtimeAt(join(root, 'state-register'))
    await runtime.ready
    const dispose = registerHttp(ctx, runtime)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/whale-chan' })
    expect(typeof (routes[0] as { handler?: unknown }).handler).toBe('function')
    dispose()
    expect(disposed).toBe(1)
  })
})
