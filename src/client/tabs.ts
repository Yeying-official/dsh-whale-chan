/** Panel tabs, URL hash support and the persisted active tab. */
export const TABS = ['overview', 'threads', 'tasks', 'targets', 'persona', 'settings', 'audit'] as const

export type Tab = (typeof TABS)[number]

export const TAB_STORAGE_KEY = 'whale-chan.tab'

/** Accept only a known tab name; everything else is ignored. */
export function parseTab(value: string | null | undefined): Tab | undefined {
  return TABS.find((tab) => tab === value)
}

function readStoredTab(): Tab | undefined {
  try {
    return parseTab(window.localStorage.getItem(TAB_STORAGE_KEY))
  } catch {
    return undefined
  }
}

/** Resolve the initial tab: URL hash first, then the persisted choice, then overview. */
export function initialTab(): Tab {
  const hash = parseTab(window.location.hash.replace(/^#/, ''))
  return hash ?? readStoredTab() ?? 'overview'
}

/** Persist the tab and mirror it in the URL hash without adding history entries. */
export function rememberTab(tab: Tab): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    // Storage is a convenience; a blocked localStorage must not break navigation.
  }
  if (window.location.hash !== `#${tab}`) {
    try {
      window.history.replaceState(null, '', `#${tab}`)
    } catch {
      // A sandboxed document may refuse history writes; the tab still works.
    }
  }
}
