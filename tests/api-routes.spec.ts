import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userErrorStatus } from '../src/app/http.ts'
import { fakeChannel, jsonBody, request, startTestServer, type TestServer } from './fixtures/http.ts'
import type { ChannelPort } from '../src/app/channel-port.ts'
import { conversationWorkspace, conversationWorkspaceTitle } from '../src/executor/workspace.ts'
import { inboundMessage } from './fixtures/domain.ts'
import { SETTINGS_BLOCKS, SETTINGS_DEFAULTS } from '../src/shared/settings.ts'
import { EMPTY_PERSONA, WHALE_MAID_PERSONA } from '../src/shared/persona-defaults.ts'

let root = ''
let server: TestServer | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-api-'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(root, { recursive: true, force: true })
})

async function start(options: { channel?: ChannelPort } = {}): Promise<TestServer> {
  server = await startTestServer({ stateDir: join(root, 'state'), ...options })
  return server
}

function seedTask(runtime: TestServer['runtime'], id = 'message-task'): { taskId: string; approvalId: string } {
  const { decision } = runtime.engine.receive(inboundMessage({ id }))
  const created = runtime.engine.classify(decision.id, {
    intent: 'task',
    task: { title: '整理发布说明' },
    approvalTtlMs: 3_600_000,
  })
  const taskId = created.taskId
  if (!taskId) throw new Error('the decision did not create a task')
  const approval = runtime.store.approvals.byTaskId(taskId)
  if (!approval) throw new Error('the task has no approval')
  return { taskId, approvalId: approval.id }
}

function seedThread(runtime: TestServer['runtime'], id: string, threadKey: string, at?: string): void {
  runtime.engine.receive(inboundMessage({ id, threadKey, ...(at === undefined ? {} : { at }) }))
}

describe('read routes', () => {
  it('returns the state view', async () => {
    const { baseUrl, runtime } = await start()
    const response = await request(baseUrl, '/whale-chan/api/state')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      name: runtime.name,
      version: runtime.version,
      stateDir: runtime.stateDir,
      startedAt: runtime.startedAt,
    })
  })

  it('summarizes targets, threads, tasks and pending approvals in the overview', async () => {
    const { baseUrl, runtime } = await start()
    runtime.settings.update(
      'targets',
      {
        rows: [
          { kind: 'group', id: 'cid-1', label: 'AI工程师孵化中心', enabled: true },
          { kind: 'at-me', id: 'global', label: '', enabled: false },
        ],
      },
      0,
    )
    seedThread(runtime, 'message-thread', 'group:cid-1:conv-1')
    seedTask(runtime, 'message-overview-task')

    const body = (await (await request(baseUrl, '/whale-chan/api/overview')).json()) as {
      counts: { targets: number; threads: number; tasks: number; awaitingApproval: number }
      monitor: { enabled: boolean; paused: boolean; running: boolean }
      health: { ok: boolean }
    }
    expect(body.counts).toEqual({ targets: 1, threads: 2, tasks: 1, awaitingApproval: 1 })
    expect(body.monitor).toEqual({ enabled: true, paused: false, running: false })
    expect(body.health.ok).toBe(true)
  })

  it('returns configured targets with the supported kinds', async () => {
    const { baseUrl, runtime } = await start()
    runtime.settings.update(
      'targets',
      { rows: [{ kind: 'dm', id: 'user-1', label: 'Alice', mentionOnly: false, replyMode: 'review' }] },
      0,
    )
    const body = (await (await request(baseUrl, '/whale-chan/api/targets')).json()) as {
      targets: unknown[]
      supportedKinds: string[]
    }
    expect(body.supportedKinds).toEqual(['at-me', 'group', 'dm'])
    expect(body.targets).toEqual([
      {
        id: 'user-1',
        kind: 'dm',
        label: 'Alice',
        enabled: true,
        mentionOnly: false,
        replyMode: 'review',
        workspace: {
          path: conversationWorkspace(join(runtime.stateDir, 'workspaces'), 'dm:user-1'),
          title: conversationWorkspaceTitle('Alice', 'dm:user-1'),
          mode: 'ready',
        },
      },
    ])
  })

  it('pages threads newest first and reports the next offset', async () => {
    const { baseUrl, runtime } = await start()
    seedThread(runtime, 'message-a', 'group:cid-1:conv-a', '2026-11-02T09:00:00.000Z')
    seedThread(runtime, 'message-b', 'group:cid-1:conv-b', '2026-11-02T09:10:00.000Z')

    const first = (await (await request(baseUrl, '/whale-chan/api/threads?limit=1')).json()) as {
      items: { key: string }[]
      nextOffset: number | null
    }
    expect(first.items.map((item) => item.key)).toEqual(['group:cid-1:conv-b'])
    expect(first.nextOffset).toBe(1)

    const second = (await (await request(baseUrl, '/whale-chan/api/threads?limit=1&offset=1')).json()) as {
      items: { key: string }[]
      nextOffset: number | null
    }
    expect(second.items.map((item) => item.key)).toEqual(['group:cid-1:conv-a'])
    expect(second.nextOffset).toBeNull()
  })

  it('returns one thread with its messages and rejects an unknown thread', async () => {
    const { baseUrl, runtime } = await start()
    seedThread(runtime, 'message-detail', 'group:cid-1:conv-1')
    const body = (await (
      await request(baseUrl, `/whale-chan/api/threads/${encodeURIComponent('group:cid-1:conv-1')}`)
    ).json()) as {
      thread: { key: string; title: string; unreadCount: number }
      messages: { id: string; direction: string; text: string }[]
      nextBefore: string | null
    }
    expect(body.thread.key).toBe('group:cid-1:conv-1')
    expect(body.messages).toEqual([
      expect.objectContaining({ id: 'message-detail', direction: 'incoming', text: '你好' }),
    ])
    expect(body.nextBefore).toBeNull()

    const missing = await request(baseUrl, '/whale-chan/api/threads/unknown')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'unknown_thread' } })
  })

  it('pages tasks, maps the queued status and validates the status filter', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId } = seedTask(runtime)
    const all = (await (await request(baseUrl, '/whale-chan/api/tasks')).json()) as {
      items: { id: string; status: string }[]
      nextOffset: number | null
    }
    expect(all.items).toEqual([expect.objectContaining({ id: taskId, status: 'awaiting-approval' })])
    expect(all.nextOffset).toBeNull()

    const awaiting = (await (await request(baseUrl, '/whale-chan/api/tasks?status=awaiting-approval')).json()) as {
      items: unknown[]
    }
    expect(awaiting.items).toHaveLength(1)

    const queued = (await (await request(baseUrl, '/whale-chan/api/tasks?status=queued')).json()) as {
      items: unknown[]
    }
    expect(queued.items).toHaveLength(0)

    const invalid = await request(baseUrl, '/whale-chan/api/tasks?status=unknown')
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ ok: false, error: { code: 'invalid_query' } })
  })

  it('returns one task with its approval and the latest thread messages', async () => {
    const { baseUrl, runtime } = await start()
    const { taskId, approvalId } = seedTask(runtime)
    const body = (await (await request(baseUrl, `/whale-chan/api/tasks/${taskId}`)).json()) as {
      task: { id: string; status: string; approvalId: string }
      approval: { id: string; status: string }
      messages: { id: string }[]
    }
    expect(body.task).toMatchObject({ id: taskId, status: 'awaiting-approval', approvalId })
    expect(body.approval).toMatchObject({ id: approvalId, status: 'pending' })
    expect(body.messages.map((message) => message.id)).toEqual(['message-task'])

    const missing = await request(baseUrl, '/whale-chan/api/tasks/task-missing')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'unknown_task' } })
  })

  it('returns every settings block and the persona view', async () => {
    const { baseUrl } = await start()
    const settings = (await (await request(baseUrl, '/whale-chan/api/settings')).json()) as {
      revision: number
      blocks: Record<string, { block: string; value: unknown; revision: number }>
    }
    expect(settings.revision).toBe(0)
    expect(Object.keys(settings.blocks).sort()).toEqual([...SETTINGS_BLOCKS].sort())
    for (const block of SETTINGS_BLOCKS) {
      expect(settings.blocks[block]).toEqual({ block, value: SETTINGS_DEFAULTS[block], revision: 0 })
    }

    const persona = (await (await request(baseUrl, '/whale-chan/api/persona')).json()) as {
      persona: unknown
      revision: number
      defaults: unknown
      presets: readonly { id: string; persona: unknown }[]
    }
    expect(persona.revision).toBe(0)
    expect(persona.persona).toEqual(EMPTY_PERSONA)
    expect(persona.persona).toEqual(SETTINGS_DEFAULTS.persona)
    expect(persona.defaults).toEqual(EMPTY_PERSONA)
    expect(persona.presets.map((item) => item.id)).toEqual(['whale-maid'])
    expect(persona.presets[0]?.persona).toEqual(WHALE_MAID_PERSONA)
    // The preset is a template, not the default: a fresh profile keeps the empty persona.
    expect(persona.presets[0]?.persona).not.toEqual(persona.defaults)
  })

  it('reports host health without leaking the state directory path', async () => {
    const { baseUrl, runtime } = await start()
    const response = await request(baseUrl, '/whale-chan/api/health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      status: string
      checks: { id: string; status: string; detail: string }[]
      dws: { binaryPath: string; available: boolean; authenticated: boolean | null }
    }
    expect(body.ok).toBe(true)
    expect(body.status).toBe('ok')
    const ids = body.checks.map((check) => check.id)
    expect(ids).toEqual(expect.arrayContaining(['stateDir', 'database', 'settings']))
    expect(body.checks.find((check) => check.id === 'database')?.detail).toMatch(/schema v2/)
    expect(body.checks.find((check) => check.id === 'channel')?.detail).toContain('unknown')
    expect(body.dws).toEqual({ binaryPath: 'dws', available: false, authenticated: null })
    expect(JSON.stringify(body)).not.toContain(runtime.stateDir)
  })

  it('pages the audit log from committed domain events, newest first', async () => {
    const { baseUrl, runtime } = await start()
    seedTask(runtime)
    const page = (await (await request(baseUrl, '/whale-chan/api/audit?limit=2')).json()) as {
      items: { id: string; action: string; actor: string; target: string }[]
      nextOffset: number | null
    }
    expect(page.items.map((entry) => entry.action)).toEqual(['task.created', 'decision.classified'])
    expect(page.items[0]).toMatchObject({ actor: 'assistant', outcome: 'ok' })
    expect(page.items[0]?.target).toBeTruthy()
    expect(page.nextOffset).toBe(2)

    const rest = (await (await request(baseUrl, '/whale-chan/api/audit?limit=50')).json()) as { items: unknown[] }
    expect(rest.items.length).toBeGreaterThanOrEqual(4)
  })
})

describe('settings writes', () => {
  it('merges one block, records a new revision and rejects a stale write', async () => {
    const { baseUrl } = await start()
    const written = await request(
      baseUrl,
      '/whale-chan/api/settings/monitor',
      jsonBody('PUT', { value: { quietHours: { enabled: false } }, revision: 0 }),
    )
    expect(written.status).toBe(200)
    expect(await written.json()).toMatchObject({
      block: 'monitor',
      revision: 1,
      value: { quietHours: { enabled: false, start: '22:00', end: '08:00' } },
    })

    const stale = await request(
      baseUrl,
      '/whale-chan/api/settings/monitor',
      jsonBody('PUT', { value: { paused: true }, revision: 0 }),
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      ok: false,
      error: { code: 'settings_conflict', actualRevision: 1 },
    })

    const view = (await (await request(baseUrl, '/whale-chan/api/settings')).json()) as {
      revision: number
      blocks: { monitor: { revision: number; value: { paused: boolean } } }
    }
    expect(view.revision).toBe(1)
    expect(view.blocks.monitor.revision).toBe(1)
    expect(view.blocks.monitor.value.paused).toBe(false)
  })

  it('rejects an unknown block, a missing revision and an invalid value', async () => {
    const { baseUrl } = await start()
    const unknown = await request(baseUrl, '/whale-chan/api/settings/nope', jsonBody('PUT', { value: {}, revision: 0 }))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ ok: false, error: { code: 'unknown_block' } })

    const missing = await request(baseUrl, '/whale-chan/api/settings/monitor', jsonBody('PUT', { value: {} }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'revision_required' } })

    const invalid = await request(
      baseUrl,
      '/whale-chan/api/settings/monitor',
      jsonBody('PUT', { value: { quietHours: { foo: true } }, revision: 0 }),
    )
    expect(invalid.status).toBe(400)
    const body = (await invalid.json()) as { error: { code: string; issues: { path: string }[] } }
    expect(body.error.code).toBe('invalid_settings')
    expect(body.error.issues.map((issue) => issue.path)).toContain('monitor.quietHours')
  })

  it('pauses and resumes the monitor without an expected revision', async () => {
    const { baseUrl, runtime } = await start()
    const paused = await request(baseUrl, '/whale-chan/api/monitor/pause', jsonBody('POST', { paused: true }))
    expect(paused.status).toBe(200)
    expect(await paused.json()).toEqual({ paused: true })
    expect(runtime.settings.current().monitor.paused).toBe(true)
    expect(runtime.settings.history('monitor')[0]).toMatchObject({ source: 'internal', revision: 1 })

    const resumed = await request(baseUrl, '/whale-chan/api/monitor/pause', jsonBody('POST', { paused: false }))
    expect(await resumed.json()).toEqual({ paused: false })

    const invalid = await request(baseUrl, '/whale-chan/api/monitor/pause', jsonBody('POST', { paused: 'yes' }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ ok: false, error: { code: 'invalid_body' } })
  })
})

describe('channel routes', () => {
  it('answers 503 while no channel is attached', async () => {
    const { baseUrl } = await start()
    for (const path of ['/whale-chan/api/targets/discover', '/whale-chan/api/targets/validate']) {
      const response = await request(baseUrl, path, jsonBody('POST', { kind: 'group', targets: [] }))
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'channel_unavailable' } })
    }
  })

  it('discovers targets through the channel port', async () => {
    const channel = fakeChannel([{ kind: 'group', id: 'cid-1', label: 'AI工程师孵化中心', description: '群' }])
    const { baseUrl } = await start({ channel })
    const response = await request(
      baseUrl,
      '/whale-chan/api/targets/discover',
      jsonBody('POST', { kind: 'group', query: 'AI' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      candidates: [{ kind: 'group', id: 'cid-1', label: 'AI工程师孵化中心', description: '群' }],
    })
    expect(channel.discoveries).toEqual([{ kind: 'group', query: 'AI' }])

    const invalid = await request(baseUrl, '/whale-chan/api/targets/discover', jsonBody('POST', { kind: 'nope' }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ ok: false, error: { code: 'invalid_target' } })
  })

  it('validates target drafts through the channel port', async () => {
    const channel = fakeChannel()
    const { baseUrl } = await start({ channel })
    const response = await request(
      baseUrl,
      '/whale-chan/api/targets/validate',
      jsonBody('POST', {
        targets: [
          { kind: 'group', id: 'cid-1', label: '群' },
          { kind: 'dm', id: 'bad' },
        ],
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [
        { target: { kind: 'group', id: 'cid-1', label: '群' }, valid: true },
        { target: { kind: 'dm', id: 'bad' }, valid: false, error: 'target not found' },
      ],
    })
    expect(channel.validations).toHaveLength(2)

    const invalid = await request(baseUrl, '/whale-chan/api/targets/validate', jsonBody('POST', { targets: {} }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ ok: false, error: { code: 'invalid_targets' } })
  })

  it('maps a channel failure to a stable 400 without leaking the error', async () => {
    const channel = fakeChannel()
    channel.fail = true
    const { baseUrl } = await start({ channel })
    const response = await request(baseUrl, '/whale-chan/api/targets/discover', jsonBody('POST', { kind: 'group' }))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('channel_error')
    expect(body.error.message).not.toContain('dws')
  })
})

describe('error classification', () => {
  it('maps each user error category to one stable status', () => {
    expect(userErrorStatus('missing')).toBe(404)
    expect(userErrorStatus('invalid')).toBe(400)
    expect(userErrorStatus('refused')).toBe(409)
  })
})

describe('routing guards', () => {
  it('rejects a request without the same-origin header before routing', async () => {
    const { baseUrl, runtime } = await start()
    const response = await request(baseUrl, '/whale-chan/api/settings', {}, false)
    expect(response.status).toBe(403)
    const text = await response.text()
    expect(text).not.toContain(runtime.stateDir)
  })

  it('rejects a wrong method with 405 and an Allow header', async () => {
    const { baseUrl } = await start()
    const cases = [
      { path: '/whale-chan/api/state', method: 'POST', allow: 'GET' },
      { path: '/whale-chan/api/tasks/task-1/approve', method: 'GET', allow: 'POST' },
      { path: '/whale-chan/api/settings/monitor', method: 'GET', allow: 'PUT' },
      { path: '/whale-chan/api/monitor/pause', method: 'GET', allow: 'POST' },
    ]
    for (const item of cases) {
      const response = await request(baseUrl, item.path, { method: item.method })
      expect(response.status, item.path).toBe(405)
      expect(response.headers.get('allow'), item.path).toBe(item.allow)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'method_not_allowed' } })
    }
  })

  it('returns 404 for an unknown route', async () => {
    const { baseUrl } = await start()
    const response = await request(baseUrl, '/whale-chan/api/unknown')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('validates pagination boundaries', async () => {
    const { baseUrl } = await start()
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'offset=1.5']) {
      const response = await request(baseUrl, `/whale-chan/api/threads?${query}`)
      expect(response.status, query).toBe(400)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_query' } })
    }
    const accepted = await request(baseUrl, '/whale-chan/api/threads?limit=100&offset=0')
    expect(accepted.status).toBe(200)
  })

  it('rejects malformed JSON and an oversized body', async () => {
    const { baseUrl } = await start()
    const malformed = await request(baseUrl, '/whale-chan/api/settings/monitor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ ok: false, error: { code: 'invalid_json' } })

    const oversized = await request(baseUrl, '/whale-chan/api/settings/monitor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: { name: 'x'.repeat(140 * 1024) }, revision: 0 }),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ ok: false, error: { code: 'body_too_large' } })
  })
})
