/** Threads tab: read-only conversation list and one conversation's messages. */
import { useEffect, useRef, useState } from 'react'
import { call, useApi, useMutation, usePaged } from '../api.ts'
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '../controls.tsx'
import { errorText } from '../errors.ts'
import { timeText } from '../format.ts'
import { usePanel } from '../provider.tsx'
import type { MessageView, ThreadDetail, ThreadsPage } from '../../shared/models.ts'

function ThreadMessages({ threadKey, onBack }: { threadKey: string; onBack: () => void }) {
  const { t, refreshToken, notify } = usePanel()
  const detail = useApi((signal) => call('GET threads/:key', { params: { key: threadKey }, signal }), {
    deps: [threadKey, refreshToken],
  })
  const [older, setOlder] = useState<readonly MessageView[]>([])
  const [before, setBefore] = useState<string | null>(null)
  const initialized = useRef(false)
  const olderPage = useMutation(async (cursor: string) =>
    call('GET threads/:key', { params: { key: threadKey }, query: { before: cursor, limit: 50 } }),
  )

  useEffect(() => {
    if (initialized.current || !detail.data) return
    initialized.current = true
    setBefore(detail.data.nextBefore)
  }, [detail.data])

  const messages: readonly MessageView[] = detail.data ? [...older, ...detail.data.messages] : older
  const thread = detail.data?.thread

  const loadOlder = async () => {
    if (before === null) return
    try {
      const page: ThreadDetail = await olderPage.run(before)
      setOlder((previous) => [...page.messages, ...previous])
      setBefore(page.nextBefore)
    } catch (failure) {
      notify(errorText(failure as Error, t), 'error')
    }
  }

  return (
    <div className="wc-page">
      <PageHeader
        title={thread?.title ?? t('threads.messages')}
        subtitle={t('threads.subtitle')}
        actions={
          <Button size="sm" onClick={onBack}>
            {t('threads.back')}
          </Button>
        }
      />
      <Alert tone="info">{t('threads.limitations')}</Alert>
      {detail.error ? (
        <Alert
          tone="error"
          role="alert"
          title={t('threads.detailError')}
          action={
            <Button size="sm" onClick={detail.reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(detail.error, t)}
        </Alert>
      ) : null}
      {detail.loading && !detail.data ? <Skeleton label={t('common.loading')} rows={4} /> : null}
      {thread ? (
        <Card title={t('threads.detail.info')}>
          <dl className="wc-facts">
            <div>
              <dt>{t('threads.key')}</dt>
              <dd className="wc-mono">{thread.key}</dd>
            </div>
            <div>
              <dt>{t('threads.column.kind')}</dt>
              <dd>
                <Badge tone="neutral">{t(`threads.kind.${thread.kind}` as 'threads.kind.group')}</Badge>
              </dd>
            </div>
            <div>
              <dt>{t('threads.lastMessageAt')}</dt>
              <dd>{timeText(thread.lastMessageAt)}</dd>
            </div>
            <div>
              <dt>{t('threads.unread')}</dt>
              <dd>{thread.unreadCount}</dd>
            </div>
          </dl>
        </Card>
      ) : null}
      <Card
        title={t('threads.messages')}
        actions={
          before !== null && thread ? (
            <Button size="sm" onClick={() => void loadOlder()} disabled={olderPage.pending}>
              {olderPage.pending ? t('common.loading') : t('threads.messages.older')}
            </Button>
          ) : null
        }
      >
        {detail.data && messages.length === 0 ? <EmptyState title={t('threads.messages.empty')} /> : null}
        {messages.map((message) => (
          <article key={message.id} className="wc-message">
            <div className="wc-message-meta">
              <Badge tone={message.direction === 'incoming' ? 'neutral' : 'info'}>
                {message.direction === 'incoming' ? t('threads.direction.incoming') : t('threads.direction.outgoing')}
              </Badge>
              <span>{message.senderName}</span>
              <span className="wc-mono">{message.senderId}</span>
              <span>{timeText(message.sentAt)}</span>
            </div>
            <p className="wc-message-text">{message.text}</p>
          </article>
        ))}
      </Card>
    </div>
  )
}

export function ThreadsPage() {
  const { t, refreshToken } = usePanel()
  const [selected, setSelected] = useState<string>()
  const list = usePaged<ThreadsPage['items'][number]>(
    (offset, signal) => call('GET threads', { signal, query: { offset, limit: 20 } }),
    { deps: [refreshToken] },
  )

  if (selected !== undefined) return <ThreadMessages threadKey={selected} onBack={() => setSelected(undefined)} />

  return (
    <div className="wc-page">
      <PageHeader title={t('tabs.threads')} subtitle={t('threads.subtitle')} />
      {list.error ? (
        <Alert
          tone="error"
          role="alert"
          title={t('threads.loadError')}
          action={
            <Button size="sm" onClick={list.reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(list.error, t)}
        </Alert>
      ) : null}
      <Card
        title={t('threads.list.title')}
        actions={
          list.hasMore ? (
            <Button size="sm" onClick={list.loadMore} disabled={list.loadingMore}>
              {list.loadingMore ? t('common.loading') : t('threads.loadMore')}
            </Button>
          ) : null
        }
      >
        {list.loading && list.items.length === 0 ? <Skeleton label={t('common.loading')} rows={4} /> : null}
        {!list.loading && !list.error && list.items.length === 0 ? <EmptyState title={t('threads.empty')} /> : null}
        {list.items.length > 0 ? (
          <div className="wc-tablewrap">
            <table className="wc-table">
              <thead>
                <tr>
                  <th scope="col">{t('threads.column.title')}</th>
                  <th scope="col">{t('threads.column.kind')}</th>
                  <th scope="col">{t('threads.lastMessageAt')}</th>
                  <th scope="col">{t('threads.unread')}</th>
                  <th scope="col">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((thread) => (
                  <tr key={thread.key} data-clickable="true">
                    <td>
                      <span className="wc-cell-title">{thread.title || thread.key}</span>
                      <span className="wc-cell-meta wc-mono">{thread.key}</span>
                    </td>
                    <td>{t(`threads.kind.${thread.kind}` as 'threads.kind.group')}</td>
                    <td>{timeText(thread.lastMessageAt)}</td>
                    <td>{thread.unreadCount}</td>
                    <td>
                      <Button size="sm" aria-label={t('threads.open')} onClick={() => setSelected(thread.key)}>
                        {t('threads.open')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </div>
  )
}
