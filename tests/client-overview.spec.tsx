// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { zh } from '../src/client/locale.ts'
import {
  auditFixture,
  auditPage,
  failure,
  overviewFixture,
  pathOf,
  reply,
  renderPanel,
  requestBodies,
  resetPanelTest,
  tasksPage,
} from './client-harness.tsx'

afterEach(resetPanelTest)

function stat(label: string): HTMLElement {
  const card = screen.getByRole('heading', { name: zh['overview.counts.title'] }).closest('section')
  if (!card) throw new Error('missing counters card')
  const element = within(card).getByText(label).parentElement
  if (!element) throw new Error(`missing stat ${label}`)
  return element
}

function handler(overrides: { readonly pause?: () => ReturnType<typeof reply> } = {}) {
  return (request: { url: URL; method: string }) => {
    const path = pathOf(request.url)
    if (path === 'overview') return reply(200, overviewFixture())
    if (path === 'tasks') return reply(200, tasksPage([], null))
    if (path === 'audit') return reply(200, auditPage([auditFixture({ action: 'task.approved' })]))
    if (path === 'monitor/pause' && request.method === 'POST') {
      return overrides.pause ? overrides.pause() : reply(200, { paused: true })
    }
    return undefined
  }
}

describe('overview page', () => {
  it('renders counters, recent activity and health checks from the host routes', async () => {
    renderPanel(handler())
    expect(await screen.findByText(zh['overview.counts.awaitingApproval'])).toBeTruthy()
    expect(within(stat(zh['overview.counts.awaitingApproval'])).getByText('3')).toBeTruthy()
    expect(within(stat(zh['overview.counts.threads'])).getByText('7')).toBeTruthy()
    expect(within(stat(zh['overview.counts.targets'])).getByText('2')).toBeTruthy()
    expect(within(stat(zh['overview.counts.running'])).getByText('0')).toBeTruthy()
    expect(await screen.findByText('task.approved')).toBeTruthy()
    expect(screen.getByText(zh['health.check.database'])).toBeTruthy()
  })

  it('pauses monitoring through POST monitor/pause and refreshes the overview', async () => {
    const user = userEvent.setup()
    const view = renderPanel(handler())
    const toggle = await screen.findByRole('switch', { name: zh['aria.pauseToggle'] })
    await user.click(toggle)
    await waitFor(() => expect(requestBodies(view.fetchMock, 'POST', 'monitor/pause')).toEqual([{ paused: true }]))
    expect(await screen.findByText(zh['overview.pause.saved'])).toBeTruthy()
    expect(
      view.fetchMock.mock.calls.filter(([input]) => pathOf(new URL(String(input), 'http://127.0.0.1')) === 'overview'),
    ).toHaveLength(2)
  })

  it('restores the switch and shows the failure when pausing fails', async () => {
    const user = userEvent.setup()
    renderPanel(handler({ pause: () => failure(503, 'state_unavailable') }))
    const toggle = await screen.findByRole('switch', { name: zh['aria.pauseToggle'] })
    await user.click(toggle)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(zh['errors.notReady'])).toBeTruthy()
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('navigates to another tab from the quick links', async () => {
    const user = userEvent.setup()
    renderPanel(handler())
    await user.click(await screen.findByRole('button', { name: zh['overview.quick.tasks'] }))
    expect(screen.getByRole('tab', { name: zh['tabs.tasks'] }).getAttribute('aria-selected')).toBe('true')
  })

  it('shows an error alert with retry when the overview route fails, then recovers', async () => {
    const user = userEvent.setup()
    let failed = false
    const view = renderPanel((request) => {
      const path = pathOf(request.url)
      if (path === 'overview' && !failed) {
        failed = true
        return failure(500, 'internal_error')
      }
      if (path === 'overview') return reply(200, overviewFixture())
      if (path === 'tasks') return reply(200, tasksPage([]))
      if (path === 'audit') return reply(200, auditPage([]))
      return undefined
    })
    expect(await screen.findByText(zh['overview.error.title'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['common.retry'] }))
    await waitFor(() =>
      expect(
        view.fetchMock.mock.calls.filter(
          ([input]) => pathOf(new URL(String(input), 'http://127.0.0.1')) === 'overview',
        ),
      ).toHaveLength(2),
    )
    expect(await screen.findByText(zh['overview.counts.awaitingApproval'])).toBeTruthy()
  })
})
