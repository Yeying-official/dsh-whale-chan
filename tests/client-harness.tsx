/**
 * Shared fixtures and DOM harness for the client tests.
 *
 * Every test renders the real panel against a mocked `fetch`, so the assertions
 * exercise the same provider, API layer and pages the browser runs.
 */
import { cleanup, render, type RenderResult } from '@testing-library/react'
import { vi } from 'vitest'
import { App } from '../src/client/app.tsx'
import { zh, type T } from '../src/client/locale.ts'
import { PanelProvider } from '../src/client/provider.tsx'
import { SETTINGS_BLOCKS, SETTINGS_DEFAULTS } from '../src/shared/settings.ts'
import type { SettingsBlock } from '../src/shared/settings.ts'
import type {
  Approval,
  AuditEntry,
  Health,
  MessageView,
  Overview,
  PersonaView,
  SettingsView,
  Target,
  TargetsView,
  Task,
  TaskDetail,
  TaskStatus,
  ThreadDetail,
  ThreadSummary,
} from '../src/shared/models.ts'

export const NOW = '2026-11-03T04:00:00.000Z'
export const LATER = '2026-11-04T04:00:00.000Z'

export interface Reply {
  readonly status: number
  readonly body: unknown
}

/** A plain response object; jsdom does not need a real `Response`. */
export function reply(status: number, body?: unknown): Reply {
  return { status, body }
}

export function failure(status: number, code: string, extra: Record<string, unknown> = {}): Reply {
  return reply(status, { ok: false, error: { code, message: `mock ${code}`, ...extra } })
}

export interface RequestInfo {
  readonly url: URL
  readonly method: string
  readonly body: unknown
}

export type Handler = (request: RequestInfo) => Reply | undefined

function asResponse(result: Reply): Response {
  const text = result.body === undefined ? '' : JSON.stringify(result.body)
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    text: async () => text,
  } as unknown as Response
}

/** Install a `fetch` mock that routes by method and path. */
export function installFetch(handler: Handler) {
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1')
    const rawBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    const result = handler({ url, method: init?.method ?? 'GET', body: rawBody })
    if (!result) return asResponse(failure(404, 'not_found'))
    return asResponse(result)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Every panel needs health; a test handler only overrides the routes it cares about. */
export function withHealth(handler: Handler): Handler {
  return (request) =>
    handler(request) ?? (request.url.pathname.endsWith('/health') ? reply(200, healthFixture()) : undefined)
}

export function makeT(): T {
  return (key, params) => {
    const template = (zh as unknown as Record<string, string>)[key] ?? String(key)
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = params?.[name]
      return value === undefined ? `{${name}}` : String(value)
    })
  }
}

export interface PanelRender extends RenderResult {
  readonly t: T
  readonly fetchMock: ReturnType<typeof installFetch>
  readonly openSession: (sessionId: string) => Promise<void>
}

export function renderPanel(
  handler: Handler,
  options: { readonly openSession?: (sessionId: string) => Promise<void> } = {},
): PanelRender {
  const fetchMock = installFetch(withHealth(handler))
  const openSession = options.openSession ?? vi.fn(async () => {})
  const t = makeT()
  const view = render(
    <PanelProvider t={t} openSession={openSession}>
      <App />
    </PanelProvider>,
  )
  return { ...view, t, fetchMock, openSession }
}

/** Reset module-level state between tests. */
export function resetPanelTest(): void {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  document.body.innerHTML = ''
}

export function healthFixture(overrides: Partial<Health> = {}): Health {
  return {
    ok: true,
    status: 'ok',
    checks: [
      { id: 'state', status: 'ok', detail: 'started at mock', observedAt: NOW },
      { id: 'database', status: 'ok', detail: 'schema v2', observedAt: NOW },
    ],
    dws: { binaryPath: 'dws', available: false, authenticated: null },
    ...overrides,
  }
}

export function overviewFixture(overrides: Partial<Overview> = {}): Overview {
  return {
    generatedAt: NOW,
    monitor: { enabled: true, paused: false, running: false },
    counts: { targets: 2, threads: 7, tasks: 4, awaitingApproval: 3 },
    health: healthFixture(),
    ...overrides,
  }
}

export function targetFixture(overrides: Partial<Target> = {}): Target {
  return {
    id: 'group-1',
    kind: 'group',
    label: '项目群',
    enabled: true,
    mentionOnly: true,
    replyMode: 'auto',
    ...overrides,
  }
}

export function targetsFixture(targets: readonly Target[] = [targetFixture()]): TargetsView {
  return { targets, supportedKinds: ['at-me', 'group', 'dm'] }
}

export function settingsFixture(
  overrides: Partial<Record<SettingsBlock, { value: unknown; revision: number }>> = {},
): SettingsView {
  const blocks = Object.fromEntries(
    SETTINGS_BLOCKS.map((block) => {
      const override = overrides[block]
      return [
        block,
        {
          block,
          value: structuredClone(override?.value ?? SETTINGS_DEFAULTS[block]),
          revision: override?.revision ?? 1,
        },
      ]
    }),
  ) as unknown as SettingsView['blocks']
  return { blocks, revision: 9 }
}

export function personaFixture(overrides: Partial<PersonaView['persona']> = {}, revision = 3): PersonaView {
  return { persona: { ...SETTINGS_DEFAULTS.persona, ...overrides }, revision }
}

export function threadFixture(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    key: 'group:mock',
    title: '项目群',
    kind: 'group',
    lastMessageAt: NOW,
    unreadCount: 0,
    taskId: null,
    ...overrides,
  }
}

export function messageFixture(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: 'message-1',
    threadKey: 'group:mock',
    direction: 'incoming',
    senderId: 'user-1',
    senderName: '小明',
    text: '帮我整理一下周报',
    sentAt: NOW,
    ...overrides,
  }
}

export function threadDetailFixture(
  thread: ThreadSummary = threadFixture(),
  messages: readonly MessageView[] = [messageFixture()],
  nextBefore: string | null = null,
): ThreadDetail {
  return { thread, messages, nextBefore }
}

export function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '整理周报',
    status: 'awaiting-approval',
    threadKey: 'group:mock',
    createdAt: NOW,
    updatedAt: NOW,
    approvalId: 'approval-1',
    ...overrides,
  }
}

export function approvalFixture(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval-1',
    taskId: 'task-1',
    status: 'pending',
    requestedAt: NOW,
    expiresAt: LATER,
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  }
}

export function taskDetailFixture(
  overrides: Partial<TaskDetail> = {},
  extra: Record<string, unknown> = {},
): TaskDetail {
  return {
    task: overrides.task ?? taskFixture(),
    approval: overrides.approval === undefined ? approvalFixture() : overrides.approval,
    messages: overrides.messages ?? [messageFixture()],
    ...extra,
  }
}

export function tasksPage(items: readonly Task[], nextOffset: number | null = null) {
  return { items, nextOffset }
}

export function threadsPage(items: readonly ThreadSummary[], nextOffset: number | null = null) {
  return { items, nextOffset }
}

export function auditFixture(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: '1',
    at: NOW,
    actor: 'owner',
    action: 'task.approved',
    target: 'task-1',
    outcome: 'ok',
    ...overrides,
  }
}

export function auditPage(items: readonly AuditEntry[], nextOffset: number | null = null) {
  return { items, nextOffset }
}

export const statusTask = (status: TaskStatus): Task =>
  taskFixture({ status, approvalId: status === 'failed' ? 'approval-1' : null })

/** Route helpers keep test handlers readable. */
export function pathOf(url: URL): string {
  return url.pathname.replace('/whale-chan/api/', '')
}

export function queryOf(url: URL, name: string): string | null {
  return url.searchParams.get(name)
}

/** Parsed request bodies for one method and path, in call order. */
export function requestBodies(mock: ReturnType<typeof installFetch>, method: string, path: string): readonly unknown[] {
  return mock.mock.calls.flatMap(([input, init]) => {
    const url = new URL(String(input), 'http://127.0.0.1')
    if ((init?.method ?? 'GET') !== method || pathOf(url) !== path) return []
    return [typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined]
  })
}

/** Number of requests for one method and path. */
export function requestCount(mock: ReturnType<typeof installFetch>, method: string, path: string): number {
  return mock.mock.calls.filter(([input, init]) => {
    const url = new URL(String(input), 'http://127.0.0.1')
    return (init?.method ?? 'GET') === method && pathOf(url) === path
  }).length
}
