import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Health } from '../src/shared/models.ts'
import type { RuntimeServiceStatus } from '../src/app/runtime.ts'
import { healthView } from '../src/app/views.ts'
import { startPipeline, type PipelineHarness, type PipelineOptions } from './fixtures/pipeline.ts'

let root = ''
let harness: PipelineHarness | undefined

async function start(options: Omit<PipelineOptions, 'stateDir'> = {}): Promise<PipelineHarness> {
  harness = await startPipeline({ stateDir: join(root, 'state'), ...options })
  return harness
}

/** Render the health view with one explicit channel status override. */
function healthOf(h: PipelineHarness, patch: Partial<RuntimeServiceStatus>): Health {
  const base = h.runtime.viewContext()
  const status = { ...h.runtime.status(), ...patch }
  return healthView({ ...base, runtime: { ...base.runtime, status: () => status } })
}

function channel(h: Health) {
  const check = h.checks.find((item) => item.id === 'channel')
  if (!check) throw new Error('the health view has no channel check')
  return check
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-health-'))
})

afterEach(async () => {
  await harness?.runtime.stop()
  harness = undefined
  await rm(root, { recursive: true, force: true })
})

describe('channel health projects idle states as healthy', () => {
  it('reports disabled monitoring as ok', async () => {
    const h = await start()
    h.runtime.settings.update('monitor', { enabled: false }, 0)
    const health = healthOf(h, { channelState: 'stopped' })

    expect(channel(health)).toMatchObject({ status: 'ok', detail: 'monitoring is disabled in settings' })
    expect(health.status).toBe('ok')
  })

  it('reports a paused assistant as ok, not degraded', async () => {
    const h = await start()
    h.runtime.settings.update('monitor', { paused: true }, 0)
    const health = healthOf(h, { channelState: 'stopped', paused: true })

    expect(channel(health)).toMatchObject({ status: 'ok', detail: 'paused by the owner' })
    expect(health.status).toBe('ok')
  })

  it('reports an attached channel with no enabled target as idle and ok', async () => {
    const h = await start({ settings: { targets: { rows: [] } } })
    const health = healthOf(h, { channelState: 'stopped', channelTargets: [] })

    expect(channel(health)).toMatchObject({ status: 'ok', detail: 'idle: no enabled targets' })
    expect(health.status).toBe('ok')
  })

  it('still reports a stopped channel with an enabled target as degraded', async () => {
    const h = await start()
    const health = healthOf(h, { channelState: 'stopped', channelError: null })

    expect(channel(health)).toMatchObject({ status: 'degraded', detail: 'not running' })
    expect(health.status).toBe('degraded')
  })
})
