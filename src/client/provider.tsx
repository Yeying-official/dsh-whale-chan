/** Panel data context, state polling and the panel's scoped styles. */
import { createContext, useContext, type ReactNode } from 'react'
import { fetchState, usePoll, type PollResult } from './api.ts'
import STYLES from './client.css?raw'
import type { StateView } from '../shared/models.ts'

interface PanelData extends PollResult<StateView> {
  readonly state: StateView | undefined
}

const PanelContext = createContext<PanelData | undefined>(undefined)

export function PanelProvider({ children }: { children: ReactNode }) {
  const poll = usePoll(fetchState, 5000)
  const value: PanelData = { ...poll, state: poll.data }
  return (
    <PanelContext.Provider value={value}>
      <style>{STYLES}</style>
      {children}
    </PanelContext.Provider>
  )
}

export function usePanelData(): PanelData {
  const value = useContext(PanelContext)
  if (!value) throw new Error('The Whale Chan panel rendered outside its provider')
  return value
}
