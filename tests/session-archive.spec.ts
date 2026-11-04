/**
 * Target-wide session archiving.
 *
 * The command is verified against an in-memory DSH registry and a real SQLite
 * store, so the interesting facts are exact: which sessions were enumerated
 * (registry account + stored headers + the current replier), how each outcome
 * was classified (archived / already archived / refused / missing / failed),
 * whether the replier rotated, and what the audit trail recorded.
 *
 * The tests also pin the destructive boundary: no directory, no session log and
 * no registry record is removed by an archive.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kv } from '../src/app/kv.ts'
import {
  MAX_ARCHIVE_CANDIDATES,
  SessionArchiveService,
  SessionArchiveTargetError,
  SessionArchiveUnavailableError,
  normalizeSessionActivity,
} from '../src/app/session-archive.ts'
import { ConversationSessions, type ThreadWorkspaceResolver } from '../src/app/session-recovery.ts'
import { Store } from '../src/app/store.ts'
import { auditView } from '../src/app/views.ts'
import { conversationWorkspace, conversationWorkspaceTitle } from '../src/executor/workspace.ts'
import { replySessionIdForGeneration } from '../src/executor/reply-session.ts'
import type { Settings } from '../src/shared/settings.ts'
import { RecordingLogger, makeSettings } from './fixtures/executor.ts'
import {
  FakeSessionPersistence,
  FakeUnknownSessionError,
  FakeWorkspaceRegistry,
} from './fixtures/workspace-registry.ts'

const THREAD_KEY = 'group:cid-1'
const TARGET_ID = 'cid-1'
const NOW = new Date('2026-11-04T00:00:00.000Z')

let root = ''
let store: Store | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-archive-'))
})

afterEach(async () => {
  store?.close()
  store = undefined
  await rm(root, { recursive: true, force: true })
})

interface Harness {
  readonly registry: FakeWorkspaceRegistry
  readonly persistence: FakeSessionPersistence
  readonly sessions: ConversationSessions
  readonly service: SessionArchiveService
  readonly logger: RecordingLogger
  readonly store: Store
  readonly workspacePath: string
  readonly workspaceTitle: string
}

interface HarnessOptions {
  readonly rows?: readonly Record<string, unknown>[]
  readonly registry?: FakeWorkspaceRegistry
  readonly persistence?: FakeSessionPersistence
  readonly settings?: Settings
  /** Replace the workspace rule, e.g. to make the root a symbolic-link spelling. */
  readonly resolve?: (threadKey: string, title: string) => { path: string; title: string }
  readonly realpath?: (path: string) => Promise<string>
  readonly makeDirectory?: () => Promise<unknown>
}

function harness(options: HarnessOptions = {}): Harness {
  store = Store.open(root)
  const kv = new Kv(store)
  const registry = options.registry ?? new FakeWorkspaceRegistry()
  // Production reports a never-created replier session as unknown; the fake
  // mirrors that so a test cannot accidentally "archive" a session that does
  // not exist.
  registry.strictUnknown = true
  const persistence = options.persistence ?? new FakeSessionPersistence()
  // A stored header is a session the host can archive; keep the fake honest.
  persistence.known = registry.known
  const logger = new RecordingLogger()
  const resolveWorkspace =
    options.resolve ??
    ((threadKey: string, title: string) => ({
      path: conversationWorkspace(join(root, 'workspaces'), threadKey),
      title: conversationWorkspaceTitle(title, threadKey),
    }))
  const workspaces: ThreadWorkspaceResolver = { resolveThreadWorkspace: resolveWorkspace }
  const settings =
    options.settings ??
    makeSettings({
      targets: { rows: options.rows ?? [{ kind: 'group', id: TARGET_ID, label: '项目群' }] },
    })
  const sessions = new ConversationSessions({
    workspaces,
    kv,
    registry,
    makeDirectory: options.makeDirectory ?? (async () => undefined),
  })
  const service = new SessionArchiveService({
    settings: () => settings,
    workspaces,
    sessions,
    store,
    clock: { now: () => NOW },
    registry,
    sessionPersistence: persistence,
    logger,
    ...(options.realpath === undefined ? {} : { realpath: options.realpath }),
  })
  const workspace = resolveWorkspace(THREAD_KEY, '项目群')
  return {
    registry,
    persistence,
    sessions,
    service,
    logger,
    store,
    workspacePath: workspace.path,
    workspaceTitle: workspace.title,
  }
}

describe('candidate enumeration', () => {
  it('unions the registry account, stored headers and the current replier', async () => {
    const { registry, persistence, service, workspacePath } = harness()
    const replier = replySessionIdForGeneration(THREAD_KEY, 0)
    registry.seed(workspacePath, '钉钉 · 项目群', [replier, 'session-a', 'session-b'])
    persistence.add('session-c', workspacePath)

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.archived).toEqual(['session-a', 'session-b', 'session-c', replier])
    expect(result.alreadyArchived).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.refused).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.threadKey).toBe(THREAD_KEY)
    expect(result.workspace).toEqual({ path: workspacePath, title: '钉钉 · 项目群' })
    expect(result.stopActivity).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.candidateCount).toBe(4)
  })

  it('reports a replier session that does not exist yet as missing', async () => {
    const { registry, service, workspacePath } = harness()
    const replier = replySessionIdForGeneration(THREAD_KEY, 0)
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-a'])

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.archived).toEqual(['session-a'])
    expect(result.missing).toEqual([replier])
    expect(result.replySessionRotated).toBe(false)
  })

  it('deduplicates a session reported by every source', async () => {
    const { registry, persistence, service, workspacePath } = harness()
    const replier = replySessionIdForGeneration(THREAD_KEY, 0)
    registry.seed(workspacePath, '钉钉 · 项目群', [replier])
    persistence.add(replier, workspacePath)

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.archived).toEqual([replier])
    expect(registry.archiveCalls.map((call) => call.sessionId)).toEqual([replier])
  })

  it('matches paths by identity, never by title', async () => {
    const { registry, service, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-a'])
    registry.seed(join(root, 'somewhere-else'), '钉钉 · 项目群', ['session-b'])
    registry.seed(`${workspacePath}${sep}`, '钉钉 · 项目群', ['session-c'])

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.archived).toContain('session-a')
    expect(result.archived).toContain('session-c')
    expect(result.archived).not.toContain('session-b')
  })

  it('normalizes a symbolic-link spelling through realpath', async () => {
    const linkPath = join(root, 'link', 'workspace')
    const realPath = join(root, 'real', 'workspace')
    const { registry, service } = harness({
      resolve: () => ({ path: linkPath, title: '钉钉 · 项目群' }),
      realpath: async (path) => (path === resolve(linkPath) ? realPath : path),
    })
    registry.seed(realPath, '钉钉 · 项目群', ['session-a'])

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.workspace.path).toBe(linkPath)
    expect(result.archived).toEqual(['session-a'])
  })

  it('ignores a stored header without a cwd and keeps going when the listing fails', async () => {
    const { registry, persistence, service, logger, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-a'])
    persistence.add('session-no-cwd')
    persistence.error = new Error('storage is unavailable')

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.archived).toContain('session-a')
    expect(result.archived).not.toContain('session-no-cwd')
    expect(logger.lines.some((line) => line.includes('listing stored sessions failed'))).toBe(true)
  })
})

describe('outcome classification', () => {
  it('reports an unknown session as missing', async () => {
    const { registry, service, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-ghost'])
    registry.failures.set('session-ghost', new FakeUnknownSessionError('session-ghost'))

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.missing).toContain('session-ghost')
    expect(result.archived).toEqual([])
  })

  it('reports an active session as refused with a normalized activity list', async () => {
    const { registry, service, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-busy'])
    registry.active.set('session-busy', [
      { kind: 'turn', ignored: 'field' },
      { kind: 'job', items: [{ id: 'job-1', label: '构建', secret: 'hidden' }, { id: 7 }] },
      'not-an-activity',
    ])

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.refused).toEqual([
      {
        sessionId: 'session-busy',
        activity: [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'job-1', label: '构建' }] }],
      },
    ])
    expect(JSON.stringify(result)).not.toContain('hidden')
    expect(JSON.stringify(result)).not.toContain('not-an-activity')
  })

  it('reports any other archive failure as failed without leaking the message', async () => {
    const { registry, service, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-broken'])
    registry.failures.set('session-broken', new Error('disk /srv/private/path is read-only'))

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.failed).toEqual([{ sessionId: 'session-broken', error: 'archive_failed' }])
    expect(JSON.stringify(result)).not.toContain('/srv/private/path')
  })

  it('passes stopActivity through to every archive attempt', async () => {
    const { registry, service, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-a', 'session-b'])

    const result = await service.archiveTarget(TARGET_ID, { stopActivity: true })

    expect(result.stopActivity).toBe(true)
    expect(result.archived).toEqual(['session-a', 'session-b'])
    expect(registry.archiveCalls.length).toBeGreaterThanOrEqual(2)
    expect(registry.archiveCalls.every((call) => call.stopActivity === true)).toBe(true)

    registry.archived.clear()
    registry.archiveCalls.length = 0
    const passive = await service.archiveTarget(TARGET_ID)
    expect(passive.stopActivity).toBe(false)
    expect(passive.archived).toEqual(['session-a', 'session-b'])
    expect(registry.archiveCalls.every((call) => call.stopActivity === false)).toBe(true)
  })
})

describe('replier rotation', () => {
  it('rotates the replier once when this pass archived it', async () => {
    const { registry, service, sessions, workspacePath } = harness()
    const replier = replySessionIdForGeneration(THREAD_KEY, 0)
    registry.seed(workspacePath, '钉钉 · 项目群', [replier])

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.archived).toEqual([replier])
    expect(result.replySessionRotated).toBe(true)
    expect(result.nextReplySessionId).toBe(replySessionIdForGeneration(THREAD_KEY, 1))
    expect(sessions.currentReplySessionId(THREAD_KEY)).toBe(replySessionIdForGeneration(THREAD_KEY, 1))
  })

  it('rotates when the replier was already archived before the pass', async () => {
    const { registry, service, sessions, workspacePath } = harness()
    const replier = replySessionIdForGeneration(THREAD_KEY, 0)
    registry.seed(workspacePath, '钉钉 · 项目群', [replier])
    registry.archived.add(replier)

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.alreadyArchived).toEqual([replier])
    expect(result.archived).toEqual([])
    expect(result.replySessionRotated).toBe(true)
    expect(sessions.currentReplySessionId(THREAD_KEY)).toBe(replySessionIdForGeneration(THREAD_KEY, 1))
  })

  it('does not rotate when the current replier is not archived', async () => {
    const { registry, service, sessions, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-a'])

    const result = await service.archiveTarget(TARGET_ID)

    expect(result.replySessionRotated).toBe(false)
    expect(result.nextReplySessionId).toBe(replySessionIdForGeneration(THREAD_KEY, 0))
    expect(sessions.currentReplySessionId(THREAD_KEY)).toBe(replySessionIdForGeneration(THREAD_KEY, 0))
  })

  it('is idempotent: a second pass archives nothing and never rotates again', async () => {
    const { registry, service, sessions, workspacePath } = harness()
    const first = replySessionIdForGeneration(THREAD_KEY, 0)
    registry.seed(workspacePath, '钉钉 · 项目群', [first])

    const initial = await service.archiveTarget(TARGET_ID)
    expect(initial.replySessionRotated).toBe(true)
    const rotated = replySessionIdForGeneration(THREAD_KEY, 1)
    expect(sessions.currentReplySessionId(THREAD_KEY)).toBe(rotated)

    // The rotated session has not been created yet, so the host reports it as
    // unknown; everything archived by the first pass is already archived.
    registry.strictUnknown = true
    registry.known.delete(rotated)
    registry.archiveCalls.length = 0

    const second = await service.archiveTarget(TARGET_ID)

    expect(second.alreadyArchived).toEqual([first])
    expect(second.missing).toEqual([rotated])
    expect(second.archived).toEqual([])
    expect(second.replySessionRotated).toBe(false)
    expect(second.nextReplySessionId).toBe(rotated)
    expect(registry.archiveCalls.map((call) => call.sessionId)).toEqual([rotated])
  })
})

describe('audit trail', () => {
  it('records one owner-visible event with counts and the rotation outcome', async () => {
    const { registry, service, store: opened, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', [replySessionIdForGeneration(THREAD_KEY, 0)])
    await service.archiveTarget(TARGET_ID, { stopActivity: true })

    const page = auditView(opened, { limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      action: 'workspace.sessions-archived',
      actor: 'owner',
      target: THREAD_KEY,
      outcome: 'ok',
      at: NOW.toISOString(),
    })
    const record = opened.read.audit({ limit: 1 }).items[0]
    expect(record?.data).toEqual({
      threadKey: THREAD_KEY,
      targetId: TARGET_ID,
      archived: 1,
      refused: 0,
      failed: 0,
      missing: 0,
      stopActivity: true,
      replySessionRotated: true,
    })
  })
})

describe('refusals', () => {
  it('refuses an unknown target', async () => {
    const { service } = harness()
    await expect(service.archiveTarget('missing')).rejects.toMatchObject({
      name: 'SessionArchiveTargetError',
      code: 'unknown_target',
    })
  })

  it('refuses a target without a single conversation workspace', async () => {
    for (const row of [
      { kind: 'at-me', id: 'global', label: '@我' },
      { kind: 'dm', id: 'open:user-1', label: 'Alice' },
    ]) {
      const { service } = harness({ rows: [row] })
      await expect(service.archiveTarget(String(row['id']))).rejects.toMatchObject({
        name: 'SessionArchiveTargetError',
        code: 'per_conversation_workspace',
      })
      store?.close()
      store = undefined
    }
  })

  it('refuses to run without a workspace registry', async () => {
    store = Store.open(root)
    const kv = new Kv(store)
    const workspaces: ThreadWorkspaceResolver = {
      resolveThreadWorkspace: (threadKey, title = '') => ({
        path: conversationWorkspace(join(root, 'workspaces'), threadKey),
        title: conversationWorkspaceTitle(title, threadKey),
      }),
    }
    const sessions = new ConversationSessions({ workspaces, kv, makeDirectory: async () => undefined })
    const service = new SessionArchiveService({
      settings: () => makeSettings({ targets: { rows: [{ kind: 'group', id: TARGET_ID }] } }),
      workspaces,
      sessions,
      store,
      clock: { now: () => NOW },
    })
    await expect(service.archiveTarget(TARGET_ID)).rejects.toBeInstanceOf(SessionArchiveUnavailableError)
  })

  it('exposes stable error classes for the HTTP mapping', () => {
    expect(new SessionArchiveTargetError('unknown_target', 'x').name).toBe('SessionArchiveTargetError')
    expect(new SessionArchiveTargetError('per_conversation_workspace', 'x').code).toBe('per_conversation_workspace')
    expect(new SessionArchiveUnavailableError().name).toBe('SessionArchiveUnavailableError')
  })
})

describe('destructive boundary', () => {
  it('keeps the directory, the files and every registry record', async () => {
    const { registry, service, workspacePath } = harness()
    registry.seed(workspacePath, '钉钉 · 项目群', ['session-a'])
    await mkdir(workspacePath, { recursive: true })
    const file = join(workspacePath, 'notes.md')
    await writeFile(file, 'owner data', 'utf8')

    await service.archiveTarget(TARGET_ID)

    expect((await stat(workspacePath)).isDirectory()).toBe(true)
    expect((await stat(file)).size).toBeGreaterThan(0)
    expect(registry.records.has(workspacePath)).toBe(true)
    // An archived session keeps its accounting slot, so unarchiving in DSH can
    // restore its position; the archive command must not detach it.
    expect(registry.list()).toEqual([{ path: workspacePath, sessionIds: ['session-a'] }])
    expect(registry.archived.has('session-a')).toBe(true)
  })
})

describe('candidate cap', () => {
  it('keeps the current replier even when the registry lists more than the cap', async () => {
    const { registry, service, workspacePath } = harness()
    const replier = replySessionIdForGeneration(THREAD_KEY, 0)
    const many = Array.from(
      { length: MAX_ARCHIVE_CANDIDATES + 1 },
      (_value, index) => `session-${String(index).padStart(4, '0')}`,
    )
    registry.seed(workspacePath, '钉钉 · 项目群', many)

    const result = await service.archiveTarget(TARGET_ID)

    const seen = [...result.archived, ...result.alreadyArchived, ...result.missing]
    expect(seen).toHaveLength(MAX_ARCHIVE_CANDIDATES)
    expect(seen).toContain(replier)
    // The cap is applied after a stable sort, so the cut is deterministic.
    expect(seen).toContain('session-0000')
    expect(result.truncated).toBe(true)
    expect(result.candidateCount).toBe(MAX_ARCHIVE_CANDIDATES + 2)
  })
})

describe('activity normalization', () => {
  it('keeps known fields and drops everything else', () => {
    expect(
      normalizeSessionActivity([
        { kind: 'turn' },
        { kind: 'schedule', items: [{ id: 's1' }, { id: 's2', label: '每天' }] },
        { noKind: true },
      ]),
    ).toEqual([{ kind: 'turn' }, { kind: 'schedule', items: [{ id: 's1' }, { id: 's2', label: '每天' }] }])
    expect(normalizeSessionActivity(undefined)).toEqual([])
    expect(normalizeSessionActivity({ kind: 'turn' })).toEqual([])
  })
})

describe('concurrency', () => {
  it('shares the conversation lock with the reply preflight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const registry = new FakeWorkspaceRegistry()
    registry.strictUnknown = true
    const settings = makeSettings({ targets: { rows: [{ kind: 'group', id: TARGET_ID, label: '项目群' }] } })
    store = Store.open(root)
    const kv = new Kv(store)
    const workspaces: ThreadWorkspaceResolver = {
      resolveThreadWorkspace: (threadKey, title = '') => ({
        path: conversationWorkspace(join(root, 'workspaces'), threadKey),
        title: conversationWorkspaceTitle(title, threadKey),
      }),
    }
    registry.seed(workspaces.resolveThreadWorkspace(THREAD_KEY, '项目群').path, '钉钉 · 项目群', ['session-a'])
    const sessions = new ConversationSessions({
      workspaces,
      kv,
      registry,
      makeDirectory: async () => {
        await gate
      },
    })
    const service = new SessionArchiveService({
      settings: () => settings,
      workspaces,
      sessions,
      store,
      clock: { now: () => NOW },
      registry,
    })

    const preparing = sessions.prepareReply(THREAD_KEY, '项目群')
    // Let the preflight enter its critical section and block in mkdir.
    await new Promise((resolveTick) => setTimeout(resolveTick, 0))
    const archiving = service.archiveTarget(TARGET_ID)
    await new Promise((resolveTick) => setTimeout(resolveTick, 0))
    // The archive must not read the archive set while the preflight is mid-flight.
    expect(registry.listCalls).toBe(0)

    release()
    await preparing
    const result = await archiving
    expect(result.archived).toEqual(['session-a'])
    expect(registry.listCalls).toBe(1)
  })
})
