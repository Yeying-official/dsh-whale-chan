/**
 * Host-level deployment configuration of the Cordis entry.
 *
 * Only values that must exist before the state directory is opened live here.
 * User-facing assistant settings are owned by the frozen contract in
 * `src/shared/settings.ts`; WS0 does not persist them yet. None of these fields
 * is volatile: a deployment change remounts the plugin.
 */
import s from '@deepseek-ai/schemastery'
import { DEFAULT_STATE_DIR, LOG_LEVELS } from '../shared/limits.ts'

const logLevel = s.union([
  s.const(LOG_LEVELS[0]),
  s.const(LOG_LEVELS[1]),
  s.const(LOG_LEVELS[2]),
  s.const(LOG_LEVELS[3]),
])

export const Config = s.object({
  stateDir: s
    .string()
    .default(DEFAULT_STATE_DIR)
    .description('Directory for the assistant state, audit trail and local locks. `~` expands to the user home.'),
  logLevel: logLevel
    .default('info')
    .description('Minimum host log level. Debug payload logging is a separate user setting and stays off by default.'),
})

export type DeploymentConfig = ReturnType<typeof Config>
