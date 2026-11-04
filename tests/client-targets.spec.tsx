// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { zh } from '../src/client/locale.ts'
import {
  failure,
  pathOf,
  reply,
  renderPanel,
  requestBodies,
  requestCount,
  resetPanelTest,
  settingsFixture,
  targetFixture,
  targetsFixture,
} from './client-harness.tsx'
import type { ArchiveTargetSessionsResult } from '../src/shared/models.ts'

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  resetPanelTest()
})

const row = {
  kind: 'group' as const,
  id: 'group-1',
  label: '项目群',
  mentionOnly: true,
  replyMode: 'auto' as const,
  enabled: true,
}

const workspacePath = 'E:/state/workspaces/group-1'

/** One ready-workspace target; the archive action keys off `workspace.mode`. */
function readyTargets(
  overrides: { readonly id?: string; readonly label?: string; readonly path?: string } = {},
): ReturnType<typeof targetsFixture> {
  const id = overrides.id ?? 'group-1'
  const label = overrides.label ?? '项目群'
  return targetsFixture([
    targetFixture({
      id,
      label,
      workspace: { path: overrides.path ?? workspacePath, title: `钉钉 · ${label}`, mode: 'ready' },
    }),
  ])
}

const archiveRoute = (id: string): string => `targets/${encodeURIComponent(id)}/archive-sessions`

function archiveResult(overrides: Partial<ArchiveTargetSessionsResult> = {}): ArchiveTargetSessionsResult {
  return {
    targetId: 'group-1',
    threadKey: 'group:group-1',
    workspace: { path: workspacePath, title: '钉钉 · 项目群' },
    archived: ['session-1'],
    alreadyArchived: [],
    refused: [],
    missing: [],
    failed: [],
    replySessionRotated: false,
    nextReplySessionId: 'session-2',
    stopActivity: false,
    truncated: false,
    candidateCount: 1,
    ...overrides,
  }
}

function renderTargets(handler: Parameters<typeof renderPanel>[0]) {
  window.location.hash = '#targets'
  return renderPanel(handler)
}

function handler(
  options: {
    readonly targets?: ReturnType<typeof targetsFixture>
    readonly rows?: readonly (typeof row)[]
    readonly revision?: () => number
    readonly put?: (body: { value: { rows: readonly unknown[] }; revision: number }) => ReturnType<typeof reply>
    readonly discover?: ReturnType<typeof reply>
    readonly validate?: ReturnType<typeof reply>
    readonly archive?: (request: { url: URL; method: string; body: unknown }) => ReturnType<typeof reply>
  } = {},
) {
  const targets = options.targets ?? targetsFixture([targetFixture()])
  const rows = options.rows ?? [row]
  return (request: { url: URL; method: string; body: unknown }) => {
    const path = pathOf(request.url)
    if (path === 'targets' && request.method === 'GET') return reply(200, targets)
    if (path === 'settings' && request.method === 'GET') {
      return reply(200, settingsFixture({ targets: { value: { rows }, revision: options.revision?.() ?? 1 } }))
    }
    if (path === 'settings/targets' && request.method === 'PUT') {
      if (options.put) return options.put(request.body as { value: { rows: readonly unknown[] }; revision: number })
      return reply(200, { block: 'targets', value: { rows }, revision: 2 })
    }
    if (path === 'targets/discover' && request.method === 'POST') {
      return options.discover ?? reply(200, { candidates: [{ kind: 'group', id: 'group-2', label: '新群' }] })
    }
    if (path === 'targets/validate' && request.method === 'POST') {
      return (
        options.validate ??
        reply(200, {
          results: [
            { target: { kind: 'group', id: 'group-1', label: '项目群' }, valid: true },
            { target: { kind: 'group', id: 'group-2' }, valid: false, error: '不存在' },
          ],
        })
      )
    }
    if (path.startsWith('targets/') && path.endsWith('/archive-sessions') && request.method === 'POST') {
      return options.archive?.(request) ?? reply(200, archiveResult())
    }
    return undefined
  }
}

describe('targets page', () => {
  it('edits a target row and saves it with the block revision', async () => {
    const user = userEvent.setup()
    const view = renderTargets(handler())
    expect(await screen.findByDisplayValue('项目群')).toBeTruthy()
    await user.click(screen.getByRole('switch', { name: '仅 @ 1' }))
    await user.click(screen.getByRole('button', { name: zh['targets.save'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/targets')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/targets')[0] as {
      value: { rows: readonly { mentionOnly: boolean; id: string }[] }
      revision: number
    }
    expect(body.revision).toBe(1)
    expect(body.value.rows[0]).toMatchObject({ id: 'group-1', mentionOnly: false })
    expect(await screen.findByText(zh['targets.saved'])).toBeTruthy()
  })

  it('recovers from a settings conflict and retries with the actual revision', async () => {
    const user = userEvent.setup()
    let revision = 1
    let writes = 0
    const view = renderTargets(
      handler({
        revision: () => revision,
        put: (body) => {
          writes += 1
          if (writes === 1) {
            revision = 5
            return failure(409, 'settings_conflict', { actualRevision: 5 })
          }
          return reply(200, { block: 'targets', value: body.value, revision: body.revision + 1 })
        },
      }),
    )
    await screen.findByDisplayValue('项目群')
    await user.click(screen.getByRole('switch', { name: '仅 @ 1' }))
    await user.click(screen.getByRole('button', { name: zh['targets.save'] }))
    expect(await screen.findByText(zh['targets.conflict'])).toBeTruthy()
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/targets')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: zh['targets.save'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/targets')).toHaveLength(2))
    expect((requestBodies(view.fetchMock, 'PUT', 'settings/targets')[1] as { revision: number }).revision).toBe(5)
  })

  it('discovers a target, adds it to the draft and saves both rows', async () => {
    const user = userEvent.setup()
    const view = renderTargets(handler())
    await screen.findByDisplayValue('项目群')
    await user.type(screen.getByLabelText(zh['targets.discover.query']), '项目')
    await user.click(screen.getByRole('button', { name: zh['targets.discover.search'] }))
    expect(await screen.findByText('新群')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['targets.discover.add'] }))
    expect(await screen.findByText(zh['targets.added'].replace('{label}', '新群'))).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['targets.save'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/targets')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/targets')[0] as { value: { rows: readonly unknown[] } }
    expect(body.value.rows).toHaveLength(2)
  })

  it('validates targets and shows the per-target errors', async () => {
    const user = userEvent.setup()
    renderTargets(handler())
    await screen.findByDisplayValue('项目群')
    await user.click(screen.getByRole('button', { name: zh['targets.validate'] }))
    expect(
      await screen.findByText(zh['targets.validate.summary'].replace('{valid}', '1').replace('{invalid}', '1')),
    ).toBeTruthy()
    expect(screen.getByText(/不存在/)).toBeTruthy()
  })

  it('reports channel_unavailable for discovery', async () => {
    const user = userEvent.setup()
    renderTargets(handler({ discover: failure(503, 'channel_unavailable') }))
    await screen.findByDisplayValue('项目群')
    await user.click(screen.getByRole('button', { name: zh['targets.discover.search'] }))
    await waitFor(() => expect(screen.getByText(zh['errors.channelUnavailable'])).toBeTruthy())
  })

  it('removes a row and saves an empty list', async () => {
    const user = userEvent.setup()
    const view = renderTargets(handler())
    await screen.findByDisplayValue('项目群')
    await user.click(screen.getByRole('button', { name: zh['settings.rows.remove'] }))
    await user.click(screen.getByRole('button', { name: zh['targets.save'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/targets')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/targets')[0] as { value: { rows: readonly unknown[] } }
    expect(body.value.rows).toHaveLength(0)
  })

  it('shows the read-only workspace projection and copies a ready path', async () => {
    const user = userEvent.setup()
    const path = 'E:/state/workspaces/conversation-0123456789abcdef'
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const workspaceTargets = targetsFixture([
      targetFixture({ workspace: { path, title: '钉钉 · 项目群', mode: 'ready' } }),
      targetFixture({
        kind: 'at-me',
        id: 'at-me',
        label: '@我',
        workspace: { path: null, title: '钉钉 · @我', mode: 'per-conversation' },
      }),
    ])
    // The editable draft and the read-only projection are independent: the
    // draft keeps its own rows while the projection follows the server view.
    const view = renderTargets(handler({ targets: workspaceTargets }))
    expect(await screen.findByText(path)).toBeTruthy()
    expect(screen.getByText(zh['targets.workspace.hint'])).toBeTruthy()
    expect(screen.getByText(zh['targets.workspace.ready'])).toBeTruthy()
    expect(screen.getByText(zh['targets.workspace.perConversation'])).toBeTruthy()
    const copy = screen.getAllByRole('button', { name: new RegExp(zh['targets.workspace.copy']) })
    expect(copy).toHaveLength(1)
    await user.click(copy[0] as HTMLElement)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path))
    expect(await screen.findByText(zh['targets.workspace.copied'])).toBeTruthy()

    // The projection is display-only: a save must never carry it back.
    await screen.findByDisplayValue('项目群')
    await user.click(screen.getByRole('switch', { name: '仅 @ 1' }))
    await user.click(screen.getByRole('button', { name: zh['targets.save'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/targets')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/targets')[0] as { value: { rows: readonly unknown[] } }
    expect(JSON.stringify(body.value.rows)).not.toContain('"workspace"')
    expect(JSON.stringify(body.value.rows)).not.toContain('"per-conversation"')
  })

  it('hides the workspace section when the host omits the projection', async () => {
    renderTargets(handler())
    await screen.findByDisplayValue('项目群')
    expect(screen.queryByText(zh['targets.workspace.hint'])).toBeNull()
    expect(screen.queryByText(zh['targets.workspace.title'])).toBeNull()
  })

  it('shows the empty state when no target is configured', async () => {
    renderTargets(handler({ targets: targetsFixture([]), rows: [] }))
    expect(await screen.findByText(zh['targets.empty'])).toBeTruthy()
  })

  async function openArchiveDialog(user: ReturnType<typeof userEvent.setup>, label = '项目群'): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: zh['targets.archive.openAria'].replace('{label}', label) }))
    return await screen.findByRole('dialog')
  }

  it('offers the archive action only for a ready workspace', async () => {
    const perConversation = targetFixture({
      kind: 'at-me',
      id: 'at-me',
      label: '@我',
      workspace: { path: null, title: '钉钉 · @我', mode: 'per-conversation' },
    })
    renderTargets(handler({ targets: targetsFixture([...readyTargets().targets, perConversation]) }))
    const button = await screen.findByRole('button', {
      name: zh['targets.archive.openAria'].replace('{label}', '项目群'),
    })
    expect(button.textContent).toBe(zh['targets.archive.open'])
    expect(screen.queryByRole('button', { name: zh['targets.archive.openAria'].replace('{label}', '@我') })).toBeNull()
    expect(screen.getByText(zh['targets.workspace.perConversation'])).toBeTruthy()
  })

  it('opens the confirmation dialog with the stop switch off and sends nothing on cancel', async () => {
    const user = userEvent.setup()
    const view = renderTargets(handler({ targets: readyTargets() }))
    expect(await screen.findByText(workspacePath)).toBeTruthy()
    const dialog = await openArchiveDialog(user)
    expect(within(dialog).getByText(zh['targets.archive.title'])).toBeTruthy()
    expect(within(dialog).getByText(zh['targets.archive.body'])).toBeTruthy()
    expect(within(dialog).getByText(zh['targets.archive.warning'])).toBeTruthy()
    const toggle = within(dialog).getByRole('switch', { name: zh['targets.archive.stopActivity'] })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requestCount(view.fetchMock, 'POST', archiveRoute('group-1'))).toBe(0)
  })

  it('posts the encoded target id and the flag chosen in the dialog', async () => {
    const user = userEvent.setup()
    const id = 'group 1'
    const view = renderTargets(handler({ targets: readyTargets({ id }) }))
    expect(await screen.findByText(workspacePath)).toBeTruthy()
    let dialog = await openArchiveDialog(user)
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'POST', archiveRoute(id))).toHaveLength(1))
    expect(requestBodies(view.fetchMock, 'POST', archiveRoute(id))[0]).toEqual({ stopActivity: false })
    const posted = view.fetchMock.mock.calls.find(([input, init]) => {
      const url = new URL(String(input), 'http://127.0.0.1')
      return (init?.method ?? 'GET') === 'POST' && pathOf(url) === archiveRoute(id)
    })
    expect(String(posted?.[0])).toContain('/targets/group%201/archive-sessions')

    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.close'] }))
    dialog = await openArchiveDialog(user)
    const toggle = within(dialog).getByRole('switch', { name: zh['targets.archive.stopActivity'] })
    await user.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'POST', archiveRoute(id))).toHaveLength(2))
    expect(requestBodies(view.fetchMock, 'POST', archiveRoute(id))[1]).toEqual({ stopActivity: true })
  })

  it('keeps the dialog open and reports counts, truncation and rotation', async () => {
    const user = userEvent.setup()
    const result = archiveResult({
      archived: ['s1', 's2'],
      alreadyArchived: ['s3'],
      refused: [{ sessionId: 's4', activity: [{ kind: 'reply', items: [{ id: 'item-1', label: '当前回复' }] }] }],
      missing: ['s5'],
      failed: [{ sessionId: 's6', error: 'archive_failed' }],
      replySessionRotated: true,
      truncated: true,
      candidateCount: 42,
    })
    const view = renderTargets(handler({ targets: readyTargets(), archive: () => reply(200, result) }))
    expect(await screen.findByText(workspacePath)).toBeTruthy()
    const dialog = await openArchiveDialog(user)
    const targetsLoads = requestCount(view.fetchMock, 'GET', 'targets')
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    expect(await within(dialog).findByText(zh['targets.archive.resultTitle'])).toBeTruthy()
    expect(within(dialog).getByText(zh['targets.archive.archived'].replace('{count}', '2'))).toBeTruthy()
    expect(within(dialog).getByText(zh['targets.archive.alreadyArchived'].replace('{count}', '1'))).toBeTruthy()
    expect(within(dialog).getByText(zh['targets.archive.refused'].replace('{count}', '1'))).toBeTruthy()
    expect(within(dialog).getByText(zh['targets.archive.missing'].replace('{count}', '1'))).toBeTruthy()
    expect(within(dialog).getByText(zh['targets.archive.failed'].replace('{count}', '1'))).toBeTruthy()
    expect(within(dialog).getByText(/reply/)).toBeTruthy()
    expect(within(dialog).getByText(/当前回复/)).toBeTruthy()
    expect(
      within(dialog).getByText(zh['targets.archive.truncated'].replace('{count}', '42').replace('{processed}', '6')),
    ).toBeTruthy()
    expect(within(dialog).getByText(zh['targets.archive.rotated'])).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: zh['targets.archive.close'] })).toBeTruthy()
    await waitFor(() => expect(requestCount(view.fetchMock, 'GET', 'targets')).toBe(targetsLoads + 1))
  })

  it('reports the unchanged reply session when no rotation happened', async () => {
    const user = userEvent.setup()
    renderTargets(handler({ targets: readyTargets(), archive: () => reply(200, archiveResult()) }))
    expect(await screen.findByText(workspacePath)).toBeTruthy()
    const dialog = await openArchiveDialog(user)
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    expect(await within(dialog).findByText(zh['targets.archive.notRotated'])).toBeTruthy()
  })

  const archiveFailures = [
    [400, 'per_conversation_workspace', zh['errors.archivePerConversation']],
    [404, 'unknown_target', zh['errors.archiveUnknownTarget']],
    [503, 'state_unavailable', zh['errors.archiveUnavailable']],
    [409, 'conflict', zh['errors.refused'].replace('{code}', 'conflict')],
  ] as const

  it.each(archiveFailures)('maps the %i %s failure onto localized copy', async (status, code, message) => {
    const user = userEvent.setup()
    renderTargets(handler({ targets: readyTargets(), archive: () => failure(status, code) }))
    expect(await screen.findByText(workspacePath)).toBeTruthy()
    const dialog = await openArchiveDialog(user)
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    expect(await within(dialog).findByText(zh['targets.archive.error'].replace('{message}', message))).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] })).toBeTruthy()
  })

  it('keeps the dialog open and succeeds on a retry after a failure', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const view = renderTargets(
      handler({
        targets: readyTargets(),
        archive: () => {
          attempts += 1
          return attempts === 1 ? failure(503, 'state_unavailable') : reply(200, archiveResult())
        },
      }),
    )
    expect(await screen.findByText(workspacePath)).toBeTruthy()
    const dialog = await openArchiveDialog(user)
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    expect(
      await within(dialog).findByText(
        zh['targets.archive.error'].replace('{message}', zh['errors.archiveUnavailable']),
      ),
    ).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    expect(await within(dialog).findByText(zh['targets.archive.resultTitle'])).toBeTruthy()
    expect(requestBodies(view.fetchMock, 'POST', archiveRoute('group-1'))).toHaveLength(2)
  })

  it('closes with Escape and clears the stop switch and previous result', async () => {
    const user = userEvent.setup()
    renderTargets(handler({ targets: readyTargets() }))
    expect(await screen.findByText(workspacePath)).toBeTruthy()
    let dialog = await openArchiveDialog(user)
    await user.click(within(dialog).getByRole('switch', { name: zh['targets.archive.stopActivity'] }))
    expect(
      within(dialog).getByRole('switch', { name: zh['targets.archive.stopActivity'] }).getAttribute('aria-checked'),
    ).toBe('true')
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    expect(await within(dialog).findByText(zh['targets.archive.resultTitle'])).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = await openArchiveDialog(user)
    expect(within(dialog).queryByText(zh['targets.archive.resultTitle'])).toBeNull()
    expect(
      within(dialog).getByRole('switch', { name: zh['targets.archive.stopActivity'] }).getAttribute('aria-checked'),
    ).toBe('false')
  })

  it('disables both dialog buttons and shows pending copy while the request is in flight', async () => {
    const user = userEvent.setup()
    const view = renderTargets(handler({ targets: readyTargets() }))
    expect(await screen.findByText(workspacePath)).toBeTruthy()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = view.fetchMock.getMockImplementation()
    expect(original).toBeDefined()
    view.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://127.0.0.1')
      if ((init?.method ?? 'GET') === 'POST' && pathOf(url).endsWith('/archive-sessions')) await gate
      return original!(input, init)
    })
    const dialog = await openArchiveDialog(user)
    await user.click(within(dialog).getByRole('button', { name: zh['targets.archive.confirm'] }))
    const pending = await within(dialog).findByRole('button', { name: zh['targets.archive.pending'] })
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    expect(
      (within(dialog).getByRole('button', { name: zh['targets.archive.cancel'] }) as HTMLButtonElement).disabled,
    ).toBe(true)
    release()
    expect(await within(dialog).findByText(zh['targets.archive.resultTitle'])).toBeTruthy()
  })
})
