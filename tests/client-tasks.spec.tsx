// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { zh } from '../src/client/locale.ts'
import {
  approvalFixture,
  failure,
  pathOf,
  reply,
  renderPanel,
  requestBodies,
  requestCount,
  resetPanelTest,
  settingsFixture,
  taskDetailFixture,
  taskFixture,
  tasksPage,
} from './client-harness.tsx'
import type { Reply } from './client-harness.tsx'

afterEach(resetPanelTest)

function renderTasks(handler: Parameters<typeof renderPanel>[0], options: Parameters<typeof renderPanel>[1] = {}) {
  window.location.hash = '#tasks'
  return renderPanel(handler, options)
}

function baseHandler(detail: unknown, actions: Record<string, Reply> = {}) {
  return (request: { url: URL; method: string }) => {
    const path = pathOf(request.url)
    if (path === 'tasks') return reply(200, tasksPage([taskFixture()]))
    if (path === 'tasks/task-1' && request.method === 'GET') return reply(200, detail)
    if (path === 'settings') {
      return reply(
        200,
        settingsFixture({ tasks: { value: { ...settingsDefaults(), workspaceRoot: 'C:\\work' }, revision: 2 } }),
      )
    }
    if (path.startsWith('tasks/task-1/') && request.method === 'POST') {
      const action = path.split('/').pop() ?? ''
      const canned = actions[action]
      if (canned) return canned
      return reply(200, { task: taskFixture({ status: 'queued' }), approval: approvalFixture({ status: 'approved' }) })
    }
    return undefined
  }
}

function settingsDefaults() {
  const value = settingsFixture().blocks.tasks.value
  return { ...(value as Record<string, unknown>) }
}

async function openDetail(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: zh['tasks.open'] }))
  await screen.findByText(zh['tasks.approval.title'])
}

describe('tasks page', () => {
  it('filters with the wire status query', async () => {
    const user = userEvent.setup()
    const view = renderTasks((request) => {
      const path = pathOf(request.url)
      if (path === 'tasks') return reply(200, tasksPage([taskFixture({ status: 'failed' })]))
      return undefined
    })
    await screen.findByText('整理周报')
    await user.click(screen.getByRole('button', { name: zh['tasks.status.failed'] }))
    await waitFor(() => {
      const calls = view.fetchMock.mock.calls.filter(
        ([input]) => pathOf(new URL(String(input), 'http://127.0.0.1')) === 'tasks',
      )
      expect(
        calls.some(([input]) => new URL(String(input), 'http://127.0.0.1').searchParams.get('status') === 'failed'),
      ).toBe(true)
    })
  })

  it('opens a detail with brief, approval, source messages and execution limits', async () => {
    const user = userEvent.setup()
    renderTasks(baseHandler(taskDetailFixture()))
    await openDetail(user)
    expect(screen.getAllByText('整理周报').length).toBeGreaterThan(0)
    expect(screen.getByText(zh['tasks.detail.brief'])).toBeTruthy()
    expect(screen.getAllByText(zh['tasks.approval.pending']).length).toBeGreaterThan(0)
    expect(screen.getByText('帮我整理一下周报')).toBeTruthy()
    expect(screen.getByText(zh['tasks.detail.executionUnavailable'])).toBeTruthy()
  })

  it('validates the approve workspace before sending a request', async () => {
    const user = userEvent.setup()
    const view = renderTasks(baseHandler(taskDetailFixture()))
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: zh['tasks.action.approve'] }))
    const input = await screen.findByLabelText(zh['tasks.approve.workspace'])
    await user.type(input, 'relative/path')
    await user.click(screen.getByRole('button', { name: zh['tasks.approve.confirm'] }))
    expect(await screen.findByText(zh['tasks.approve.workspaceInvalid'])).toBeTruthy()
    expect(requestBodies(view.fetchMock, 'POST', 'tasks/task-1/approve')).toHaveLength(0)
  })

  it('approves with workspace and note and refreshes the detail', async () => {
    const user = userEvent.setup()
    const view = renderTasks(baseHandler(taskDetailFixture()))
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: zh['tasks.action.approve'] }))
    await user.type(await screen.findByLabelText(zh['tasks.approve.workspace']), 'C:\\work\\task')
    await user.type(screen.getByLabelText(zh['tasks.approve.note']), '可以')
    await user.click(screen.getByRole('button', { name: zh['tasks.approve.confirm'] }))
    await waitFor(() =>
      expect(requestBodies(view.fetchMock, 'POST', 'tasks/task-1/approve')).toEqual([
        { approvalId: 'approval-1', workspace: 'C:\\work\\task', note: '可以' },
      ]),
    )
    expect(await screen.findByText(zh['tasks.approve.success'])).toBeTruthy()
    await waitFor(() => expect(requestCount(view.fetchMock, 'GET', 'tasks/task-1')).toBeGreaterThanOrEqual(2))
  })

  it('reports a refused approval and reloads the detail', async () => {
    const user = userEvent.setup()
    const view = renderTasks(baseHandler(taskDetailFixture(), { approve: failure(409, 'alreadyDecided') }))
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: zh['tasks.action.approve'] }))
    await user.click(screen.getByRole('button', { name: zh['tasks.approve.confirm'] }))
    const expected = zh['errors.refused'].replace('{code}', 'alreadyDecided')
    await waitFor(() =>
      expect(screen.getAllByRole('alert').some((node) => node.textContent?.includes(expected))).toBe(true),
    )
    await waitFor(() => expect(requestCount(view.fetchMock, 'GET', 'tasks/task-1')).toBeGreaterThanOrEqual(2))
  })

  it('disables approval but allows retry only for failed tasks', async () => {
    const user = userEvent.setup()
    const failed = taskDetailFixture({
      task: taskFixture({ status: 'failed' }),
      approval: approvalFixture({ status: 'approved' }),
    })
    renderTasks(baseHandler(failed))
    await openDetail(user)
    expect((screen.getByRole('button', { name: zh['tasks.action.approve'] }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: zh['tasks.action.reject'] }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: zh['tasks.action.retry'] }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('cancels a running task with an optional reason', async () => {
    const user = userEvent.setup()
    const running = taskDetailFixture({
      task: taskFixture({ status: 'running' }),
      approval: approvalFixture({ status: 'approved' }),
    })
    const view = renderTasks(baseHandler(running))
    await openDetail(user)
    expect((screen.getByRole('button', { name: zh['tasks.action.approve'] }) as HTMLButtonElement).disabled).toBe(true)
    const cancel = screen.getByRole('button', { name: zh['tasks.action.cancel'] }) as HTMLButtonElement
    expect(cancel.disabled).toBe(false)
    await user.click(cancel)
    await user.type(screen.getByLabelText(zh['tasks.cancel.reason']), '不需要了')
    await user.click(screen.getByRole('button', { name: zh['tasks.cancel.confirm'] }))
    await waitFor(() =>
      expect(requestBodies(view.fetchMock, 'POST', 'tasks/task-1/cancel')).toEqual([{ reason: '不需要了' }]),
    )
  })

  it('opens the execution session when the detail exposes one', async () => {
    const user = userEvent.setup()
    const openSession = vi.fn(async () => {})
    const detail = taskDetailFixture(
      {},
      { assignment: { sessionId: 'sess-1', workspace: 'C:\\work', state: 'running', outcome: null } },
    )
    renderTasks(baseHandler(detail), { openSession })
    await openDetail(user)
    await user.click(await screen.findByRole('button', { name: zh['tasks.detail.openSession'] }))
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('sess-1'))
  })

  it('shows the unavailable session hint when the assignment has no session id', async () => {
    const user = userEvent.setup()
    const detail = taskDetailFixture({}, { assignment: { workspace: 'C:\\work', state: 'pending', outcome: null } })
    renderTasks(baseHandler(detail))
    await openDetail(user)
    expect(await screen.findByText(zh['tasks.sessionUnavailable'])).toBeTruthy()
  })

  it('closes the approval dialog with Escape', async () => {
    const user = userEvent.setup()
    renderTasks(baseHandler(taskDetailFixture()))
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: zh['tasks.action.approve'] }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('completes the approval with the keyboard', async () => {
    const user = userEvent.setup()
    const view = renderTasks(baseHandler(taskDetailFixture()))
    await openDetail(user)
    await user.click(screen.getByRole('button', { name: zh['tasks.action.approve'] }))
    const input = await screen.findByLabelText(zh['tasks.approve.workspace'])
    await user.type(input, 'C:\\work\\task')
    await user.tab()
    await user.tab()
    await user.tab()
    expect(document.activeElement?.textContent).toBe(zh['tasks.approve.confirm'])
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(requestBodies(view.fetchMock, 'POST', 'tasks/task-1/approve')).toEqual([
        { approvalId: 'approval-1', workspace: 'C:\\work\\task' },
      ]),
    )
  })

  it('renders an empty list when no task matches', async () => {
    renderTasks((request) => {
      if (pathOf(request.url) === 'tasks') return reply(200, tasksPage([], null))
      return undefined
    })
    expect(await screen.findByText(zh['tasks.empty'])).toBeTruthy()
  })
})
