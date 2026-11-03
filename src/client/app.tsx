/** Panel shell: brand header, health badge, global refresh and the seven tabs. */
import { useRef } from 'react'
import { Badge, Button, type BadgeTone } from './controls.tsx'
import { errorText } from './errors.ts'
import { AuditPage } from './pages/audit.tsx'
import { OverviewPage } from './pages/overview.tsx'
import { PersonaPage } from './pages/persona.tsx'
import { SettingsPage } from './pages/settings.tsx'
import { TargetsPage } from './pages/targets.tsx'
import { TasksPage } from './pages/tasks.tsx'
import { ThreadsPage } from './pages/threads.tsx'
import { usePanel } from './provider.tsx'
import { TABS, type Tab } from './tabs.ts'
import type { WhaleChanKey } from './locale.ts'
import type { Health } from '../shared/models.ts'

function healthBadge(
  health: { readonly data?: Health; readonly error?: Error; readonly loading: boolean },
  t: ReturnType<typeof usePanel>['t'],
): { readonly tone: BadgeTone; readonly label: string; readonly detail: string | undefined } {
  if (health.data) {
    const tone: BadgeTone =
      health.data.status === 'ok' ? 'success' : health.data.status === 'degraded' ? 'warning' : 'error'
    const key: WhaleChanKey =
      health.data.status === 'ok' ? 'health.ok' : health.data.status === 'degraded' ? 'health.degraded' : 'health.error'
    return { tone, label: t(key), detail: undefined }
  }
  if (health.error) return { tone: 'error', label: t('health.unknown'), detail: errorText(health.error, t) }
  return { tone: 'neutral', label: health.loading ? t('health.loading') : t('health.unknown'), detail: undefined }
}

function Page({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'overview':
      return <OverviewPage />
    case 'threads':
      return <ThreadsPage />
    case 'tasks':
      return <TasksPage />
    case 'targets':
      return <TargetsPage />
    case 'persona':
      return <PersonaPage />
    case 'settings':
      return <SettingsPage />
    case 'audit':
      return <AuditPage />
  }
}

export function App() {
  const { t, tab, openTab, refresh, health, refreshToken } = usePanel()
  const tabs = useRef(new Map<Tab, HTMLButtonElement>())
  const current = healthBadge(health, t)

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab)
    let next: Tab | undefined
    if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length]
    else if (event.key === 'ArrowLeft') next = TABS[(index - 1 + TABS.length) % TABS.length]
    else if (event.key === 'Home') next = TABS[0]
    else if (event.key === 'End') next = TABS[TABS.length - 1]
    if (!next) return
    event.preventDefault()
    openTab(next)
    tabs.current.get(next)?.focus()
  }

  return (
    <div className="wc-panel">
      <header className="wc-shell-head">
        <div className="wc-shell-bar">
          <div className="wc-brand">
            <h1 id="wc-title">{t('panel.label')}</h1>
            <span className="wc-brand-sub">{t('overview.title')}</span>
          </div>
          <div className="wc-shell-actions">
            <div className="wc-health" aria-live="polite" aria-label={t('aria.health')}>
              <span className="wc-status-label">{t('health.label')}</span>
              <Badge tone={current.tone}>{current.label}</Badge>
              {current.detail ? <span className="wc-health-detail">{current.detail}</span> : null}
            </div>
            <Button size="sm" onClick={refresh} aria-label={t('aria.refresh')}>
              {t('common.refresh')}
            </Button>
          </div>
        </div>
        <div className="wc-tabs" role="tablist" aria-label={t('tabs.label')} onKeyDown={onKeyDown}>
          {TABS.map((item) => (
            <button
              key={item}
              ref={(element) => {
                if (element) tabs.current.set(item, element)
                else tabs.current.delete(item)
              }}
              type="button"
              role="tab"
              id={`wc-tab-${item}`}
              className="wc-tab"
              aria-selected={tab === item}
              aria-controls="wc-tabpanel"
              tabIndex={tab === item ? 0 : -1}
              onClick={() => openTab(item)}
            >
              {t(`tabs.${item}`)}
            </button>
          ))}
        </div>
      </header>
      <main id="wc-tabpanel" role="tabpanel" aria-labelledby={`wc-tab-${tab}`} className="wc-tabpanel" key={tab}>
        <Page tab={tab} />
      </main>
      <span className="wc-visually-hidden" data-refresh-token={refreshToken} />
    </div>
  )
}
