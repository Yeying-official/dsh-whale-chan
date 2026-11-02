/**
 * Client locale namespace and typed dictionaries.
 *
 * `locale/zh.json` and `locale/en.json` are the single source of UI copy. The
 * package metadata block (`meta`) is package-manager metadata, not a dictionary
 * entry, so it is stripped before registration. Both dictionaries are checked
 * for an identical key set by `tests/contract.spec.ts` and at compile time.
 */
import zhJson from '../../locale/zh.json' with { type: 'json' }
import enJson from '../../locale/en.json' with { type: 'json' }

const { meta: _zhMeta, ...zhFlat } = zhJson
const { meta: _enMeta, ...enFlat } = enJson

export type WhaleChanKey = keyof typeof zhFlat
export type T = (key: WhaleChanKey, params?: Record<string, unknown>) => string

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    dshWhaleChan: WhaleChanKey
  }
}

export const NS = 'dshWhaleChan' as const
export const zh = zhFlat satisfies Record<WhaleChanKey, string>
export const en = enFlat satisfies Record<WhaleChanKey, string>
export const dictionaries = { zh, en } as const
