// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { zh } from '../src/client/locale.ts'
import { auditFixture, auditPage, failure, pathOf, reply, renderPanel, resetPanelTest } from './client-harness.tsx'

afterEach(resetPanelTest)

function renderAudit(handler: Parameters<typeof renderPanel>[0]) {
  window.location.hash = '#audit'
  return renderPanel(handler)
}

describe('audit page', () => {
  it('renders newest-first rows and appends the next page', async () => {
    const user = userEvent.setup()
    renderAudit((request) => {
      if (pathOf(request.url) !== 'audit') return undefined
      const offset = Number(request.url.searchParams.get('offset') ?? '0')
      if (offset === 0) return reply(200, auditPage([auditFixture({ id: '2', action: 'task.approved' })], 1))
      return reply(200, auditPage([auditFixture({ id: '1', action: 'message.received', actor: 'assistant' })], null))
    })
    expect(await screen.findByText('task.approved')).toBeTruthy()
    expect(screen.getByText(zh['audit.actor.owner'])).toBeTruthy()
    expect(screen.getByText(zh['audit.outcome.ok'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['aria.loadMore'] }))
    expect(await screen.findByText('message.received')).toBeTruthy()
    expect(screen.getByText(zh['audit.actor.assistant'])).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: zh['aria.loadMore'] })).toBeNull())
  })

  it('shows the empty state', async () => {
    renderAudit((request) => {
      if (pathOf(request.url) === 'audit') return reply(200, auditPage([], null))
      return undefined
    })
    expect(await screen.findByText(zh['audit.empty'])).toBeTruthy()
  })

  it('shows the load error and retries', async () => {
    const user = userEvent.setup()
    let failed = false
    renderAudit((request) => {
      if (pathOf(request.url) !== 'audit') return undefined
      if (!failed) {
        failed = true
        return failure(500, 'internal_error')
      }
      return reply(200, auditPage([auditFixture()], null))
    })
    expect(await screen.findByText(zh['audit.loadError'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['common.retry'] }))
    expect(await screen.findByText('task.approved')).toBeTruthy()
  })

  it('localizes the denied outcome', async () => {
    renderAudit((request) => {
      if (pathOf(request.url) === 'audit') return reply(200, auditPage([auditFixture({ outcome: 'denied' })], null))
      return undefined
    })
    expect(await screen.findByText(zh['audit.outcome.denied'])).toBeTruthy()
  })
})
