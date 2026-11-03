// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { zh } from '../src/client/locale.ts'
import {
  overviewFixture,
  pathOf,
  reply,
  renderPanel,
  resetPanelTest,
  tasksPage,
  threadsPage,
  auditPage,
} from './client-harness.tsx'

afterEach(resetPanelTest)

function overviewHandler() {
  return (request: { url: URL }) => {
    const path = pathOf(request.url)
    if (path === 'overview') return reply(200, overviewFixture())
    if (path === 'tasks') return reply(200, tasksPage([]))
    if (path === 'audit') return reply(200, auditPage([]))
    if (path === 'threads') return reply(200, threadsPage([]))
    return undefined
  }
}

describe('panel shell', () => {
  it('renders all seven tabs and persists the active one', async () => {
    const user = userEvent.setup()
    renderPanel(overviewHandler())
    expect(screen.getAllByRole('tab')).toHaveLength(7)
    expect(screen.getByRole('tab', { name: zh['tabs.overview'] }).getAttribute('aria-selected')).toBe('true')

    await user.click(screen.getByRole('tab', { name: zh['tabs.tasks'] }))

    expect(window.localStorage.getItem('whale-chan.tab')).toBe('tasks')
    expect(window.location.hash).toBe('#tasks')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('wc-tab-tasks')
    expect(screen.getByRole('tab', { name: zh['tabs.tasks'] }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens the tab named by the URL hash before the stored value', () => {
    window.localStorage.setItem('whale-chan.tab', 'targets')
    window.location.hash = '#audit'
    renderPanel(overviewHandler())
    expect(screen.getByRole('tab', { name: zh['tabs.audit'] }).getAttribute('aria-selected')).toBe('true')
  })

  it('falls back to the stored tab when the hash is absent', () => {
    window.localStorage.setItem('whale-chan.tab', 'targets')
    renderPanel(overviewHandler())
    expect(screen.getByRole('tab', { name: zh['tabs.targets'] }).getAttribute('aria-selected')).toBe('true')
  })

  it('moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup()
    renderPanel(overviewHandler())
    const overview = screen.getByRole('tab', { name: zh['tabs.overview'] })
    overview.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: zh['tabs.threads'] }).getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: zh['tabs.audit'] }).getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: zh['tabs.overview'] }).getAttribute('aria-selected')).toBe('true')
  })

  it('keeps all seven tabs reachable while the strip can scroll', async () => {
    const user = userEvent.setup()
    renderPanel(overviewHandler())
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(7)
    tabs[0]?.focus()
    for (let index = 0; index < 6; index += 1) {
      await user.keyboard('{ArrowRight}')
    }
    const audit = screen.getByRole('tab', { name: zh['tabs.audit'] })
    expect(audit.getAttribute('aria-selected')).toBe('true')
    expect(audit.tabIndex).toBe(0)
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1)
    const styles = readFileSync('src/client/client.css', 'utf8')
    const block = styles.slice(styles.indexOf('.wc-tabs {'), styles.indexOf('.wc-tab {'))
    expect(block).toContain('overflow-x: auto')
    expect(block).toContain('scrollbar-width: none')
    expect(block).toContain('background: var(--dsw-alias-bg-base)')
  })

  it('shows the health badge and refreshes it from the header', async () => {
    const user = userEvent.setup()
    let healthCalls = 0
    renderPanel((request) => {
      if (pathOf(request.url) === 'health') {
        healthCalls += 1
        return reply(200, overviewFixture().health)
      }
      if (pathOf(request.url) === 'overview') return reply(200, overviewFixture({ health: overviewFixture().health }))
      if (pathOf(request.url) === 'tasks') return reply(200, tasksPage([]))
      if (pathOf(request.url) === 'audit') return reply(200, auditPage([]))
      return undefined
    })
    const badge = screen.getByLabelText(zh['aria.health'])
    await waitFor(() => expect(within(badge).getByText(zh['health.ok'])).toBeTruthy())
    const before = healthCalls
    await user.click(screen.getByRole('button', { name: zh['aria.refresh'] }))
    await waitFor(() => expect(healthCalls).toBeGreaterThan(before))
  })

  it('reports a failed health read without breaking navigation', async () => {
    renderPanel((request) => {
      if (pathOf(request.url) === 'health')
        return reply(503, { ok: false, error: { code: 'state_unavailable', message: 'no' } })
      if (pathOf(request.url) === 'overview') return reply(200, overviewFixture())
      if (pathOf(request.url) === 'tasks') return reply(200, tasksPage([]))
      if (pathOf(request.url) === 'audit') return reply(200, auditPage([]))
      return undefined
    })
    expect(screen.getAllByRole('tab')).toHaveLength(7)
    await waitFor(() =>
      expect(within(screen.getByLabelText(zh['aria.health'])).getByText(zh['health.unknown'])).toBeTruthy(),
    )
  })
})
