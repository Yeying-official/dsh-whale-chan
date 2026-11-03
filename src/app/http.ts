/**
 * Loopback management HTTP routes.
 *
 * Every management request must carry `x-whale-chan-request: 1`: a cross-origin
 * page cannot set that header without a CORS preflight, and this server
 * deliberately sends no `Access-Control-Allow-*` response headers. No `OPTIONS`
 * handler is provided, so cross-origin preflight fails closed. The header is a
 * same-origin guard, not authentication against other local processes.
 *
 * The router is a thin translation layer: it validates path/query/body shapes,
 * calls one domain command or one view builder, and maps failures onto stable
 * status codes. It never writes SQL and never builds a wire object by hand.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { UserError, type UserErrorCategory } from '../core/index.ts'
import { API_PREFIX, API_REQUEST_HEADER, API_REQUEST_HEADER_VALUE } from '../shared/api.ts'
import type { MonitorSettings } from '../shared/settings.ts'
import { SettingsBlockSchema } from '../shared/settings.ts'
import type { TargetCandidate, TargetDraft, TargetValidation } from '../shared/models.ts'
import type { ChannelPort } from './channel-port.ts'
import type { Effects } from './effects.ts'
import type { Runtime } from './runtime.ts'
import { SettingsConflictError, SettingsService, SettingsValueError } from './settings.ts'
import type { Store } from './store.ts'
import {
  auditView,
  domainTaskStatus,
  healthView,
  isTargetKind,
  overviewView,
  stateView,
  taskDetailView,
  tasksView,
  targetsView,
  threadView,
  threadsView,
  toApprovalView,
  toTaskView,
} from './views.ts'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
const MAX_BODY_BYTES = 128 * 1024
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

interface ErrorBody {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly actualRevision?: number
    readonly issues?: readonly { path: string; message: string }[]
    readonly values?: Readonly<Record<string, string>>
  }
}

/** Everything the routes may use. `src/index.ts` supplies a lazy view of `Runtime`. */
export interface HttpDeps {
  readonly runtime: Runtime
  readonly settings: SettingsService
  readonly store: Store
  readonly engine: Runtime['engine']
  readonly effects: Effects
  readonly clock: Runtime['clock']
  /** Absent in WS5a: discovery and validation answer 503. */
  readonly channel?: ChannelPort
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

function methodAllowed(request: IncomingMessage, response: ServerResponse, method: string): boolean {
  if (request.method === method) return true
  sendJson(response, 405, failure(405, 'method_not_allowed', `Use ${method} for this route`), { allow: method })
  return false
}

function decodeParam(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    throw new HttpError(400, 'invalid_path', 'The path parameter is malformed')
  }
}

function now(deps: HttpDeps): string {
  return deps.clock.now().toISOString()
}

/** Parse one bounded integer query parameter; anything else is a 400. */
function integerParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, 'invalid_query', `The ${name} query parameter must be a non-negative integer`)
  }
  const value = Number(raw)
  if (value < min || value > max) {
    throw new HttpError(400, 'invalid_query', `The ${name} query parameter must be between ${min} and ${max}`)
  }
  return value
}

function optionalString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_body', `The ${key} field must be a string`)
  return value
}

async function optionalBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const body = await readJsonBody(request)
  if (body === undefined) return undefined
  if (!isRecord(body)) throw new HttpError(400, 'invalid_body', 'The request body must be a JSON object')
  return body
}

async function requiredBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await optionalBody(request)
  if (body === undefined) throw new HttpError(400, 'invalid_body', 'This route needs a JSON object body')
  return body
}

/** Expand a leading `~` against the current home directory. */
function expandHome(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/** Whether a task id is safe to use as one path segment. */
function safeSegment(value: string): boolean {
  if (value.length === 0 || value === '.' || value === '..') return false
  return !/[/\\\0]/.test(value) && !value.includes('..')
}

/**
 * The workspace a task action runs in.
 *
 * An explicit directory must expand to an absolute path; it wins because it is
 * the person's escape hatch. Otherwise the task runs in the workspace of its
 * own conversation, the same directory its replier uses. The assignment stores
 * that concrete path, so a later settings change cannot move a running task.
 */
function workspaceFor(deps: HttpDeps, taskId: string, requested: string | undefined): string {
  const approved = (requested ?? '').trim()
  if (approved.length > 0) {
    const expanded = expandHome(approved)
    if (!isAbsolute(expanded)) throw new HttpError(400, 'invalidWorkspace', 'The workspace must be an absolute path')
    return resolve(expanded)
  }
  const task = deps.engine.task(taskId)
  if (task !== undefined) return deps.runtime.taskWorkspace(task).path
  // Unreachable through the routes (every caller resolves the task first), but
  // a task without a conversation row still needs a predictable local default.
  if (!safeSegment(taskId)) {
    throw new HttpError(400, 'invalid_task', 'The task id cannot be used as a workspace directory name')
  }
  return join(deps.runtime.info().stateDir, 'tasks', taskId)
}

function requireTask(deps: HttpDeps, id: string): void {
  if (deps.engine.task(id) === undefined) throw new HttpError(404, 'unknown_task', 'Unknown task')
}

async function approveTask(deps: HttpDeps, request: IncomingMessage, response: ServerResponse, id: string) {
  requireTask(deps, id)
  const body = await optionalBody(request)
  const approval = deps.store.approvals.byTaskId(id)
  const approvalId = optionalString(body, 'approvalId')
  if (approvalId !== undefined && (approval === undefined || approvalId !== approval.id)) {
    throw new HttpError(400, 'approval_mismatch', 'The approval does not belong to this task')
  }
  const workspace = workspaceFor(deps, id, optionalString(body, 'workspace'))
  const result = deps.engine.approveTask(id, {
    by: 'owner',
    at: now(deps),
    workspace,
    note: optionalString(body, 'note'),
  })
  // The command committed; the executor is woken through the durable queue.
  deps.effects.enqueue('launch', id, { assignmentId: result.assignment.id, workspace })
  sendJson(response, 200, { task: toTaskView(result.task), approval: toApprovalView(result.approval) })
}

async function rejectTask(deps: HttpDeps, request: IncomingMessage, response: ServerResponse, id: string) {
  requireTask(deps, id)
  const body = await optionalBody(request)
  const result = deps.engine.rejectTask(id, {
    by: 'owner',
    at: now(deps),
    note: optionalString(body, 'reason'),
  })
  sendJson(response, 200, { task: toTaskView(result.task), approval: toApprovalView(result.approval) })
}

async function cancelTask(deps: HttpDeps, request: IncomingMessage, response: ServerResponse, id: string) {
  requireTask(deps, id)
  const body = await optionalBody(request)
  const task = deps.engine.cancelTask(id, {
    by: 'owner',
    at: now(deps),
    reason: optionalString(body, 'reason'),
  })
  sendJson(response, 200, { task: toTaskView(task) })
}

async function retryTask(deps: HttpDeps, request: IncomingMessage, response: ServerResponse, id: string) {
  requireTask(deps, id)
  const body = await optionalBody(request)
  const workspace = workspaceFor(deps, id, optionalString(body, 'workspace'))
  const result = deps.engine.retryTask(id, {
    by: 'owner',
    at: now(deps),
    workspace,
    note: optionalString(body, 'note'),
  })
  deps.effects.enqueue('launch', id, { assignmentId: result.assignment.id, workspace })
  sendJson(response, 200, { task: toTaskView(result.task) })
}

async function pauseMonitor(deps: HttpDeps, request: IncomingMessage, response: ServerResponse) {
  const body = await requiredBody(request)
  if (typeof body['paused'] !== 'boolean') {
    throw new HttpError(400, 'invalid_body', 'The paused field must be a boolean')
  }
  const result = deps.settings.patchInternal('monitor', { paused: body['paused'] })
  sendJson(response, 200, { paused: (result.value as MonitorSettings).paused })
}

function channelOrFail(deps: HttpDeps): ChannelPort {
  if (!deps.channel) {
    throw new HttpError(503, 'channel_unavailable', 'The DingTalk channel is not attached in this build')
  }
  return deps.channel
}

async function discoverTargets(deps: HttpDeps, request: IncomingMessage, response: ServerResponse) {
  const channel = channelOrFail(deps)
  const body = await requiredBody(request)
  const kind = body['kind']
  if (!isTargetKind(kind)) {
    throw new HttpError(400, 'invalid_target', 'The kind field must be one of at-me, group or dm')
  }
  const query = optionalString(body, 'query')
  let candidates: readonly TargetCandidate[]
  try {
    candidates = await channel.discover(kind, query)
  } catch {
    // Channel failures are user-correctable or environmental; never leak internals.
    throw new HttpError(400, 'channel_error', 'The channel could not discover targets')
  }
  sendJson(response, 200, { candidates })
}

async function validateTargets(deps: HttpDeps, request: IncomingMessage, response: ServerResponse) {
  const channel = channelOrFail(deps)
  const body = await requiredBody(request)
  const raw = body['targets']
  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_targets', 'The targets field must be an array')
  const drafts: TargetDraft[] = raw.map((item) => {
    if (!isRecord(item) || !isTargetKind(item['kind'])) {
      throw new HttpError(400, 'invalid_targets', 'Every target needs a known kind')
    }
    const id = item['id']
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new HttpError(400, 'invalid_targets', 'Every target needs a non-empty id')
    }
    const label = item['label']
    if (label !== undefined && typeof label !== 'string') {
      throw new HttpError(400, 'invalid_targets', 'The label field must be a string')
    }
    return { kind: item['kind'], id: id.trim(), ...(label === undefined ? {} : { label }) }
  })
  let results: readonly TargetValidation[]
  try {
    results = await Promise.all(drafts.map((draft) => channel.validate(draft)))
  } catch {
    throw new HttpError(400, 'channel_error', 'The channel could not validate the targets')
  }
  sendJson(response, 200, { results })
}

async function writeSettings(deps: HttpDeps, request: IncomingMessage, response: ServerResponse, blockText: string) {
  const block = SettingsBlockSchema.safeParse(decodeParam(blockText))
  if (!block.success) throw new HttpError(404, 'unknown_block', 'Unknown settings block')
  const body = await requiredBody(request)
  if (typeof body['revision'] !== 'number' || !Number.isInteger(body['revision']) || body['revision'] < 0) {
    throw new HttpError(400, 'revision_required', 'A non-negative integer revision is required')
  }
  if (!isRecord(body['value'])) {
    throw new HttpError(400, 'invalid_settings', 'The value must be an object of settings fields')
  }
  const result = deps.settings.update(block.data, body['value'], body['revision'])
  sendJson(response, 200, result)
}

function listQuery(url: URL): { offset: number; limit: number } {
  return {
    offset: integerParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
    limit: integerParam(url, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
  }
}

/**
 * The HTTP status one user-error category maps to.
 *
 * `missing` is an unknown record, `invalid` is a value the caller can correct,
 * and `refused` is a state conflict. Exported so the guard test can pin it.
 */
export function userErrorStatus(category: UserErrorCategory): number {
  return category === 'missing' ? 404 : category === 'invalid' ? 400 : 409
}

/** Route one authenticated request. Throws `HttpError` for every expected failure. */
async function route(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  path: string,
): Promise<void> {
  const segments = path.split('/')

  if (segments.length === 1) {
    const name = segments[0] as string
    if (name === 'state') {
      if (!methodAllowed(request, response, 'GET')) return
      sendJson(response, 200, stateView(deps.runtime))
      return
    }
    if (name === 'overview') {
      if (!methodAllowed(request, response, 'GET')) return
      sendJson(response, 200, overviewView(deps.runtime.viewContext()))
      return
    }
    if (name === 'targets') {
      if (!methodAllowed(request, response, 'GET')) return
      sendJson(
        response,
        200,
        targetsView(deps.settings, (target) => deps.runtime.targetWorkspace(target)),
      )
      return
    }
    if (name === 'threads') {
      if (!methodAllowed(request, response, 'GET')) return
      const { offset, limit } = listQuery(url)
      sendJson(response, 200, threadsView(deps.store, { offset, limit }))
      return
    }
    if (name === 'tasks') {
      if (!methodAllowed(request, response, 'GET')) return
      const { offset, limit } = listQuery(url)
      const statusText = url.searchParams.get('status')
      const status = statusText === null ? undefined : domainTaskStatus(statusText)
      if (statusText !== null && status === undefined) {
        throw new HttpError(400, 'invalid_query', 'The status query parameter is not a known task status')
      }
      sendJson(response, 200, tasksView(deps.store, { offset, limit, status }))
      return
    }
    if (name === 'settings') {
      if (!methodAllowed(request, response, 'GET')) return
      sendJson(response, 200, deps.settings.view())
      return
    }
    if (name === 'persona') {
      if (!methodAllowed(request, response, 'GET')) return
      sendJson(response, 200, deps.settings.persona())
      return
    }
    if (name === 'health') {
      if (!methodAllowed(request, response, 'GET')) return
      sendJson(response, 200, healthView(deps.runtime.viewContext()))
      return
    }
    if (name === 'audit') {
      if (!methodAllowed(request, response, 'GET')) return
      const { offset, limit } = listQuery(url)
      sendJson(response, 200, auditView(deps.store, { offset, limit }))
      return
    }
  }

  if (segments[0] === 'monitor' && segments[1] === 'pause' && segments.length === 2) {
    if (!methodAllowed(request, response, 'POST')) return
    await pauseMonitor(deps, request, response)
    return
  }

  if (segments[0] === 'targets' && segments.length === 2) {
    if (segments[1] === 'discover') {
      if (!methodAllowed(request, response, 'POST')) return
      await discoverTargets(deps, request, response)
      return
    }
    if (segments[1] === 'validate') {
      if (!methodAllowed(request, response, 'POST')) return
      await validateTargets(deps, request, response)
      return
    }
  }

  if (segments[0] === 'threads' && segments.length === 2) {
    if (!methodAllowed(request, response, 'GET')) return
    const before = url.searchParams.get('before') ?? undefined
    if (before !== undefined && !Number.isFinite(Date.parse(before))) {
      throw new HttpError(400, 'invalid_query', 'The before query parameter must be an ISO-8601 instant')
    }
    const limit = integerParam(url, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT)
    const detail = threadView(deps.store, decodeParam(segments[1] as string), { before, limit })
    if (!detail) throw new HttpError(404, 'unknown_thread', 'Unknown thread')
    sendJson(response, 200, detail)
    return
  }

  if (segments[0] === 'tasks' && segments.length === 2) {
    if (!methodAllowed(request, response, 'GET')) return
    const detail = taskDetailView(deps.store, decodeParam(segments[1] as string))
    if (!detail) throw new HttpError(404, 'unknown_task', 'Unknown task')
    sendJson(response, 200, detail)
    return
  }

  if (segments[0] === 'tasks' && segments.length === 3) {
    const id = decodeParam(segments[1] as string)
    const action = segments[2]
    if (action === 'approve') {
      if (!methodAllowed(request, response, 'POST')) return
      await approveTask(deps, request, response, id)
      return
    }
    if (action === 'reject') {
      if (!methodAllowed(request, response, 'POST')) return
      await rejectTask(deps, request, response, id)
      return
    }
    if (action === 'cancel') {
      if (!methodAllowed(request, response, 'POST')) return
      await cancelTask(deps, request, response, id)
      return
    }
    if (action === 'retry') {
      if (!methodAllowed(request, response, 'POST')) return
      await retryTask(deps, request, response, id)
      return
    }
  }

  if (segments[0] === 'settings' && segments.length === 2) {
    if (!methodAllowed(request, response, 'PUT')) return
    await writeSettings(deps, request, response, segments[1] as string)
    return
  }

  throw new HttpError(404, 'not_found', 'Unknown management API route')
}

/** The handler used by the mounted prefix route. Exported for direct HTTP tests. */
export function createHttpHandler(deps: HttpDeps) {
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
      await waitReady(deps.runtime)
      await route(deps, request, response, url, url.pathname.slice(API_PREFIX.length))
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
      if (error instanceof UserError) {
        // The category decides the status: unknown records are 404, a value
        // the caller can correct is 400, and a state conflict is 409.
        const status = userErrorStatus(error.category)
        sendJson(response, status, failure(status, error.code, error.message, { values: error.values }))
        return
      }
      // Do not leak paths or stacks from unexpected failures.
      sendJson(response, 500, failure(500, 'internal_error', 'The management request failed'))
    }
  }
}

/**
 * A lazy view of the runtime.
 *
 * The handler is mounted before startup settles so it can answer 503 while the
 * database is still opening; each getter therefore resolves only when a route
 * actually reads it, after `waitReady`.
 */
export function httpDeps(runtime: Runtime): HttpDeps {
  return {
    runtime,
    get settings() {
      return runtime.settings
    },
    get store() {
      return runtime.store
    },
    get engine() {
      return runtime.engine
    },
    get effects() {
      return runtime.effects
    },
    get clock() {
      return runtime.clock
    },
    get channel() {
      return runtime.channel
    },
  }
}

/** Mount the management prefix on DSH's web server and return its disposer. */
export function registerHttp(ctx: Context, runtime: Runtime): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/whale-chan',
    handler: createHttpHandler(httpDeps(runtime)),
  })
}
