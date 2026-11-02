/**
 * Cordis host entry of 鲸鱼酱 · 钉钉助理.
 *
 * WS0 mounts the runtime and the read-only state route. No DingTalk event
 * subscription, sender, task executor or model call is started here.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { Config, type DeploymentConfig } from './app/deployment.ts'
import { registerHttp } from './app/http.ts'
import { Runtime } from './app/runtime.ts'
import { PLUGIN_NAME } from './shared/limits.ts'

export const name = PLUGIN_NAME
export const inject = ['webServer', 'settings'] as const

export { Config }
export type { DeploymentConfig }

export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const runtime = new Runtime(config)

  // Register unload before startup so a failed mkdir cannot leave a half-mounted
  // plugin behind. The HTTP route is mounted before `ready` settles and answers
  // 503 while startup is still pending or failed.
  ctx.effect(() => () => runtime.stop())
  ctx.effect(() => registerHttp(ctx, runtime))

  // The management panel owns the assistant settings page, so DSH must not
  // generate a second automatic page for this entry.
  const settings = ctx.get('settings')
  if (settings) ctx.effect(() => settings.configure({ auto: false }, ctx.fiber))

  await runtime.ready
  ctx.logger.info('dsh-whale-chan-assistant ready; state directory: %s', runtime.stateDir)
}
