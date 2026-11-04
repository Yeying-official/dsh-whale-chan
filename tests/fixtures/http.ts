/**
 * HTTP test harness: a real `Runtime` over a temporary state directory, a real
 * loopback server, a deterministic clock and a fake channel.
 *
 * The tests exercise the same objects production uses, so the lock, the
 * database and the settings service are not mocked away.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ChannelPort } from '../../src/app/channel-port.ts'
import { createHttpHandler, httpDeps } from '../../src/app/http.ts'
import { Runtime, type RuntimeOverrides } from '../../src/app/runtime.ts'
import { API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE } from '../../src/shared/api.ts'
import type { TargetKind } from '../../src/shared/limits.ts'
import type { TargetCandidate, TargetDraft, TargetValidation } from '../../src/shared/models.ts'
import { createClock, type MutableClock } from './domain.ts'

/** A channel double that records calls and can fail on demand. */
export interface FakeChannel extends ChannelPort {
  readonly discoveries: { kind: TargetKind; query?: string }[]
  readonly validations: TargetDraft[]
  fail: boolean
}

export function fakeChannel(candidates: readonly TargetCandidate[] = []): FakeChannel {
  const discoveries: { kind: TargetKind; query?: string }[] = []
  const validations: TargetDraft[] = []
  const channel: FakeChannel = {
    discoveries,
    validations,
    fail: false,
    async discover(kind, query) {
      if (channel.fail) throw new Error('dws is not available')
      discoveries.push(query === undefined ? { kind } : { kind, query })
      return candidates
    },
    async validate(target) {
      if (channel.fail) throw new Error('dws is not available')
      validations.push(target)
      return target.id === 'bad'
        ? ({ target, valid: false, error: 'target not found' } satisfies TargetValidation)
        : ({ target, valid: true } satisfies TargetValidation)
    },
  }
  return channel
}

export interface TestServerOptions {
  readonly stateDir: string
  readonly channel?: ChannelPort
  readonly clock?: MutableClock
  /** Test seams for host capabilities the API-only runtime would not compose. */
  readonly overrides?: RuntimeOverrides
}

export interface TestServer {
  readonly runtime: Runtime
  readonly baseUrl: string
  readonly clock: MutableClock
  readonly channel: ChannelPort | undefined
  close(): Promise<void>
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  return (server.address() as AddressInfo).port
}

/** Start one runtime and one HTTP server; `close` stops both. */
export async function startTestServer(options: TestServerOptions): Promise<TestServer> {
  const clock = options.clock ?? createClock()
  const runtime = new Runtime(
    { stateDir: options.stateDir, logLevel: 'info' },
    {
      now: () => clock.now(),
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    },
  )
  try {
    await runtime.ready
  } catch (error) {
    await runtime.stop()
    throw error
  }
  const server = createServer(createHttpHandler(httpDeps(runtime)))
  const port = await listen(server)
  let closed = false
  return {
    runtime,
    baseUrl: `http://127.0.0.1:${port}`,
    clock,
    channel: options.channel,
    async close() {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await runtime.stop()
    },
  }
}

/** Same-origin management request; every test uses the guard header by default. */
export function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  authenticated = true,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (authenticated) headers.set(API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE)
  return fetch(`${baseUrl}${path}`, { ...init, headers })
}

/** A JSON request body with the method and content type the API expects. */
export function jsonBody(method: 'POST' | 'PUT', value: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }
}
