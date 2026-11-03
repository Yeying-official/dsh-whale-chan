// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { zh } from '../src/client/locale.ts'
import {
  failure,
  messageFixture,
  pathOf,
  reply,
  renderPanel,
  requestCount,
  resetPanelTest,
  threadDetailFixture,
  threadFixture,
  threadsPage,
} from './client-harness.tsx'

afterEach(resetPanelTest)

const first = threadFixture({ key: 'group:one', title: '项目一群' })

function renderThreads(handler: Parameters<typeof renderPanel>[0]) {
  window.location.hash = '#threads'
  return renderPanel(handler)
}
const second = threadFixture({ key: 'dm:two', title: '小明', kind: 'dm', unreadCount: 2 })

function listHandler(options: { readonly fail?: boolean } = {}) {
  return (request: { url: URL }) => {
    const path = pathOf(request.url)
    if (path === 'threads') {
      if (options.fail) return failure(500, 'internal_error')
      const offset = Number(request.url.searchParams.get('offset') ?? '0')
      if (offset === 0) return reply(200, threadsPage([first, second], 2))
      return reply(200, threadsPage([threadFixture({ key: 'group:three', title: '第三群' })], null))
    }
    if (path.startsWith('threads/')) {
      const before = request.url.searchParams.get('before')
      if (before) {
        return reply(200, threadDetailFixture(first, [messageFixture({ id: 'old-1', text: '更早的消息' })], null))
      }
      return reply(
        200,
        threadDetailFixture(first, [
          messageFixture({ id: 'm-1', text: '帮我整理一下周报' }),
          messageFixture({ id: 'm-2', text: '已收到', direction: 'outgoing', senderName: '鲸鱼酱' }),
        ]),
      )
    }
    return undefined
  }
}

describe('threads page', () => {
  it('lists conversations, opens one and returns to the list', async () => {
    const user = userEvent.setup()
    const view = renderThreads(listHandler())
    expect(await screen.findByText('项目一群')).toBeTruthy()
    expect(screen.getByText('小明')).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: zh['threads.open'] })[0]!)
    expect(await screen.findByText('帮我整理一下周报')).toBeTruthy()
    expect(screen.getByText('已收到')).toBeTruthy()
    expect(screen.getByText(zh['threads.limitations'])).toBeTruthy()
    expect(requestCount(view.fetchMock, 'GET', 'threads/group%3Aone')).toBe(1)
    await user.click(screen.getByRole('button', { name: zh['threads.back'] }))
    expect(await screen.findByText('项目一群')).toBeTruthy()
  })

  it('loads the next page of conversations', async () => {
    const user = userEvent.setup()
    renderThreads(listHandler())
    await user.click(await screen.findByRole('button', { name: zh['threads.loadMore'] }))
    expect(await screen.findByText('第三群')).toBeTruthy()
  })

  it('loads older messages with the before cursor', async () => {
    const user = userEvent.setup()
    renderThreads((request) => {
      const path = pathOf(request.url)
      if (path === 'threads') return reply(200, threadsPage([first], null))
      if (path.startsWith('threads/')) {
        const before = request.url.searchParams.get('before')
        return reply(
          200,
          before
            ? threadDetailFixture(first, [messageFixture({ id: 'old', text: '更早的消息' })], null)
            : threadDetailFixture(first, [messageFixture({ id: 'new', text: '最新消息' })], '2026-11-02T00:00:00.000Z'),
        )
      }
      return undefined
    })
    await user.click(await screen.findByRole('button', { name: zh['threads.open'] }))
    const older = await screen.findByRole('button', { name: zh['threads.messages.older'] })
    await user.click(older)
    expect(await screen.findByText('更早的消息')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: zh['threads.messages.older'] })).toBeNull())
  })

  it('shows the empty state when there are no conversations', async () => {
    renderThreads((request) => {
      if (pathOf(request.url) === 'threads') return reply(200, threadsPage([], null))
      return undefined
    })
    expect(await screen.findByText(zh['threads.empty'])).toBeTruthy()
  })

  it('shows the load error and retries', async () => {
    const user = userEvent.setup()
    let fail = true
    renderThreads((request) => {
      if (pathOf(request.url) !== 'threads') return undefined
      if (fail) {
        fail = false
        return failure(500, 'internal_error')
      }
      return reply(200, threadsPage([first], null))
    })
    expect(await screen.findByText(zh['threads.loadError'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['common.retry'] }))
    expect(await screen.findByText('项目一群')).toBeTruthy()
  })
})
