import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inboundMessage } from './fixtures/domain.ts'
import { FakeChannel, startPipeline, type PipelineHarness, type PipelineOptions } from './fixtures/pipeline.ts'

let root = ''
let harnesses: PipelineHarness[] = []

async function start(options: Omit<PipelineOptions, 'stateDir'> = {}, stateDir?: string): Promise<PipelineHarness> {
  const harness = await startPipeline({ stateDir: stateDir ?? join(root, 'state'), ...options })
  harnesses.push(harness)
  return harness
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-runtime-'))
})

afterEach(async () => {
  for (const harness of harnesses) await harness.runtime.stop()
  harnesses = []
  await rm(root, { recursive: true, force: true })
})

describe('startup and authorization', () => {
  it('starts the channel only for an authorized owner and reports real health', async () => {
    const h = await start()
    expect(h.channel.startCalls).toBe(1)
    expect(h.runtime.status()).toMatchObject({
      monitorRunning: true,
      channelAttached: true,
      executorAttached: true,
      ownerKnown: true,
      promptsReady: true,
      promptError: null,
    })

    const health = h.runtime.health()
    expect(health).toMatchObject({ ok: true, status: 'ok', dws: { available: true, authenticated: true } })
    const checks = Object.fromEntries(health.checks.map((check) => [check.id, check]))
    expect(checks['channel']).toMatchObject({ status: 'ok' })
    expect(checks['auth']).toMatchObject({ status: 'ok' })
    expect(checks['prompts']).toMatchObject({ status: 'ok' })
    expect(checks['effects']).toMatchObject({ status: 'ok' })
    expect(checks['executor']).toMatchObject({ status: 'ok' })

    const overview = (await import('../src/app/views.ts')).overviewView(h.runtime.viewContext())
    expect(overview.monitor).toMatchObject({ enabled: true, paused: false, running: true })
  })

  it('does not subscribe when dws is not logged in and reports an error', async () => {
    const channel = new FakeChannel({ auth: { authenticated: false } })
    const h = await start({ channel })
    expect(h.channel.startCalls).toBe(0)
    const health = h.runtime.health()
    expect(health.status).toBe('error')
    expect(health.checks.find((check) => check.id === 'auth')?.detail).toContain('not logged in')
    expect(health.checks.find((check) => check.id === 'channel')?.status).toBe('error')
  })

  it('does not subscribe when the token is no longer valid', async () => {
    const h = await start({ channel: new FakeChannel({ auth: { tokenValid: false } }) })
    expect(h.channel.startCalls).toBe(0)
    expect(h.runtime.health().status).toBe('error')
    expect(h.runtime.health().checks.find((check) => check.id === 'auth')?.detail).toContain('no longer valid')
  })

  it('does not subscribe when authorization reports no account id', async () => {
    const h = await start({ channel: new FakeChannel({ auth: { userId: undefined } }) })
    expect(h.channel.startCalls).toBe(0)
    const health = h.runtime.health()
    expect(health.status).toBe('error')
    expect(health.checks.find((check) => check.id === 'auth')?.detail).toContain('account id')
  })

  it('does not start the channel when a prompt template cannot be loaded', async () => {
    const invisible = {
      get: () => {
        throw new Error('prompt template is missing')
      },
      preload: () => {
        throw new Error('prompt template is missing')
      },
    }
    const h = await start({ prompts: invisible })
    expect(h.channel.startCalls).toBe(0)
    expect(h.runtime.status()).toMatchObject({ promptsReady: false, executorAttached: false })
    const health = h.runtime.health()
    expect(health.status).toBe('error')
    expect(health.checks.find((check) => check.id === 'prompts')?.status).toBe('error')
    expect(h.runtime.status().promptError).not.toContain('/')
  })

  it('reports a channel that failed to start without subscribing', async () => {
    const channel = new FakeChannel()
    channel.startError = new Error('dws event consume failed')
    const h = await start({ channel })
    expect(h.channel.startCalls).toBe(1)
    expect(h.runtime.status().monitorRunning).toBe(false)
    const health = h.runtime.health()
    expect(health.status).toBe('error')
    expect(health.checks.find((check) => check.id === 'channel')?.detail).toContain('could not start')
  })

  it('passes the probed owner nick to the running channel', async () => {
    const probe = new FakeChannel({ auth: { userName: '鲸鱼酱' } })
    const running = new FakeChannel()
    let seen: { userId: string; ownerNick?: string } | undefined
    const h = await start({
      channel: probe,
      channelFactory: (owner) => {
        seen = owner
        return running
      },
    })

    expect(seen).toEqual({ userId: 'owner-1', ownerNick: '鲸鱼酱' })
    expect(running.startCalls).toBe(1)
    expect(h.runtime.status()).toMatchObject({ ownerKnown: true, monitorRunning: true })
  })

  it('does not invent an owner nick when auth reports none', async () => {
    const probe = new FakeChannel()
    const running = new FakeChannel()
    let seen: { userId: string; ownerNick?: string } | undefined
    await start({
      channel: probe,
      channelFactory: (owner) => {
        seen = owner
        return running
      },
    })

    expect(seen?.userId).toBe('owner-1')
    expect(seen?.ownerNick).toBeUndefined()
    expect(seen !== undefined && 'ownerNick' in seen).toBe(false)
    expect(running.startCalls).toBe(1)
  })
})

describe('pause, resume and settings changes', () => {
  it('stops the channel when paused and starts it again when resumed', async () => {
    const h = await start()
    const revision = () => h.runtime.settings.view().blocks.monitor.revision

    h.runtime.settings.update('monitor', { paused: true }, revision())
    h.timers.fire()
    await h.runtime.settled()
    expect(h.channel.stopCalls).toBe(1)
    expect(h.runtime.status().monitorRunning).toBe(false)
    expect(h.runtime.health().checks.find((check) => check.id === 'channel')?.detail).toContain('paused')

    h.runtime.settings.update('monitor', { paused: false }, revision())
    h.timers.fire()
    await h.runtime.settled()
    expect(h.channel.startCalls).toBe(2)
    expect(h.runtime.status().monitorRunning).toBe(true)
  })

  it('debounces target changes into one restart', async () => {
    const h = await start()
    const revision = () => h.runtime.settings.view().blocks.targets.revision
    h.runtime.settings.update(
      'targets',
      { rows: [{ kind: 'at-me', id: 'target-1', label: '', mentionOnly: true, replyMode: 'auto', enabled: true }] },
      revision(),
    )
    h.runtime.settings.update(
      'targets',
      { rows: [{ kind: 'at-me', id: 'target-2', label: '', mentionOnly: true, replyMode: 'auto', enabled: true }] },
      revision(),
    )
    expect(h.timers.delays()).toEqual([500])
    h.timers.fire()
    await h.runtime.settled()
    expect(h.channel.stopCalls).toBe(1)
    expect(h.channel.startCalls).toBe(2)
  })

  it('restarts the channel after a dws settings change', async () => {
    const h = await start()
    h.runtime.settings.update('dws', { eventTtlHours: 48 }, h.runtime.settings.view().blocks.dws.revision)
    expect(h.timers.delays()).toEqual([500])
    h.timers.fire()
    await h.runtime.settled()
    expect(h.channel.startCalls).toBe(2)
  })

  it('keeps the direct reply model stateless when the persona changes', async () => {
    const h = await start()
    h.runtime.settings.update('persona', { name: '新名字' }, 0)
    // The persona is rendered into each request; there is no replier session
    // whose prompt would have to be rebuilt.
    expect(h.model.resetCalls).toBe(0)
  })

  it('does not construct the session-based reply model', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/runtime.ts'), 'utf8')
    expect(source).not.toMatch(/SessionModel/)
    expect(source).toContain('replyModelFor')
  })

  it('declares every service the direct reply model touches', () => {
    const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
    expect(source).toMatch(/'agentDefaultModel'/)
    expect(source).toMatch(/'llm'/)
  })

  it('adopts a new reply model route', async () => {
    const h = await start()
    h.runtime.settings.update('models', { reply: { provider: 'p', model: 'm', effort: '' } }, 0)
    await Promise.resolve()
    expect(h.model.routes).toContain('p/m')
    expect(h.model.resetCalls).toBe(1)
  })
})

describe('outbox recovery', () => {
  it('delivers a pending follow-up when the channel is running', async () => {
    const h = await start()
    h.runtime.receive(inboundMessage())
    await h.runtime.effects.idle()
    // Stage a follow-up nobody enqueued, as a crash between the domain commit
    // and the send effect would leave it.
    const thread = h.runtime.engine.thread('at-me:target-1:conv-1')
    if (!thread) throw new Error('missing thread')
    h.runtime.engine.queueFollowup({
      threadKey: thread.key,
      target: { kind: 'at-me', conversationId: 'conv-1' },
      text: '崩溃后补发的一条',
      idempotencyKey: 'recovery-1',
      kind: 'reply',
      outboundId: 'outbound-recovery',
    })
    expect(h.channel.sends).toHaveLength(1)

    h.runtime.resumeOutbox()
    await h.runtime.effects.idle()
    expect(h.channel.sends).toHaveLength(2)
    expect(h.channel.sends[1]?.text).toBe('崩溃后补发的一条')
    const outbound = h.runtime.store.outbound.get('outbound-recovery')
    expect(outbound?.status).toBe('sent')

    // Resuming again finds nothing pending and never sends a duplicate.
    h.runtime.resumeOutbox()
    await h.runtime.effects.idle()
    expect(h.channel.sends).toHaveLength(2)
  })

  it('leaves the outbox pending while no channel is running and resumes after restart', async () => {
    const offline = new FakeChannel({ auth: { authenticated: false } })
    const first = await start({ channel: offline })
    first.runtime.receive(inboundMessage())
    await first.runtime.effects.idle()
    first.runtime.engine.queueFollowup({
      threadKey: 'at-me:target-1:conv-1',
      target: { kind: 'at-me', conversationId: 'conv-1' },
      text: '重启后补发的一条',
      idempotencyKey: 'recovery-2',
      kind: 'reply',
      outboundId: 'outbound-restart',
    })
    expect(offline.sends).toEqual([])
    await first.runtime.stop()

    const second = await start({}, join(root, 'state'))
    await second.runtime.effects.idle()
    expect(second.channel.sends.some((outbound) => outbound.text === '重启后补发的一条')).toBe(true)
    expect(second.runtime.store.outbound.get('outbound-restart')?.status).toBe('sent')
  })
})

describe('periodic passes', () => {
  it('expires an overdue approval on the expire pass', async () => {
    const h = await start()
    const { decision } = h.runtime.engine.receive(inboundMessage({ id: 'message-expire' }))
    const created = h.runtime.engine.classify(decision.id, {
      intent: 'task',
      task: { title: '会过期的任务' },
      approvalTtlMs: 1_000,
    })
    const taskId = created.taskId as string
    h.clock.advance(5_000)
    await h.runtime.tick(new Date(h.clock.now().getTime() + 61_000))
    expect(h.runtime.engine.task(taskId)?.status).toBe('expired')
    expect(h.runtime.store.approvals.byTaskId(taskId)?.status).toBe('expired')
  })

  it('recovers the channel on the five-minute probe after a login', async () => {
    const h = await start({ channel: new FakeChannel({ auth: { authenticated: false } }) })
    expect(h.channel.startCalls).toBe(0)
    h.channel.auth = { available: true, authenticated: true, tokenValid: true, userId: 'owner-1' }

    await h.runtime.tick(new Date(h.clock.now().getTime() + 5 * 60_000 + 1_000))
    h.timers.fire()
    await h.runtime.settled()

    expect(h.channel.startCalls).toBe(1)
    expect(h.runtime.status().monitorRunning).toBe(true)
    expect(h.runtime.health().status).toBe('ok')
  })
})

describe('shutdown', () => {
  it('stops in order, is idempotent and releases the lock and database', async () => {
    const h = await start()
    const original = h.model.dispose.bind(h.model)
    h.model.dispose = async () => {
      h.events.push('model:dispose')
      await original()
    }
    const promise = h.runtime.stop()
    expect(h.runtime.stop()).toBe(promise)
    await promise

    expect(h.channel.stopCalls).toBe(1)
    expect(h.executor.disposeCalls).toBe(1)
    expect(h.model.disposeCalls).toBe(1)
    expect(
      h.events.filter(
        (event) => event.startsWith('channel:') || event.startsWith('executor:') || event.startsWith('model:'),
      ),
    ).toEqual(['channel:stop', 'executor:dispose', 'model:dispose'])
    expect(h.runtime.closed).toBe(true)
    expect(h.runtime.facts()).toMatchObject({ lockHeld: false, databaseOpen: false })
    expect(() => h.runtime.store).toThrow(/not ready/)
  })
})
