/**
 * Loopback management HTTP routes.
 *
 * WS0 mounts the state route plus in-memory settings/persona contract canaries.
 * The rest of the frozen contract is implemented in later workstreams. Every
 * management request must carry `x-whale-chan-request: 1`: a cross-origin page
 * cannot set that header without a CORS preflight, and this server deliberately
 * sends no `Access-Control-Allow-*` response headers. No `OPTIONS` handler is
 * provided, so cross-origin preflight fails closed. The header is a same-origin
 * guard, not authentication against other local processes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_PREFIX, API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE } from '../shared/api.ts'
import { SettingsBlockSchema } from '../shared/settings.ts'
import type { Runtime } from './runtime.ts'
import { SettingsConflictError, SettingsState, SettingsValueError } from './settings.ts'
import { stateView } from './views.ts'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
const MAX_BODY_BYTES = 128 * 1024

interface ErrorBody {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly actualRevision?: number
    readonly issues?: readonly { path: string; message: string }[]
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
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

function failure(status: number, code: string, message: string, extra: Partial<ErrorBody['error']> = {}): ErrorBody {
  return { ok: false, error: { code, message, ...extra } }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', 'The request body is too large')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function waitReady(runtime: Pick<Runtime, 'ready'>): Promise<void> {
  try {
    await runtime.ready
  } catch {
    throw new HttpError(503, 'state_unavailable', 'The assistant runtime is not ready')
  }
}

/** The handler used by the mounted prefix route. Exported for direct HTTP tests. */
export function createHttpHandler(runtime: Pick<Runtime, 'ready' | 'info'>, settings = new SettingsState()) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith(API_PREFIX)) {
        sendJson(response, 404, failure(404, 'not_found', 'Unknown management API route'))
        return
      }

      // Checked before routing or reading the body, so an unauthenticated
      // request cannot cause body parsing and cannot receive stateDir.
      if (request.headers[API_REQUEST_HEADER] !== API_REQUEST_HEADER_VALUE) {
        sendJson(response, 403, failure(403, 'forbidden', 'Management requests require the same-origin header'))
        return
      }

      const route = url.pathname.slice(API_PREFIX.length)
      if (route === 'state') {
        if (request.method !== 'GET') {
          sendJson(response, 405, failure(405, 'method_not_allowed', 'Use GET for this route'), { allow: 'GET' })
          return
        }
        await waitReady(runtime)
        sendJson(response, 200, stateView(runtime))
        return
      }

      if (route === 'settings') {
        if (request.method !== 'GET') {
          sendJson(response, 405, failure(405, 'method_not_allowed', 'Use GET for this route'), { allow: 'GET' })
          return
        }
        await waitReady(runtime)
        sendJson(response, 200, settings.view())
        return
      }

      if (route.startsWith('settings/')) {
        if (request.method !== 'PUT') {
          sendJson(response, 405, failure(405, 'method_not_allowed', 'Use PUT for this route'), { allow: 'PUT' })
          return
        }
        await waitReady(runtime)
        let blockText: string
        try {
          blockText = decodeURIComponent(route.slice('settings/'.length))
        } catch {
          throw new HttpError(400, 'invalid_block', 'The settings block path is malformed')
        }
        const block = SettingsBlockSchema.safeParse(blockText)
        if (!block.success) throw new HttpError(404, 'unknown_block', 'Unknown settings block')

        const body = await readJsonBody(request)
        if (!isRecord(body)) throw new HttpError(400, 'invalid_body', 'A settings write needs a JSON object body')
        if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 0) {
          throw new HttpError(400, 'revision_required', 'A non-negative integer revision is required')
        }
        if (!isRecord(body.value)) {
          throw new HttpError(400, 'invalid_settings', 'The value must be an object of settings fields')
        }

        const result = settings.update(block.data, body.value, body.revision)
        sendJson(response, 200, result)
        return
      }

      if (route === 'persona') {
        if (request.method !== 'GET') {
          sendJson(response, 405, failure(405, 'method_not_allowed', 'Use GET for this route'), { allow: 'GET' })
          return
        }
        await waitReady(runtime)
        sendJson(response, 200, settings.persona())
        return
      }

      sendJson(response, 404, failure(404, 'not_found', 'Unknown management API route'))
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, failure(error.status, error.code, error.message))
        return
      }
      if (error instanceof SettingsConflictError) {
        sendJson(response, 409, failure(409, error.code, error.message, { actualRevision: error.actualRevision }))
        return
      }
      if (error instanceof SettingsValueError) {
        sendJson(response, 400, failure(400, error.code, error.message, { issues: error.issues }))
        return
      }
      // Do not leak paths or stacks from unexpected failures.
      sendJson(response, 500, failure(500, 'internal_error', 'The management request failed'))
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
