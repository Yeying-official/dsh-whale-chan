/**
 * Per-conversation workspaces: directory naming, the root rule, target
 * projection and the best-effort provisioning pass.
 *
 * The DSH registry is replaced by a fake so a test can see exactly which
 * directories were created and which titles changed. The naming rules are pure,
 * so most of this file needs neither a state directory nor a host.
 */
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SettingsService } from '../src/app/settings.ts'
import {
  WORKSPACES_DIRECTORY,
  WorkspaceService,
  resolveWorkspaceRoot,
  targetThreadKey,
  type WorkspaceRecord,
  type WorkspaceRegistryPort,
} from '../src/app/workspaces.ts'
import { targetsView } from '../src/app/views.ts'
import { ExecutorError } from '../src/executor/index.ts'
import {
  CONVERSATION_DIRECTORY_PREFIX,
  MAX_WORKSPACE_TITLE_CHARS,
  WORKSPACE_LAYOUT_VERSION,
  WORKSPACE_TITLE_PREFIX,
  conversationWorkspace,
  conversationWorkspaceDigest,
  conversationWorkspaceTitle,
  isSafeWorkspaceSegment,
} from '../src/executor/workspace.ts'
import type { Settings } from '../src/shared/settings.ts'
import { makeSettings } from './fixtures/executor.ts'

const STATE = join(process.cwd(), '.tmp-workspaces', 'state')
const HOME = join(process.cwd(), '.tmp-workspaces', 'home')

/** The path `conversationWorkspace` must produce, computed independently. */
function expectedPath(root: string, threadKey: string): string {
  const digest = createHash('sha256').update(threadKey, 'utf8').digest('hex').slice(0, 16)
  return join(root, `${CONVERSATION_DIRECTORY_PREFIX}${digest}`)
}

class FakeWorkspace implements WorkspaceRecord {
  readonly retitles: string[] = []

  constructor(
    readonly path: string,
    readonly title: string,
  ) {}

  async setTitle(title: string): Promise<void> {
    this.retitles.push(title)
    ;(this as { title: string }).title = title
  }
}

class FakeRegistry implements WorkspaceRegistryPort {
  readonly rows = new Map<string, FakeWorkspace>()
  readonly creates: string[] = []
  /** Path whose `create` rejects, to exercise the failure path. */
  failOn: string | undefined

  async create(path: string, title?: string): Promise<WorkspaceRecord> {
    if (this.failOn === path) throw new Error('registry refused the path')
    this.creates.push(path)
    const existing = this.rows.get(path)
    if (existing !== undefined) return existing
    const created = new FakeWorkspace(path, title ?? path)
    this.rows.set(path, created)
    return created
  }

  async resolveByPath(path: string): Promise<WorkspaceRecord | undefined> {
    return this.rows.get(path)
  }
}

function service(
  registry: WorkspaceRegistryPort | undefined,
  settings: Settings,
  created: string[] = [],
  warnings: string[] = [],
): WorkspaceService {
  return new WorkspaceService({
    settings: () => settings,
    stateDir: STATE,
    homeDir: HOME,
    registry,
    logger: { warn: (message) => warnings.push(message) },
    makeDirectory: async (path) => {
      created.push(path)
    },
  })
}

function targetRow(
  kind: 'at-me' | 'group' | 'dm',
  id: string,
  label: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, id, label, enabled: true, mentionOnly: false, replyMode: 'auto', ...overrides }
}

describe('conversationWorkspace', () => {
  it('derives one deterministic directory from the SHA-256 of the thread key', () => {
    const path = conversationWorkspace('/srv/workspaces', 'group:cid-1')
    expect(path).toBe(expectedPath('/srv/workspaces', 'group:cid-1'))
    expect(path.split(/[\\/]/u).at(-1)).toMatch(/^conversation-[0-9a-f]{16}$/u)
    expect(conversationWorkspaceDigest('group:cid-1')).toHaveLength(16)
    expect(WORKSPACE_LAYOUT_VERSION).toBe('v2')
  })

  it('gives different conversations different directories', () => {
    const first = conversationWorkspace('/srv/workspaces', 'group:cid-1')
    const second = conversationWorkspace('/srv/workspaces', 'group:cid-2')
    const direct = conversationWorkspace('/srv/workspaces', 'dm:u1')
    expect(first).not.toBe(second)
    expect(second).not.toBe(direct)
    expect(first).not.toBe(direct)
  })

  it('treats a traversal-shaped thread key as data, never as a path', () => {
    const path = conversationWorkspace('/srv/workspaces', '../../etc/passwd')
    expect(relative('/srv/workspaces', path).startsWith('..')).toBe(false)
    expect(path).toBe(expectedPath('/srv/workspaces', '../../etc/passwd'))
    expect(path).not.toContain('..')
    // A NUL in a user-controlled key cannot reach the path either.
    expect(conversationWorkspace('/srv/workspaces', 'dm:u\u0000x')).toBe(expectedPath('/srv/workspaces', 'dm:u\u0000x'))
  })

  it('refuses a root or key that cannot form a safe path', () => {
    expect(() => conversationWorkspace('   ', 'dm:u1')).toThrow(ExecutorError)
    expect(() => conversationWorkspace('/srv/work\u0000spaces', 'dm:u1')).toThrow(ExecutorError)
    expect(() => conversationWorkspace('/srv/workspaces', '   ')).toThrow(ExecutorError)
  })

  it('recognizes safe segments on Windows and POSIX', () => {
    expect(isSafeWorkspaceSegment('conversation-0123456789abcdef')).toBe(true)
    expect(isSafeWorkspaceSegment('..')).toBe(false)
    expect(isSafeWorkspaceSegment('.')).toBe(false)
    expect(isSafeWorkspaceSegment('')).toBe(false)
    expect(isSafeWorkspaceSegment('..\\escape')).toBe(false)
    expect(isSafeWorkspaceSegment('C:evil')).toBe(false)
    expect(isSafeWorkspaceSegment('a/b')).toBe(false)
    expect(isSafeWorkspaceSegment('trailing.')).toBe(false)
    expect(isSafeWorkspaceSegment('nul\u0000')).toBe(false)
    expect(isSafeWorkspaceSegment('bad*name')).toBe(false)
  })
})

describe('conversationWorkspaceTitle', () => {
  it('prefixes a named conversation and leaves a readable name alone', () => {
    expect(conversationWorkspaceTitle('AI 工程师群', 'group:cid-1')).toBe(`${WORKSPACE_TITLE_PREFIX}AI 工程师群`)
  })

  it('adds a short digest when the title is missing or a generic @我', () => {
    const named = conversationWorkspaceTitle('@我', 'group:cid-1')
    expect(named).toMatch(/^钉钉 · @我 · [0-9a-f]{8}$/u)
    const empty = conversationWorkspaceTitle('   ', 'group:cid-1')
    expect(empty).toBe(`${WORKSPACE_TITLE_PREFIX}${conversationWorkspaceDigest('group:cid-1').slice(0, 8)}`)
    // Two unnamed conversations must not collapse into one display row.
    expect(conversationWorkspaceTitle('', 'group:a')).not.toBe(conversationWorkspaceTitle('', 'group:b'))
  })

  it('bounds and flattens a hostile title', () => {
    const title = conversationWorkspaceTitle(`a\nb\u0000${'x'.repeat(500)}`, 'dm:u1')
    expect(title).toBe(`${WORKSPACE_TITLE_PREFIX}${`a b ${'x'.repeat(500)}`.slice(0, MAX_WORKSPACE_TITLE_CHARS)}`)
    expect(title).not.toContain('\n')
  })
})

describe('resolveWorkspaceRoot', () => {
  it('uses <stateDir>/workspaces when nothing is configured', () => {
    const resolved = resolveWorkspaceRoot({
      settings: makeSettings(),
      stateDir: STATE,
      home: HOME,
    })
    expect(resolved).toEqual({ root: resolve(join(STATE, WORKSPACES_DIRECTORY)) })
  })

  it('honours an absolute workspaceRoot and expands a leading tilde', () => {
    const custom = join(HOME, 'work', 'whale')
    expect(
      resolveWorkspaceRoot({
        settings: makeSettings({ tasks: { workspaceRoot: custom } }),
        stateDir: STATE,
        home: HOME,
      }),
    ).toEqual({ root: resolve(custom) })
    expect(
      resolveWorkspaceRoot({
        settings: makeSettings({ tasks: { workspaceRoot: '~/work/whale' } }),
        stateDir: STATE,
        home: HOME,
      }),
    ).toEqual({ root: resolve(custom) })
  })

  it('ignores a relative root and reports it', () => {
    const resolved = resolveWorkspaceRoot({
      settings: makeSettings({ tasks: { workspaceRoot: 'work/relative' } }),
      stateDir: STATE,
      home: HOME,
    })
    expect(resolved.root).toBe(resolve(join(STATE, WORKSPACES_DIRECTORY)))
    expect(resolved.ignored).toBe('work/relative')
  })
})

describe('WorkspaceService.resolveThreadWorkspace', () => {
  it('returns the conversation path and its display title', () => {
    const settings = makeSettings()
    const workspaces = service(undefined, settings)
    const resolved = workspaces.resolveThreadWorkspace('group:cid-1', 'AI 群')
    expect(resolved).toEqual({
      path: conversationWorkspace(resolve(join(STATE, WORKSPACES_DIRECTORY)), 'group:cid-1'),
      title: conversationWorkspaceTitle('AI 群', 'group:cid-1'),
    })
  })

  it('reports a relative configured root once and keeps resolving under the default', () => {
    const warnings: string[] = []
    const settings = makeSettings({ tasks: { workspaceRoot: 'relative/root' } })
    const workspaces = service(undefined, settings, [], warnings)
    const first = workspaces.resolveThreadWorkspace('dm:u1', 'Alice')
    const second = workspaces.resolveThreadWorkspace('dm:u2', 'Bob')
    expect(first.path).toBe(conversationWorkspace(resolve(join(STATE, WORKSPACES_DIRECTORY)), 'dm:u1'))
    expect(second.path).toBe(conversationWorkspace(resolve(join(STATE, WORKSPACES_DIRECTORY)), 'dm:u2'))
    expect(warnings).toHaveLength(1)
  })
})

describe('WorkspaceService.targetWorkspace', () => {
  const settings = makeSettings({
    targets: {
      rows: [
        targetRow('group', 'cid-1', 'AI 群'),
        targetRow('dm', 'u1', 'Alice'),
        targetRow('at-me', 'global', '@我'),
        targetRow('dm', 'open:open-1', 'Bob'),
      ],
    },
  })

  it('gives a group and a plain direct message one ready directory', () => {
    const workspaces = service(undefined, settings)
    expect(workspaces.targetWorkspace({ kind: 'group', id: 'cid-1', label: 'AI 群' })).toEqual({
      path: conversationWorkspace(resolve(join(STATE, WORKSPACES_DIRECTORY)), 'group:cid-1'),
      title: conversationWorkspaceTitle('AI 群', 'group:cid-1'),
      mode: 'ready',
    })
    expect(workspaces.targetWorkspace({ kind: 'dm', id: 'u1', label: 'Alice' }).mode).toBe('ready')
  })

  it('reports a global at-me and an open id as per-conversation', () => {
    const workspaces = service(undefined, settings)
    const atMe = workspaces.targetWorkspace({ kind: 'at-me', id: 'global', label: '@我' })
    expect(atMe).toEqual({ path: null, title: `${WORKSPACE_TITLE_PREFIX}@我`, mode: 'per-conversation' })
    const open = workspaces.targetWorkspace({ kind: 'dm', id: 'open:open-1', label: 'Bob' })
    expect(open).toEqual({ path: null, title: `${WORKSPACE_TITLE_PREFIX}Bob`, mode: 'per-conversation' })
    expect(workspaces.targetWorkspace({ kind: 'at-me', id: 'global', label: '' }).title).toBe(
      `${WORKSPACE_TITLE_PREFIX}按会话`,
    )
  })
})

describe('targetThreadKey', () => {
  it('maps concrete targets and skips global subscriptions', () => {
    expect(targetThreadKey({ kind: 'group', id: ' cid-1 ' })).toBe('group:cid-1')
    expect(targetThreadKey({ kind: 'dm', id: 'u1' })).toBe('dm:u1')
    expect(targetThreadKey({ kind: 'dm', id: 'open:open-1' })).toBeUndefined()
    expect(targetThreadKey({ kind: 'at-me', id: 'global' })).toBeUndefined()
    expect(targetThreadKey({ kind: 'group', id: '   ' })).toBeUndefined()
  })
})

describe('WorkspaceService.provisionTargets', () => {
  it('creates directories and registry rows for enabled group and plain dm targets', async () => {
    const registry = new FakeRegistry()
    const created: string[] = []
    const settings = makeSettings({
      targets: {
        rows: [
          targetRow('group', 'cid-1', 'AI 群'),
          targetRow('dm', 'u1', 'Alice'),
          targetRow('at-me', 'global', '@我'),
          targetRow('dm', 'open:open-1', 'Bob'),
          targetRow('group', 'cid-2', 'Disabled', { enabled: false }),
        ],
      },
    })
    const workspaces = service(registry, settings, created)
    const summary = await workspaces.provisionTargets(settings)
    expect(summary).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: 3, failed: 0 })
    const root = resolve(join(STATE, WORKSPACES_DIRECTORY))
    expect(created).toEqual([conversationWorkspace(root, 'group:cid-1'), conversationWorkspace(root, 'dm:u1')])
    expect(registry.creates).toEqual(created)
    expect(registry.rows.get(created[0] as string)?.title).toBe(conversationWorkspaceTitle('AI 群', 'group:cid-1'))
  })

  it('deduplicates repeated target ids and leaves one directory', async () => {
    const registry = new FakeRegistry()
    const settings = makeSettings({
      targets: {
        rows: [targetRow('group', 'cid-1', 'AI 群'), targetRow('group', 'cid-1', '别名群')],
      },
    })
    const workspaces = service(registry, settings)
    const summary = await workspaces.provisionTargets(settings)
    expect(summary).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: 1, failed: 0 })
    expect(registry.creates).toHaveLength(1)
    expect(registry.rows.size).toBe(1)
  })

  it('updates a changed title without recreating the record', async () => {
    const registry = new FakeRegistry()
    const first = makeSettings({ targets: { rows: [targetRow('group', 'cid-1', '旧名字')] } })
    const second = makeSettings({ targets: { rows: [targetRow('group', 'cid-1', '新名字')] } })
    const workspaces = service(registry, first)
    await workspaces.provisionTargets(first)
    const path = registry.creates[0] as string
    const record = registry.rows.get(path) as FakeWorkspace
    const summary = await workspaces.provisionTargets(second)
    expect(summary).toEqual({ created: 0, updated: 1, unchanged: 0, skipped: 0, failed: 0 })
    expect(record.title).toBe(conversationWorkspaceTitle('新名字', 'group:cid-1'))
    expect(record.retitles).toEqual([conversationWorkspaceTitle('新名字', 'group:cid-1')])
    expect(registry.creates).toEqual([path])
  })

  it('is idempotent: a second pass changes nothing', async () => {
    const registry = new FakeRegistry()
    const settings = makeSettings({ targets: { rows: [targetRow('group', 'cid-1', 'AI 群')] } })
    const workspaces = service(registry, settings)
    await workspaces.provisionTargets(settings)
    const summary = await workspaces.provisionTargets(settings)
    expect(summary).toEqual({ created: 0, updated: 0, unchanged: 1, skipped: 0, failed: 0 })
    expect(registry.rows.size).toBe(1)
  })

  it('keeps a disabled target’s directory and registration', async () => {
    const registry = new FakeRegistry()
    const enabled = makeSettings({ targets: { rows: [targetRow('group', 'cid-1', 'AI 群')] } })
    const disabled = makeSettings({
      targets: { rows: [targetRow('group', 'cid-1', 'AI 群', { enabled: false })] },
    })
    const workspaces = service(registry, enabled)
    await workspaces.provisionTargets(enabled)
    const summary = await workspaces.provisionTargets(disabled)
    expect(summary).toEqual({ created: 0, updated: 0, unchanged: 0, skipped: 1, failed: 0 })
    expect(registry.rows.size).toBe(1)
  })

  it('logs one failing target and still provisions the rest', async () => {
    const registry = new FakeRegistry()
    const warnings: string[] = []
    const settings = makeSettings({
      targets: {
        rows: [targetRow('group', 'cid-1', 'AI 群'), targetRow('dm', 'u1', 'Alice')],
      },
    })
    const root = resolve(join(STATE, WORKSPACES_DIRECTORY))
    registry.failOn = conversationWorkspace(root, 'group:cid-1')
    const workspaces = service(registry, settings, [], warnings)
    const summary = await workspaces.provisionTargets(settings)
    expect(summary).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: 0, failed: 1 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('group:cid-1')
  })

  it('does nothing without a registry', async () => {
    const settings = makeSettings({ targets: { rows: [targetRow('group', 'cid-1', 'AI 群')] } })
    const created: string[] = []
    const workspaces = service(undefined, settings, created)
    const summary = await workspaces.provisionTargets(settings)
    expect(summary).toEqual({ created: 0, updated: 0, unchanged: 0, skipped: 1, failed: 0 })
    expect(created).toEqual([])
  })
})

describe('targetsView workspace projection', () => {
  const settings = makeSettings({
    targets: {
      rows: [targetRow('group', 'cid-1', 'AI 群'), targetRow('at-me', 'global', '@我', { mentionOnly: true })],
    },
  })

  it('fills the read-only workspace of every row from the resolver', () => {
    const workspaces = service(undefined, settings)
    const view = targetsView({ current: () => settings } as unknown as SettingsService, (target) =>
      workspaces.targetWorkspace(target),
    )
    expect(view.targets[0]).toMatchObject({
      id: 'cid-1',
      workspace: {
        path: conversationWorkspace(resolve(join(STATE, WORKSPACES_DIRECTORY)), 'group:cid-1'),
        title: conversationWorkspaceTitle('AI 群', 'group:cid-1'),
        mode: 'ready',
      },
    })
    expect(view.targets[1]).toMatchObject({
      id: 'global',
      workspace: { path: null, mode: 'per-conversation' },
    })
  })

  it('omits the field when no resolver is supplied', () => {
    const view = targetsView({ current: () => settings } as unknown as SettingsService)
    expect(view.targets.every((row) => row.workspace === undefined)).toBe(true)
  })
})
