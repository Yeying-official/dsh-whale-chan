/**
 * Browser entry: registers the sidebar icon and the `whale-chan` main panel.
 *
 * The panel only talks to the management HTTP API through `api.ts`; the two
 * DSH client services it uses are navigation (`uiWorkspace.openSession`) and
 * the session catalog (`sessions`), which keeps the README promise that the
 * client never imports a host implementation package.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { App } from './app.tsx'
import { NS, dictionaries, type T } from './locale.ts'
import { PanelProvider } from './provider.tsx'
import { PANEL_ID } from '../shared/limits.ts'

type WhalePanelId = MainPanelId

/** The narrow session-catalog face the panel uses to resolve one session id. */
interface SessionCatalog {
  readonly list: {
    getSnapshot(): { readonly phase: string; readonly byId: Readonly<Record<string, unknown>> }
  }
  refresh(): Promise<void>
}

/** The host Session catalog is not ready or does not list the requested session. */
class SessionNavigationError extends Error {
  constructor(readonly reason: 'not-ready' | 'not-listed') {
    super(reason)
    this.name = 'SessionNavigationError'
  }
}

type PanelContext = Context & {
  readonly sessions: SessionCatalog
  readonly uiWorkspace: { openSession(target: never): void }
}

function WhaleIcon({ size }: SidebarPanelIconOwnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.8 20.2c1.3-.2 2.4-.8 3.2-1.7 1.1 1.2 2.7 1.9 4.5 1.9h3.3c3.5 0 6.3-2.4 6.3-5.5 0-3-2.6-5.4-5.8-5.4-2.9 0-5.3 1.5-6.2 3.7" />
      <path d="M2.8 20.2c-.9 0-1.7-.4-2.2-1 1.1-.2 2-.8 2.5-1.7" />
      <circle cx="16.3" cy="13.1" r=".85" fill="currentColor" stroke="none" />
      <path d="M13.1 2.4h6.2a2.3 2.3 0 0 1 2.3 2.3v3.5a2.3 2.3 0 0 1-2.3 2.3h-1.9l-2.4 1.9.2-1.9h-2.1a2.3 2.3 0 0 1-2.3-2.3V4.7a2.3 2.3 0 0 1 2.3-2.3z" />
      <path d="M14.7 6h3.3" />
    </svg>
  )
}

function MainPanel({ ctx, t }: { ctx: PanelContext; t: T }) {
  const openSession = async (sessionId: string): Promise<void> => {
    const read = () => ctx.sessions.list.getSnapshot()
    let snapshot = read()
    if (snapshot.phase !== 'ready' || snapshot.byId[sessionId] === undefined) {
      await ctx.sessions.refresh()
      snapshot = read()
    }
    if (snapshot.phase !== 'ready') throw new SessionNavigationError('not-ready')
    if (snapshot.byId[sessionId] === undefined) throw new SessionNavigationError('not-listed')
    ctx.uiWorkspace.openSession(sessionId as never)
  }

  return (
    <PanelProvider t={t} openSession={openSession}>
      <App />
    </PanelProvider>
  )
}

/** Friendly copy for the two session-navigation failures. */
export function sessionErrorKey(reason: 'not-ready' | 'not-listed'): 'session.notReady' | 'session.notListed' {
  return reason === 'not-ready' ? 'session.notReady' : 'session.notListed'
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace'] as const

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries))
  const t = ctx.locale.bind(NS)
  const panel = ctx as PanelContext

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID as WhalePanelId, locale: NS }, (props: { t: T }) => (
      <MainPanel ctx={panel} t={props.t} />
    )),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID as WhalePanelId,
        order: 10,
        label: () => t('panel.label'),
        locale: NS,
      },
      WhaleIcon,
    ),
  )
}
