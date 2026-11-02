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
import { PLUGIN_NAME, PLUGIN_VERSION } from '../src/shared/limits.ts'

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

  it('expands ~ and resolves relative paths', () => {
    const home = join(root, 'home')
    expect(resolveStateDir('~/state', home)).toBe(resolve(home, 'state'))
    expect(resolveStateDir('~\\state', home)).toBe(resolve(home, 'state'))
    expect(resolveStateDir('relative-state', home)).toBe(resolve('relative-state'))
    expect(() => resolveStateDir('   ', home)).toThrow(/must not be empty/)
  })
})

describe('GET /whale-chan/api/state', () => {
  it('returns exactly the state view of the running runtime', async () => {
    const runtime = runtimeAt(join(root, 'state'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await fetch(`${baseUrl}/whale-chan/api/state`)
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

  it('rejects the wrong method with 405 and an Allow header', async () => {
    const runtime = runtimeAt(join(root, 'state-method'))
    await runtime.ready
    const { baseUrl, close } = await serve(runtime)
    try {
      const response = await fetch(`${baseUrl}/whale-chan/api/state`, { method: 'POST' })
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
      const response = await fetch(`${baseUrl}/whale-chan/api/unknown`)
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
      const response = await fetch(`${baseUrl}/whale-chan/api/state`)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'state_unavailable' } })
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
