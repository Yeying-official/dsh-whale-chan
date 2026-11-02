/**
 * Loopback management HTTP routes.
 *
 * WS0 mounts a single read-only endpoint under `/whale-chan/api/`; the rest of
 * the frozen contract is implemented in later workstreams. Route errors use a
 * small structured envelope so the panel can distinguish an unreachable host
 * from a host that is starting or failed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_PREFIX } from '../shared/api.ts'
import type { Runtime } from './runtime.ts'
import { stateView } from './views.ts'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

interface ErrorBody {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders })
  response.end(JSON.stringify(value))
}

function failure(status: number, code: string, message: string): ErrorBody {
  return { ok: false, error: { code, message } }
}

/** The handler used by the mounted prefix route. Exported for direct HTTP tests. */
export function createHttpHandler(runtime: Pick<Runtime, 'ready' | 'info'>) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith(API_PREFIX)) {
        sendJson(response, 404, failure(404, 'not_found', 'Unknown management API route'))
        return
      }

      const route = url.pathname.slice(API_PREFIX.length)
      if (route === 'state') {
        if (request.method !== 'GET') {
          sendJson(response, 405, failure(405, 'method_not_allowed', 'Use GET for this route'), { allow: 'GET' })
          return
        }
        await runtime.ready
        sendJson(response, 200, stateView(runtime))
        return
      }

      sendJson(response, 404, failure(404, 'not_found', 'Unknown management API route'))
    } catch {
      // The startup failure is already owned by the plugin fiber. The response
      // deliberately stays generic: no local path or stack crosses the wire.
      sendJson(response, 503, failure(503, 'state_unavailable', 'The assistant runtime is not ready'))
    }
  }
}

/** Mount the management prefix on DSH's web server and return its disposer. */
export function registerHttp(ctx: Context, runtime: Runtime): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/whale-chan',
    handler: createHttpHandler(runtime),
  })
}
