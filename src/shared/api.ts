/**
 * Management API contract, frozen before the implementing routes exist.
 *
 * `ApiContract` is the type-level source of method, path, request and response
 * for every endpoint. `API_ROUTES` is the runtime table used by tests and by a
 * future router; the contract test proves the two agree and that no route is
 * duplicated. WS0 implements the state route plus in-memory settings/persona
 * contract canaries; the remaining routes are frozen for later workstreams.
 */
import type {
  ApproveTaskRequest,
  ArchiveTargetSessionsRequest,
  ArchiveTargetSessionsResult,
  AuditPage,
  DiscoverTargetsRequest,
  DiscoverTargetsResult,
  Health,
  MonitorPauseResult,
  Overview,
  PersonaView,
  SettingsUpdateRequest,
  SettingsUpdateResult,
  SettingsView,
  StateView,
  TargetsView,
  TaskActionRequest,
  TaskDetail,
  TasksPage,
  ThreadDetail,
  ThreadsPage,
  ValidateTargetsRequest,
  ValidateTargetsResult,
} from './models.ts'
import type { TargetKind } from './limits.ts'
import type { SettingsBlock } from './settings.ts'

export const API_PREFIX = '/whale-chan/api/' as const

/** Custom header required on every management request. A cross-origin page cannot
 * set it without a successful CORS preflight, and this server sends no CORS
 * allow headers, so it also acts as a same-origin guard. */
export const API_REQUEST_HEADER = 'x-whale-chan-request' as const
export const API_REQUEST_HEADER_VALUE = '1' as const

export type HttpMethod = 'GET' | 'POST' | 'PUT'

export interface ThreadsQuery {
  readonly offset?: number
  readonly limit?: number
}

export interface ThreadQuery {
  readonly before?: string
  readonly limit?: number
}

export interface TasksQuery {
  readonly status?: string
  readonly offset?: number
  readonly limit?: number
}

export interface AuditQuery {
  readonly offset?: number
  readonly limit?: number
}

export interface TargetedRequest {
  readonly params: { readonly id: string }
}

type Empty = undefined

/** Full request/response contract, keyed by `METHOD path`. */
export interface ApiContract {
  'GET state': {
    method: 'GET'
    path: 'state'
    request: Empty
    response: StateView
  }
  'GET overview': {
    method: 'GET'
    path: 'overview'
    request: Empty
    response: Overview
  }
  'GET targets': {
    method: 'GET'
    path: 'targets'
    request: Empty
    response: TargetsView
  }
  'POST targets/discover': {
    method: 'POST'
    path: 'targets/discover'
    request: { body: DiscoverTargetsRequest }
    response: DiscoverTargetsResult
  }
  'POST targets/validate': {
    method: 'POST'
    path: 'targets/validate'
    request: { body: ValidateTargetsRequest }
    response: ValidateTargetsResult
  }
  'POST targets/:id/archive-sessions': {
    method: 'POST'
    path: 'targets/:id/archive-sessions'
    request: TargetedRequest & { body?: ArchiveTargetSessionsRequest }
    response: ArchiveTargetSessionsResult
  }
  'GET threads': {
    method: 'GET'
    path: 'threads'
    request: { query?: ThreadsQuery }
    response: ThreadsPage
  }
  'GET threads/:key': {
    method: 'GET'
    path: 'threads/:key'
    request: { params: { readonly key: string }; query?: ThreadQuery }
    response: ThreadDetail
  }
  'GET tasks': {
    method: 'GET'
    path: 'tasks'
    request: { query?: TasksQuery }
    response: TasksPage
  }
  'GET tasks/:id': {
    method: 'GET'
    path: 'tasks/:id'
    request: TargetedRequest
    response: TaskDetail
  }
  'POST tasks/:id/approve': {
    method: 'POST'
    path: 'tasks/:id/approve'
    request: TargetedRequest & { body?: ApproveTaskRequest }
    response: { task: TaskDetail['task']; approval: NonNullable<TaskDetail['approval']> }
  }
  'POST tasks/:id/reject': {
    method: 'POST'
    path: 'tasks/:id/reject'
    request: TargetedRequest & { body?: TaskActionRequest }
    response: { task: TaskDetail['task']; approval: NonNullable<TaskDetail['approval']> }
  }
  'POST tasks/:id/cancel': {
    method: 'POST'
    path: 'tasks/:id/cancel'
    request: TargetedRequest & { body?: TaskActionRequest }
    response: { task: TaskDetail['task'] }
  }
  'POST tasks/:id/retry': {
    method: 'POST'
    path: 'tasks/:id/retry'
    request: TargetedRequest
    response: { task: TaskDetail['task'] }
  }
  'GET settings': {
    method: 'GET'
    path: 'settings'
    request: Empty
    response: SettingsView
  }
  /**
   * Partial block patch. Plain objects are deep-merged; arrays, scalars and
   * `null` replace the existing value; unknown keys are rejected by strict
   * schema validation.
   */
  'PUT settings/:block': {
    method: 'PUT'
    path: 'settings/:block'
    request: {
      params: { readonly block: SettingsBlock }
      body: SettingsUpdateRequest
    }
    response: SettingsUpdateResult
  }
  'GET persona': {
    method: 'GET'
    path: 'persona'
    request: Empty
    response: PersonaView
  }
  'GET health': {
    method: 'GET'
    path: 'health'
    request: Empty
    response: Health
  }
  'POST monitor/pause': {
    method: 'POST'
    path: 'monitor/pause'
    request: { body: { readonly paused: boolean } }
    response: MonitorPauseResult
  }
  'GET audit': {
    method: 'GET'
    path: 'audit'
    request: { query?: AuditQuery }
    response: AuditPage
  }
}

export type ApiRoute = keyof ApiContract
export type ApiRequest<K extends ApiRoute> = ApiContract[K]['request']
export type ApiResponse<K extends ApiRoute> = ApiContract[K]['response']

export interface ApiRouteDefinition {
  readonly key: ApiRoute
  readonly method: HttpMethod
  readonly path: string
}

/** Runtime route table. The order is the order documented in `docs/011-settings-contract.md`. */
export const API_ROUTES = [
  { key: 'GET state', method: 'GET', path: 'state' },
  { key: 'GET overview', method: 'GET', path: 'overview' },
  { key: 'GET targets', method: 'GET', path: 'targets' },
  { key: 'POST targets/discover', method: 'POST', path: 'targets/discover' },
  { key: 'POST targets/validate', method: 'POST', path: 'targets/validate' },
  { key: 'POST targets/:id/archive-sessions', method: 'POST', path: 'targets/:id/archive-sessions' },
  { key: 'GET threads', method: 'GET', path: 'threads' },
  { key: 'GET threads/:key', method: 'GET', path: 'threads/:key' },
  { key: 'GET tasks', method: 'GET', path: 'tasks' },
  { key: 'GET tasks/:id', method: 'GET', path: 'tasks/:id' },
  { key: 'POST tasks/:id/approve', method: 'POST', path: 'tasks/:id/approve' },
  { key: 'POST tasks/:id/reject', method: 'POST', path: 'tasks/:id/reject' },
  { key: 'POST tasks/:id/cancel', method: 'POST', path: 'tasks/:id/cancel' },
  { key: 'POST tasks/:id/retry', method: 'POST', path: 'tasks/:id/retry' },
  { key: 'GET settings', method: 'GET', path: 'settings' },
  { key: 'PUT settings/:block', method: 'PUT', path: 'settings/:block' },
  { key: 'GET persona', method: 'GET', path: 'persona' },
  { key: 'GET health', method: 'GET', path: 'health' },
  { key: 'POST monitor/pause', method: 'POST', path: 'monitor/pause' },
  { key: 'GET audit', method: 'GET', path: 'audit' },
] as const satisfies readonly ApiRouteDefinition[]

/** Build an absolute same-origin API URL for a route and its path parameters. */
export function apiUrl(route: ApiRoute, params: Readonly<Record<string, string>> = {}): string {
  const definition = API_ROUTES.find((item) => item.key === route)
  if (!definition) throw new Error(`Unknown management API route: ${route}`)
  const path = definition.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`Missing API path parameter: ${name}`)
    return encodeURIComponent(value)
  })
  return `${API_PREFIX}${path}`
}

/** Returns the declared targets for a route; used by the router and contract tests. */
export function routeTargets(path: string): readonly TargetKind[] | undefined {
  if (path === 'targets' || path === 'targets/discover' || path === 'targets/validate') {
    return ['at-me', 'group', 'dm']
  }
  return undefined
}
