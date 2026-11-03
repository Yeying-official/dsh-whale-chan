/**
 * Role-model seeding: the settings route must reach the session that runs it,
 * and an unconfigured route must leave the deployment default alone.
 *
 * The DSH half of this module (`system-prompt/assemble`, `agent/request`,
 * `agent.ctx.effect`) is verified by `tsc` against the shipped declarations and
 * by one end-to-end call below with a fake agent; the decision logic
 * (`routeSelection`, `needsSeeding`) is pure and tested directly.
 */
import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { needsSeeding, routeSelection, seedRoleModel, type RoleSelection } from '../src/executor/index.ts'
import { RecordingLogger, makeSettings } from './fixtures/executor.ts'

describe('routeSelection', () => {
  it('maps a fully configured route and keeps the reasoning effort', () => {
    expect(routeSelection({ provider: 'deepseek', model: 'deepseek-chat', effort: 'high' })).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: ReasoningEffortId('high'),
    })
  })

  it('omits the effort when the settings leave it empty', () => {
    expect(routeSelection({ provider: 'deepseek', model: 'deepseek-chat', effort: '' })).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
  })

  it('treats a half-configured or empty route as not configured', () => {
    expect(routeSelection({ provider: '', model: 'deepseek-chat', effort: '' })).toBeUndefined()
    expect(routeSelection({ provider: 'deepseek', model: '  ', effort: '' })).toBeUndefined()
    expect(routeSelection({ provider: '', model: '', effort: 'high' })).toBeUndefined()
    expect(routeSelection(undefined)).toBeUndefined()
  })

  it('reads the defaults every settings block parses to', () => {
    expect(routeSelection(makeSettings().models.reply)).toBeUndefined()
    expect(routeSelection(makeSettings().models.worker)).toBeUndefined()
    const configured = makeSettings({ models: { worker: { provider: 'p', model: 'm', effort: 'low' } } })
    expect(routeSelection(configured.models.worker)).toEqual({
      provider: 'p',
      model: 'm',
      reasoningEffort: ReasoningEffortId('low'),
    })
  })
})

/** The smallest session the seeding examines. */
function session(
  events: readonly string[],
  header: boolean,
): { requestHeader(): unknown; snapshotEvents(): { type: string }[] } {
  return {
    requestHeader: () => (header ? {} : undefined),
    snapshotEvents: () => events.map((type) => ({ type })),
  }
}

describe('needsSeeding', () => {
  const selection: RoleSelection = { provider: 'p', model: 'm' }

  it('seeds a blank session', () => {
    expect(needsSeeding(selection, session([], false))).toBe(true)
  })

  it('skips a session that already recorded a selection', () => {
    expect(needsSeeding(selection, session(['model/selection'], false))).toBe(false)
  })

  it('skips a session that already opened a request header', () => {
    expect(needsSeeding(selection, session(['request/header'], true))).toBe(false)
  })

  it('skips everything when the route is not configured', () => {
    expect(needsSeeding(undefined, session([], false))).toBe(false)
  })
})

interface FakeAgent {
  readonly appended: Array<{ type: string; data: unknown }>
  effects: number
  readonly listeners: string[]
  session: {
    requestHeader(): unknown
    snapshotEvents(): { type: string }[]
    append(type: 'model/selection', data: RoleSelection): unknown
  }
  ctx: {
    effect(run: () => () => void): void
    on(name: string, listener: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): () => void
  }
}

function fakeAgent(events: readonly string[] = [], header = false): FakeAgent {
  const appended: Array<{ type: string; data: unknown }> = []
  const listeners: string[] = []
  const agent: FakeAgent = {
    appended,
    effects: 0,
    listeners,
    session: {
      requestHeader: () => (header ? {} : undefined),
      snapshotEvents: () => events.map((type) => ({ type })),
      append: (type, data) => {
        appended.push({ type, data })
        return undefined
      },
    },
    ctx: {
      effect: (run) => {
        agent.effects += 1
        run()
      },
      on: (name) => {
        listeners.push(name)
        return () => true
      },
    },
  }
  return agent
}

function deps(overrides: { resolve?: (config: { provider: string; model: string }) => Promise<RoleSelection> } = {}) {
  const calls: string[] = []
  return {
    calls,
    value: {
      resolver: {
        resolveCallConfig: async (config: { provider: string; model: string }) => {
          calls.push(`${config.provider}/${config.model}`)
          return await (overrides.resolve?.(config) ??
            Promise.resolve({ provider: config.provider, model: config.model }))
        },
      },
      flush: async () => {
        calls.push('flush')
      },
      watchSession: () => {
        calls.push('watch')
        return () => undefined
      },
      logger: new RecordingLogger(),
    },
  }
}

describe('seedRoleModel', () => {
  it('does not touch a session when the route is empty', async () => {
    const agent = fakeAgent()
    const d = deps()
    const seeded = await seedRoleModel(agent as unknown as Agent, undefined, d.value)
    expect(seeded).toBe(false)
    expect(agent.appended).toHaveLength(0)
    expect(agent.effects).toBe(0)
    expect(d.calls).toHaveLength(0)
  })

  it('does not touch a session that already has a selection', async () => {
    const agent = fakeAgent(['model/selection'])
    const d = deps()
    expect(await seedRoleModel(agent as unknown as Agent, { provider: 'p', model: 'm' }, d.value)).toBe(false)
    expect(agent.appended).toHaveLength(0)
    expect(d.calls).toHaveLength(0)
  })

  it('appends the resolved route, wires the first request and flushes', async () => {
    const agent = fakeAgent()
    const d = deps()
    const seeded = await seedRoleModel(agent as unknown as Agent, { provider: 'p', model: 'm' }, d.value)
    expect(seeded).toBe(true)
    expect(agent.appended).toEqual([{ type: 'model/selection', data: { provider: 'p', model: 'm' } }])
    expect(d.calls).toEqual(['p/m', 'watch', 'flush'])
    expect(agent.listeners).toEqual(['system-prompt/assemble', 'agent/request'])
  })

  it('keeps the host default when the resolver rejects', async () => {
    const agent = fakeAgent()
    const logger = new RecordingLogger()
    const seeded = await seedRoleModel(
      agent as unknown as Agent,
      { provider: 'p', model: 'missing' },
      {
        resolver: {
          resolveCallConfig: async () => {
            throw new Error('unknown model')
          },
        },
        flush: async () => undefined,
        watchSession: () => () => undefined,
        logger,
      },
    )
    expect(seeded).toBe(false)
    expect(agent.appended).toHaveLength(0)
    expect(logger.lines.some((line) => line.includes('unknown model'))).toBe(true)
  })
})
