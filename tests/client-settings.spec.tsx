// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { zh } from '../src/client/locale.ts'
import { SETTINGS_DEFAULTS } from '../src/shared/settings.ts'
import {
  failure,
  pathOf,
  reply,
  renderPanel,
  requestBodies,
  resetPanelTest,
  settingsFixture,
} from './client-harness.tsx'
import type { Reply } from './client-harness.tsx'

afterEach(resetPanelTest)

function renderSettings(handler: Parameters<typeof renderPanel>[0]) {
  window.location.hash = '#settings'
  return renderPanel(handler)
}

interface HandlerOptions {
  readonly put?: (body: { value: Record<string, unknown>; revision: number }, block: string) => Reply
  readonly skipFirstSettings?: boolean
}

function settingsHandler(options: HandlerOptions = {}) {
  let revision = 1
  let failOnce = options.skipFirstSettings === true
  return (request: { url: URL; method: string; body: unknown }) => {
    const path = pathOf(request.url)
    if (path === 'settings' && request.method === 'GET') {
      if (failOnce) {
        failOnce = false
        return failure(500, 'internal_error')
      }
      return reply(200, settingsFixture({ monitor: { value: structuredClone(SETTINGS_DEFAULTS.monitor), revision } }))
    }
    if (path.startsWith('settings/') && request.method === 'PUT') {
      const block = path.slice('settings/'.length)
      const body = request.body as { value: Record<string, unknown>; revision: number }
      if (options.put) {
        const result = options.put(body, block)
        if (result.body && typeof result.body === 'object' && 'revision' in result.body) {
          revision = Number((result.body as { revision: number }).revision)
        }
        return result
      }
      revision = body.revision + 1
      return reply(200, { block, value: body.value, revision })
    }
    return undefined
  }
}

describe('settings page', () => {
  it('renders the registry fields and switches between blocks', async () => {
    const user = userEvent.setup()
    renderSettings(settingsHandler())
    expect(await screen.findByLabelText(zh['settings.monitor.intervalSeconds.label'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['settings.block.reply.label'] }))
    expect(await screen.findByText(zh['settings.reply.allowedSenders.label'])).toBeTruthy()
  })

  it('saves one block with the revision and a numeric edit', async () => {
    const user = userEvent.setup()
    const view = renderSettings(settingsHandler())
    const input = await screen.findByLabelText(zh['settings.monitor.intervalSeconds.label'])
    await user.clear(input)
    await user.type(input, '60')
    await user.click(screen.getByRole('button', { name: zh['settings.saveBlock'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/monitor')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/monitor')[0] as {
      value: Record<string, unknown>
      revision: number
    }
    expect(body.value['intervalSeconds']).toBe(60)
    expect(body.revision).toBe(1)
    expect(
      await screen.findByText(zh['settings.blockSaved'].replace('{block}', zh['settings.block.monitor.label'])),
    ).toBeTruthy()
  })

  it('saves a boolean switch', async () => {
    const user = userEvent.setup()
    const view = renderSettings(settingsHandler())
    const toggle = await screen.findByRole('switch', { name: zh['settings.monitor.enabled.label'] })
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: zh['settings.saveBlock'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/monitor')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/monitor')[0] as { value: Record<string, unknown> }
    expect(body.value['enabled']).toBe(false)
  })

  it('adds a string-list entry and saves it', async () => {
    const user = userEvent.setup()
    const view = renderSettings(settingsHandler())
    await screen.findByLabelText(zh['settings.monitor.intervalSeconds.label'])
    await user.click(screen.getByRole('button', { name: zh['settings.block.reply.label'] }))
    await user.click(screen.getAllByRole('button', { name: zh['settings.list.add'] })[0]!)
    const item = await screen.findByLabelText(zh['settings.list.item'].replace('{index}', '1'))
    await user.type(item, 'boss')
    await user.click(screen.getByRole('button', { name: zh['settings.saveBlock'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/reply')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/reply')[0] as { value: Record<string, unknown> }
    expect(body.value['allowedSenders']).toEqual(['boss'])
  })

  it('locates server-side field issues on the matching control', async () => {
    const user = userEvent.setup()
    renderSettings(
      settingsHandler({
        put: () => failure(400, 'invalid_settings', { issues: [{ path: 'intervalSeconds', message: 'too small' }] }),
      }),
    )
    const input = await screen.findByLabelText(zh['settings.monitor.intervalSeconds.label'])
    await user.clear(input)
    await user.type(input, '60')
    await user.click(screen.getByRole('button', { name: zh['settings.saveBlock'] }))
    expect(await screen.findByText('too small')).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('recovers from a revision conflict and retries with the actual revision', async () => {
    const user = userEvent.setup()
    let writes = 0
    const view = renderSettings(
      settingsHandler({
        put: (body) => {
          writes += 1
          if (writes === 1) return failure(409, 'settings_conflict', { actualRevision: 7 })
          return reply(200, { block: 'monitor', value: body.value, revision: body.revision + 1 })
        },
      }),
    )
    const input = await screen.findByLabelText(zh['settings.monitor.intervalSeconds.label'])
    await user.clear(input)
    await user.type(input, '30')
    await user.click(screen.getByRole('button', { name: zh['settings.saveBlock'] }))
    expect(await screen.findByText(zh['settings.conflict'])).toBeTruthy()
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/monitor')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: zh['settings.saveBlock'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/monitor')).toHaveLength(2))
    expect((requestBodies(view.fetchMock, 'PUT', 'settings/monitor')[1] as { revision: number }).revision).toBe(7)
  })

  it('explains the dangerous settings', async () => {
    const user = userEvent.setup()
    renderSettings(settingsHandler())
    expect(await screen.findByText(zh['settings.danger.paused'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['settings.block.advanced.label'] }))
    expect(await screen.findByText(zh['settings.danger.dryRun'])).toBeTruthy()
  })

  it('saves with the keyboard', async () => {
    const user = userEvent.setup()
    const view = renderSettings(settingsHandler())
    await screen.findByLabelText(zh['settings.monitor.intervalSeconds.label'])
    const toggle = screen.getByRole('switch', { name: zh['settings.monitor.enabled.label'] })
    await user.click(toggle)
    const save = screen.getByRole('button', { name: zh['settings.saveBlock'] })
    save.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/monitor')).toHaveLength(1))
  })

  it('retries the whole settings read after a load failure', async () => {
    const user = userEvent.setup()
    renderSettings(settingsHandler({ skipFirstSettings: true }))
    expect(await screen.findByText(zh['settings.loadError'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['common.retry'] }))
    expect(await screen.findByLabelText(zh['settings.monitor.intervalSeconds.label'])).toBeTruthy()
  })

  it('keeps a dirty block when another block is opened', async () => {
    const user = userEvent.setup()
    renderSettings(settingsHandler())
    const toggle = await screen.findByRole('switch', { name: zh['settings.monitor.enabled.label'] })
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: zh['settings.block.reply.label'] }))
    await user.click(screen.getByRole('button', { name: zh['settings.block.monitor.label'] }))
    expect(screen.getByRole('button', { name: zh['settings.saveBlock'] })).toBeTruthy()
    expect(
      (screen.getByRole('switch', { name: zh['settings.monitor.enabled.label'] }) as HTMLButtonElement).getAttribute(
        'aria-checked',
      ),
    ).toBe('false')
  })
})
