/**
 * Cordis host entry of 鲸鱼酱 · 钉钉助理.
 *
 * The runtime opens the state database, the settings service, the domain
 * engine and the effects queue, then composes the channel, the replier model,
 * retrieval and the task executor through this context. A failed startup is
 * logged and rethrown; unloading stops the runtime in reverse order.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-workspace'
import { Config, type DeploymentConfig } from './app/deployment.ts'
import { registerHttp } from './app/http.ts'
import { Runtime } from './app/runtime.ts'
import { PLUGIN_NAME } from './shared/limits.ts'

export const name = PLUGIN_NAME
/**
 * Services the runtime addresses. `systemPrompt` is reached through the
 * agent's own context rather than this one, so it is not injected here.
 */
export const inject = [
  'webServer',
  'settings',
  'agents',
  'sessionController',
  'workspaceRegistry',
  'permissionPresets',
  'sessionPersistence',
  'llm',
  // `LlmModel` reads the host default selection through this service; it is
  // required even when `settings.models.reply` pins both provider and model,
  // because the adapter resolves the call config through the same service.
  'agentDefaultModel',
  'web',
]

export { Config }
export type { DeploymentConfig }

export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const runtime = new Runtime({ ctx, config })

  // Register unload before startup so a failed mkdir or a taken lock cannot
  // leave a half-mounted plugin behind. The HTTP route is mounted before `ready`
  // settles and answers 503 while startup is still pending or failed.
  ctx.effect(() => () => runtime.stop())
  ctx.effect(() => registerHttp(ctx, runtime))

  // The management panel owns the assistant settings page, so DSH must not
  // generate a second automatic page for this entry.
  const settings = ctx.get('settings')
  if (settings) ctx.effect(() => settings.configure({ auto: false }, ctx.fiber))

  try {
    await runtime.ready
  } catch (error) {
    ctx.logger.error(
      'dsh-whale-chan-assistant failed to start: %s',
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
  const facts = runtime.facts()
  const status = runtime.status()
  ctx.logger.info(
    'dsh-whale-chan-assistant ready; state.db schema v%s, settings loaded (%s warnings), lock %s, channel %s, prompts %s; state directory: %s',
    String(facts.schemaVersion),
    String(runtime.settings.warnings().length),
    facts.lockHeld ? 'held' : 'missing',
    status.monitorRunning ? 'running' : 'stopped',
    status.promptsReady ? 'ready' : 'unavailable',
    runtime.stateDir,
  )
}
