// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { zh } from '../src/client/locale.ts'
import {
  failure,
  pathOf,
  reply,
  renderPanel,
  requestBodies,
  resetPanelTest,
  settingsFixture,
  targetFixture,
  targetsFixture,
} from './client-harness.tsx'

afterEach(resetPanelTest)

const row = {
  kind: 'group' as const,
  id: 'group-1',
  label: '项目群',
  mentionOnly: true,
  replyMode: 'auto' as const,
  enabled: true,
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

  it('shows the empty state when no target is configured', async () => {
    renderTargets(handler({ targets: targetsFixture([]), rows: [] }))
    expect(await screen.findByText(zh['targets.empty'])).toBeTruthy()
  })
})
