/**
 * Seeds the model a role's settings ask for onto a session, without touching the
 * deployment default.
 *
 * `settings.models.reply` and `settings.models.worker` are two independent
 * routes. DSH's own way to change a session's model (`sessionController.selectModel`
 * and `sessionController.initializeDefaultModel`) writes the *global* default, so
 * using it here would let a reply route silently become the model every new
 * session starts with. Instead the selection is appended to this session's log as
 * a `model/selection` event and injected into the first model request only:
 *
 * - `system-prompt/assemble` receives the route as prompt variables for the first
 *   assembly, so the prompt renders the same provider/model the request uses;
 * - `agent/request` rewrites the first call config with the resolved route;
 * - the first `request/header` or `model/selection` event ends that initial
 *   window, so later turns use whatever the session selected afterwards — a
 *   person picking another model in the panel is not overwritten.
 *
 * Everything is skipped when the route is not configured (the session then uses
 * the host default) or when the session already has a selection or a request
 * header, which is what makes resuming a session safe.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ModelRoute } from '../shared/settings.ts'
import type { ExecutorLogger } from './types.ts'

/** A resolved provider/model route with its adapter-owned reasoning effort. */
export interface RoleSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: ReasoningEffortId
}

/** What the seeding needs from `@deepseek-ai/dsh-llm`; replaced by tests. */
export interface RoleModelResolver {
  resolveCallConfig(config: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: ReasoningEffortId
  }): Promise<RoleSelection>
}

/** What the seeding needs from a session to decide whether it may run. */
export interface SessionSelectionState {
  requestHeader(): unknown
  snapshotEvents(): readonly { readonly type: string }[]
}

/**
 * Turn one settings route into a selection request.
 *
 * Both `provider` and `model` are required: a half-configured route is treated as
 * "not configured" instead of being resolved against a guess, so a typo in
 * settings can never route a task to an unrelated provider.
 */
export function routeSelection(route: ModelRoute | undefined): RoleSelection | undefined {
  if (route === undefined) return undefined
  const provider = route.provider.trim()
  const model = route.model.trim()
  if (provider.length === 0 || model.length === 0) return undefined
  const effort = route.effort.trim()
  return effort.length === 0 ? { provider, model } : { provider, model, reasoningEffort: ReasoningEffortId(effort) }
}

/**
 * Whether a session still needs this plugin's selection.
 *
 * A session that already recorded a `model/selection` event or opened its first
 * request header keeps what it has: that is either our earlier seed or a
 * deliberate choice made later, and both must win over the settings route.
 */
export function needsSeeding(selection: RoleSelection | undefined, session: SessionSelectionState): boolean {
  if (selection === undefined) return false
  if (session.requestHeader() !== undefined) return false
  return !session.snapshotEvents().some((event) => event.type === 'model/selection')
}

/** Everything one seeding attempt may touch; tests replace all three. */
export interface RoleModelDeps {
  readonly resolver: RoleModelResolver
  readonly flush: () => Promise<void>
  /** Subscribe to the agent's session events; returns the disposer. */
  readonly watchSession: (listener: (event: { readonly type: string }) => void) => () => void
  readonly logger?: ExecutorLogger
}

/** The production dependencies of one seeding attempt, from the host context. */
export function roleModelDeps(ctx: Context, agent: Agent, logger?: ExecutorLogger): RoleModelDeps {
  return {
    resolver: {
      resolveCallConfig: async (config) => await ctx.llm.resolveCallConfig(config),
    },
    flush: async () => {
      await ctx.sessionPersistence.flush()
    },
    watchSession: (listener) =>
      ctx.on('session/event', (session, event) => {
        if (session === agent.session) listener(event)
      }),
    ...(logger === undefined ? {} : { logger }),
  }
}

/**
 * Seed `selection` onto `agent`, then flush it so a crash right after creation
 * still restarts on the same model.
 *
 * @returns `true` when a selection was appended, `false` when the route was empty
 *   or the session already had one. Failures are logged and reported as `false`:
 *   a bad model route must not fail the session itself, which can still run on
 *   the deployment default.
 */
export async function seedRoleModel(
  agent: Agent,
  selection: RoleSelection | undefined,
  deps: RoleModelDeps,
): Promise<boolean> {
  if (selection === undefined || !needsSeeding(selection, agent.session)) return false
  const route = selection
  try {
    const resolved = await deps.resolver.resolveCallConfig({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    })
    agent.session.append('model/selection', resolved)
    let initial = true
    let assembled: RoleSelection | undefined
    agent.ctx.effect(() => {
      const disposers = [
        agent.ctx.on(
          'system-prompt/assemble',
          async (assembly, _context, next) => {
            const pending = initial ? resolved : undefined
            const result = await next()
            assembled = pending
            if (pending === undefined) return result
            return { ...result, variables: { ...result.variables, provider: pending.provider, model: pending.model } }
          },
          { prepend: true },
        ),
        agent.ctx.on(
          'agent/request',
          async (_payload, next) => {
            const result = await next()
            if (assembled === undefined) return result
            const { reasoningEffort: _inherited, ...rest } = result
            return { ...rest, ...assembled }
          },
          { prepend: true },
        ),
        deps.watchSession((event) => {
          if (event.type === 'request/header' || event.type === 'model/selection') initial = false
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    })
    await deps.flush()
    return true
  } catch (error) {
    deps.logger?.warn?.(
      `dsh-whale-chan: could not seed the ${route.provider}/${route.model} route, keeping the host default: ${describe(error)}`,
    )
    return false
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200)
  return String(error).slice(0, 200)
}
