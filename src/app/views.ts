/** Wire view builders for the management API. */
import type { StateView } from '../shared/models.ts'
import type { RuntimeInfo } from './runtime.ts'

export interface StateRuntime {
  info(): RuntimeInfo
}

/** Project the live runtime into the frozen `GET state` response. */
export function stateView(runtime: StateRuntime): StateView {
  const info = runtime.info()
  return {
    ok: true,
    name: info.name,
    version: info.version,
    stateDir: info.stateDir,
    startedAt: info.startedAt,
  }
}
