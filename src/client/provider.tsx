/**
 * Panel-wide context: translator, tab selection, health polling, session
 * navigation and transient notices.
 *
 * Polling is deliberately bounded to the health badge here; pages opt into
 * their own polling (overview and health every five seconds, everything else
 * manual) so seven tabs never multiply the request load.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { fetchHealth, useApi, type ApiQueryState } from './api.ts'
import STYLES from './client.css?raw'
import { initialTab, parseTab, rememberTab, type Tab } from './tabs.ts'
import type { Health } from '../shared/models.ts'
import type { T } from './locale.ts'

export type ToastTone = 'success' | 'error' | 'info'

export interface PanelContextValue {
  readonly t: T
  readonly openSession: (sessionId: string) => Promise<void>
  readonly notify: (text: string, tone?: ToastTone) => void
  readonly tab: Tab
  readonly openTab: (tab: Tab) => void
  readonly refreshToken: number
  readonly refresh: () => void
  readonly health: ApiQueryState<Health>
}

const PanelContext = createContext<PanelContextValue | undefined>(undefined)

interface ToastState {
  readonly id: number
  readonly text: string
  readonly tone: ToastTone
}

function Toast({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const timer = setTimeout(() => done.current(), 4000)
    return () => clearTimeout(timer)
  }, [toast.id])
  return createPortal(
    <div className="wc-toast" data-tone={toast.tone} role={toast.tone === 'error' ? 'alert' : 'status'}>
      {toast.text}
    </div>,
    document.body,
  )
}

export interface PanelProviderProps {
  readonly t: T
  readonly openSession?: ((sessionId: string) => Promise<void>) | undefined
  readonly children: ReactNode
}

export function PanelProvider({ t, openSession, children }: PanelProviderProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [refreshToken, setRefreshToken] = useState(0)
  const [toast, setToast] = useState<ToastState>()
  const health = useApi(fetchHealth, { intervalMs: 5000 })
  const healthReload = health.reload

  useEffect(() => {
    rememberTab(tab)
  }, [tab])

  useEffect(() => {
    const onHashChange = () => {
      const next = parseTab(window.location.hash.replace(/^#/, ''))
      if (next) setTab(next)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const openTab = useCallback((next: Tab) => setTab(next), [])
  const refresh = useCallback(() => {
    setRefreshToken((value) => value + 1)
    healthReload()
  }, [healthReload])
  const notify = useCallback((text: string, tone: ToastTone = 'success') => {
    setToast({ id: Date.now() + Math.random(), text, tone })
  }, [])
  const noSession = useCallback(async () => {
    throw new Error(t('session.notReady'))
  }, [t])

  const value: PanelContextValue = {
    t,
    openSession: openSession ?? noSession,
    notify,
    tab,
    openTab,
    refreshToken,
    refresh,
    health,
  }

  return (
    <PanelContext.Provider value={value}>
      <style>{STYLES}</style>
      {children}
      {toast ? <Toast key={toast.id} toast={toast} onDone={() => setToast(undefined)} /> : null}
    </PanelContext.Provider>
  )
}

export function usePanel(): PanelContextValue {
  const value = useContext(PanelContext)
  if (!value) throw new Error('The Whale Chan panel rendered outside its provider')
  return value
}
