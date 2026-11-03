/** Audit tab: paged, newest-first record of domain events and owner actions. */
import { call, usePaged } from '../api.ts'
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '../controls.tsx'
import { errorText } from '../errors.ts'
import { timeText } from '../format.ts'
import { usePanel } from '../provider.tsx'
import { outcomeTone } from '../status.ts'
import type { AuditEntry } from '../../shared/models.ts'

function actorLabel(entry: AuditEntry, t: ReturnType<typeof usePanel>['t']): string {
  if (entry.actor === 'owner') return t('audit.actor.owner')
  if (entry.actor === 'assistant') return t('audit.actor.assistant')
  return entry.actor
}

function outcomeLabel(entry: AuditEntry, t: ReturnType<typeof usePanel>['t']): string {
  if (entry.outcome === 'ok') return t('audit.outcome.ok')
  if (entry.outcome === 'denied') return t('audit.outcome.denied')
  return t('audit.outcome.failed')
}

export function AuditPage() {
  const { t, refreshToken } = usePanel()
  const audit = usePaged<AuditEntry>((offset, signal) => call('GET audit', { signal, query: { offset, limit: 50 } }), {
    deps: [refreshToken],
  })

  return (
    <div className="wc-page">
      <PageHeader title={t('tabs.audit')} subtitle={t('audit.subtitle')} />
      {audit.error ? (
        <Alert
          tone="error"
          role="alert"
          title={t('audit.loadError')}
          action={
            <Button size="sm" onClick={audit.reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(audit.error, t)}
        </Alert>
      ) : null}
      <Card
        title={t('audit.title')}
        actions={
          audit.hasMore ? (
            <Button size="sm" onClick={audit.loadMore} disabled={audit.loadingMore} aria-label={t('aria.loadMore')}>
              {audit.loadingMore ? t('common.loading') : t('audit.loadMore')}
            </Button>
          ) : null
        }
      >
        {audit.loading && audit.items.length === 0 ? <Skeleton label={t('common.loading')} rows={6} /> : null}
        {!audit.loading && !audit.error && audit.items.length === 0 ? <EmptyState title={t('audit.empty')} /> : null}
        {audit.items.length > 0 ? (
          <div className="wc-tablewrap">
            <table className="wc-table">
              <thead>
                <tr>
                  <th scope="col">{t('audit.table.at')}</th>
                  <th scope="col">{t('audit.table.action')}</th>
                  <th scope="col">{t('audit.table.summary')}</th>
                  <th scope="col">{t('audit.table.outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>{timeText(entry.at)}</td>
                    <td>
                      <span className="wc-mono">{entry.action}</span>
                    </td>
                    <td>
                      <span className="wc-cell-title">{actorLabel(entry, t)}</span>
                      {entry.target ? <span className="wc-cell-meta wc-mono">{entry.target}</span> : null}
                      {entry.detail ? <span className="wc-cell-meta">{entry.detail}</span> : null}
                    </td>
                    <td>
                      <Badge tone={outcomeTone(entry.outcome)}>{outcomeLabel(entry, t)}</Badge>
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
