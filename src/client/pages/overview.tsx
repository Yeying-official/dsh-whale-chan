/** Overview tab: monitor switch, counters, health checks, recent activity and quick links. */
import { useEffect, useState } from 'react'
import { call, useApi, useMutation, type ApiQueryState } from '../api.ts'
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Skeleton, Switch } from '../controls.tsx'
import { errorText } from '../errors.ts'
import { shortTime, timeText } from '../format.ts'
import { usePanel } from '../provider.tsx'
import { healthTone } from '../status.ts'
import type { AuditEntry, Health, Overview } from '../../shared/models.ts'
import type { T } from '../locale.ts'

function healthStatusLabel(health: Health, t: T): string {
  return health.status === 'ok'
    ? t('health.ok')
    : health.status === 'degraded'
      ? t('health.degraded')
      : t('health.error')
}

function auditActor(entry: AuditEntry, t: T): string {
  if (entry.actor === 'owner') return t('audit.actor.owner')
  if (entry.actor === 'assistant') return t('audit.actor.assistant')
  return entry.actor
}

function RecentActivity({ recent }: { recent: ApiQueryState<{ readonly items: readonly AuditEntry[] }> }) {
  const { t, openTab } = usePanel()
  if (recent.loading && !recent.data) return <Skeleton label={t('common.loading')} rows={3} />
  if (recent.error) {
    return (
      <Alert
        tone="error"
        role="alert"
        action={
          <Button size="sm" onClick={recent.reload}>
            {t('common.retry')}
          </Button>
        }
      >
        {errorText(recent.error, t)}
      </Alert>
    )
  }
  if (!recent.data || recent.data.items.length === 0) return <EmptyState title={t('overview.recent.empty')} />
  return (
    <ul className="wc-health-list">
      {recent.data.items.map((entry) => (
        <li key={entry.id} className="wc-health-row">
          <div>
            <span className="wc-health-name">{entry.action}</span>
            <span className="wc-health-detail-text">
              {auditActor(entry, t)}
              {entry.target ? ` · ${entry.target}` : ''}
            </span>
          </div>
          <span className="wc-cell-meta">{shortTime(entry.at)}</span>
        </li>
      ))}
    </ul>
  )
}

function HealthChecks({ health }: { health: Health }) {
  const { t } = usePanel()
  return (
    <>
      <div className="wc-flags">
        <Badge tone={healthTone(health.status)}>{healthStatusLabel(health, t)}</Badge>
        <span className="wc-hint">{t('overview.health.dws')}</span>
        <span className="wc-mono">{health.dws.binaryPath}</span>
        <Badge tone={health.dws.available ? 'success' : 'neutral'}>
          {health.dws.available ? t('health.dws.available') : t('health.dws.unavailable')}
        </Badge>
        <Badge
          tone={
            health.dws.authenticated === true ? 'success' : health.dws.authenticated === false ? 'error' : 'neutral'
          }
        >
          {health.dws.authenticated === true
            ? t('health.dws.authenticated')
            : health.dws.authenticated === false
              ? t('health.dws.notAuthenticated')
              : t('health.dws.authUnknown')}
        </Badge>
      </div>
      <ul className="wc-health-list" aria-label={t('health.checks')}>
        {health.checks.map((check) => {
          const key = `health.check.${check.id}` as 'health.check.state'
          const label = t(key)
          return (
            <li key={check.id} className="wc-health-row">
              <div>
                <span className="wc-health-name">{label === key ? check.id : label}</span>
                <span className="wc-health-detail-text">{check.detail}</span>
              </div>
              <Badge tone={healthTone(check.status)}>
                {check.status === 'ok'
                  ? t('health.ok')
                  : check.status === 'degraded'
                    ? t('health.degraded')
                    : t('health.error')}
              </Badge>
            </li>
          )
        })}
      </ul>
    </>
  )
}

export function OverviewPage() {
  const { t, refreshToken, openTab, refresh, notify } = usePanel()
  const overview = useApi((signal) => call('GET overview', { signal }), { intervalMs: 5000, deps: [refreshToken] })
  const running = useApi((signal) => call('GET tasks', { signal, query: { status: 'running', limit: 100 } }), {
    deps: [refreshToken],
  })
  const recent = useApi((signal) => call('GET audit', { signal, query: { limit: 5 } }), { deps: [refreshToken] })
  const pause = useMutation((paused: boolean) => call('POST monitor/pause', { body: { paused } }))
  const [optimisticPaused, setOptimisticPaused] = useState<boolean>()

  useEffect(() => {
    if (optimisticPaused !== undefined && overview.data?.monitor.paused === optimisticPaused)
      setOptimisticPaused(undefined)
  }, [overview.data, optimisticPaused])

  const data: Overview | undefined = overview.data
  const paused = optimisticPaused ?? data?.monitor.paused ?? false
  const runningCount = running.data?.items.length ?? 0
  const runningCapped = running.data?.nextOffset !== null && running.data !== undefined
  const counts = data
    ? [
        { key: 'overview.counts.awaitingApproval', value: data.counts.awaitingApproval },
        { key: 'overview.counts.running', value: runningCount, capped: runningCapped },
        { key: 'overview.counts.threads', value: data.counts.threads },
        { key: 'overview.counts.targets', value: data.counts.targets },
      ]
    : []

  const togglePause = async (next: boolean) => {
    setOptimisticPaused(next)
    try {
      await pause.run(next)
      notify(next ? t('overview.pause.saved') : t('overview.pause.resumed'))
      overview.reload()
      recent.reload()
    } catch (failure) {
      setOptimisticPaused(undefined)
      notify(errorText(failure as Error, t), 'error')
      overview.reload()
    }
  }

  const monitorBadge = data
    ? !data.monitor.enabled
      ? { tone: 'neutral' as const, label: t('overview.monitor.disabled') }
      : data.monitor.paused
        ? { tone: 'warning' as const, label: t('overview.monitor.paused') }
        : { tone: 'success' as const, label: t('overview.monitor.active') }
    : { tone: 'neutral' as const, label: t('common.loading') }

  return (
    <div className="wc-page">
      <PageHeader
        title={t('tabs.overview')}
        subtitle={t('overview.subtitle')}
        actions={
          <Button size="sm" onClick={refresh} aria-label={t('aria.refresh')}>
            {t('common.refresh')}
          </Button>
        }
      />
      {overview.error ? (
        <Alert
          tone="error"
          role="alert"
          title={t('overview.error.title')}
          action={
            <Button size="sm" onClick={overview.reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(overview.error, t)}
        </Alert>
      ) : null}
      {overview.loading && !data ? <Skeleton label={t('common.loading')} rows={5} /> : null}
      {data ? (
        <div className="wc-grid" data-columns="two">
          <div className="wc-grid-col">
            <Card title={t('overview.monitor')} actions={<Badge tone={monitorBadge.tone}>{monitorBadge.label}</Badge>}>
              <div className="wc-switch-row">
                <div>
                  <span>{paused ? t('overview.pause.off') : t('overview.pause.on')}</span>
                  <p className="wc-hint">{t('overview.pause.hint')}</p>
                </div>
                <Switch
                  checked={paused}
                  label={t('aria.pauseToggle')}
                  disabled={pause.pending || !data.monitor.enabled}
                  onChange={(next) => void togglePause(next)}
                />
              </div>
              <dl className="wc-facts" style={{ marginTop: 12 }}>
                <div>
                  <dt>{t('overview.monitor')}</dt>
                  <dd>{data.monitor.enabled ? t('common.enabled') : t('common.disabled')}</dd>
                </div>
                <div>
                  <dt>{t('overview.monitor.runningNote')}</dt>
                  <dd>{data.monitor.running ? t('overview.monitor.runningNote') : t('overview.monitor.idleNote')}</dd>
                </div>
              </dl>
            </Card>
            <Card title={t('overview.counts.title')}>
              <div className="wc-stats">
                {counts.map((item) => (
                  <div key={item.key} className="wc-stat">
                    <span className="wc-stat-label">{t(item.key as 'overview.counts.threads')}</span>
                    <span className="wc-stat-value">
                      {item.value}
                      {item.capped ? t('common.approximate') : ''}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
            <Card
              title={t('overview.health.title')}
              actions={<span className="wc-hint">{timeText(data.health.checks[0]?.observedAt)}</span>}
            >
              <HealthChecks health={data.health} />
            </Card>
          </div>
          <div className="wc-grid-col">
            <Card
              title={t('overview.recent.title')}
              actions={
                <Button size="sm" onClick={() => openTab('audit')}>
                  {t('overview.recent.viewAll')}
                </Button>
              }
            >
              <RecentActivity recent={recent} />
            </Card>
            <Card title={t('overview.quick.title')}>
              <div className="wc-action-row">
                <Button size="sm" onClick={() => openTab('threads')}>
                  {t('overview.quick.threads')}
                </Button>
                <Button size="sm" onClick={() => openTab('tasks')}>
                  {t('overview.quick.tasks')}
                </Button>
                <Button size="sm" onClick={() => openTab('targets')}>
                  {t('overview.quick.targets')}
                </Button>
                <Button size="sm" onClick={() => openTab('settings')}>
                  {t('overview.quick.settings')}
                </Button>
              </div>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  )
}
