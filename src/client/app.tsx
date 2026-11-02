/** WS0 overview: host connection state, build identity and state directory. */
import { ApiError, type PollResult } from './api.ts'
import { Badge, Button, Card, type BadgeTone } from './controls.tsx'
import { usePanelData } from './provider.tsx'
import type { StateView } from '../shared/models.ts'
import type { T, WhaleChanKey } from './locale.ts'

function timeText(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
}

function errorText(error: Error, t: T): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return t('overview.errorOffline')
    if (error.status >= 500) return t('overview.errorServer', { status: error.status })
    if (error.status === 200) return t('overview.errorInvalid')
    return t('overview.errorRequest', { status: error.status })
  }
  return t('overview.errorInvalid')
}

function status(
  state: StateView | undefined,
  error: Error | undefined,
  loading: boolean,
): { readonly tone: BadgeTone; readonly key: WhaleChanKey } {
  if (error) return { tone: 'error', key: 'overview.offline' }
  if (state) return { tone: 'success', key: 'overview.online' }
  return { tone: loading ? 'neutral' : 'warning', key: 'overview.connecting' }
}

export function App({ t }: { t: T }) {
  const data: PollResult<StateView> & { state: StateView | undefined } = usePanelData()
  const { state, error, loading, reload } = data
  const current = status(state, error, loading)

  return (
    <main className="wc-panel" aria-labelledby="wc-title">
      <header className="wc-hero">
        <div>
          <h1 id="wc-title">{t('overview.title')}</h1>
          <p>{t('overview.subtitle')}</p>
        </div>
        <div className="wc-status" aria-live="polite">
          <span className="wc-status-label">{t('overview.connection')}</span>
          <Badge tone={current.tone}>{t(current.key)}</Badge>
        </div>
      </header>

      <Card
        title={t('overview.connection')}
        actions={
          <Button size="sm" onClick={reload} disabled={loading}>
            {t('overview.retry')}
          </Button>
        }
      >
        {error ? (
          <div className="wc-error" role="alert">
            <strong>{t('overview.errorTitle')}</strong>
            <p>{errorText(error, t)}</p>
          </div>
        ) : null}

        {state ? (
          <dl className="wc-facts">
            <div>
              <dt>{t('overview.version')}</dt>
              <dd>{state.version}</dd>
            </div>
            <div>
              <dt>{t('overview.stateDir')}</dt>
              <dd className="wc-mono">{state.stateDir}</dd>
            </div>
            <div>
              <dt>{t('overview.startedAt')}</dt>
              <dd>{timeText(state.startedAt)}</dd>
            </div>
          </dl>
        ) : !error ? (
          <p className="wc-muted" role="status">
            {t('overview.connecting')}
          </p>
        ) : null}
      </Card>

      <p className="wc-placeholder">{t('overview.placeholder')}</p>
    </main>
  )
}
