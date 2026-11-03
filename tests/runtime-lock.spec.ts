import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Runtime, LOCK_STALE_MS } from '../src/app/runtime.ts'
import { SCHEMA_VERSION } from '../src/app/store.ts'

let root = ''
const runtimes = new Set<Runtime>()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-runtime-'))
})

afterEach(async () => {
  for (const runtime of runtimes) await runtime.stop()
  runtimes.clear()
  await rm(root, { recursive: true, force: true })
})

function runtimeAt(stateDir: string): Runtime {
  const runtime = new Runtime({ stateDir, logLevel: 'info' }, { now: () => new Date('2026-11-02T09:00:00.000Z') })
  runtimes.add(runtime)
  return runtime
}

describe('runtime startup', () => {
  it('opens the database, settings, engine and effects and holds the lock', async () => {
    const stateDir = join(root, 'state')
    const runtime = runtimeAt(stateDir)
    await runtime.ready

    expect(existsSync(join(stateDir, 'state.db'))).toBe(true)
    expect(existsSync(join(stateDir, '.lock'))).toBe(true)
    expect(runtime.facts()).toEqual({
      stateDirWritable: true,
      lockHeld: true,
      databaseOpen: true,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(runtime.settings.view().revision).toBe(0)
    expect(runtime.engine.task('missing')).toBeUndefined()
    expect(runtime.effects.pending()).toEqual([])
    expect(runtime.state()).toMatchObject({ ok: true, stateDir, startedAt: '2026-11-02T09:00:00.000Z' })
    expect(runtime.health()).toMatchObject({ ok: true, status: 'ok' })
    expect(LOCK_STALE_MS).toBe(10_000)
  })

  it('persists settings across a stop and a fresh runtime', async () => {
    const stateDir = join(root, 'state-persist')
    const first = runtimeAt(stateDir)
    await first.ready
    first.settings.update('monitor', { paused: true }, 0)
    await first.stop()

    const second = runtimeAt(stateDir)
    await second.ready
    expect(second.settings.current().monitor.paused).toBe(true)
    expect(second.settings.view().revision).toBe(1)
  })
})

describe('state directory lock', () => {
  it('refuses a second runtime on the same directory and recovers after stop', async () => {
    const stateDir = join(root, 'state-lock')
    const first = runtimeAt(stateDir)
    await first.ready

    const second = runtimeAt(stateDir)
    await expect(second.ready).rejects.toThrow(/already in use/)
    await second.stop()
    // The first runtime is untouched by the refused second one.
    expect(first.settings.view().revision).toBe(0)
    expect(first.facts().lockHeld).toBe(true)

    await first.stop()
    expect(first.facts()).toMatchObject({ lockHeld: false, databaseOpen: false })

    const third = runtimeAt(stateDir)
    await third.ready
    expect(third.facts().lockHeld).toBe(true)
  })

  it('stops idempotently and leaves no lock behind', async () => {
    const stateDir = join(root, 'state-stop')
    const runtime = runtimeAt(stateDir)
    await runtime.ready
    await runtime.stop()
    await runtime.stop()
    expect(runtime.closed).toBe(true)
    expect(existsSync(join(stateDir, '.lock'))).toBe(false)
    expect(() => runtime.store).toThrow(/not ready/)
  })
})

describe('runtime startup failures', () => {
  it('rejects ready when the state directory cannot be created and stop still settles', async () => {
    const stateDir = join(root, 'state-is-a-file')
    await writeFile(stateDir, 'not a directory', 'utf8')
    const runtime = runtimeAt(stateDir)
    await expect(runtime.ready).rejects.toThrow()
    await runtime.stop()
    expect(runtime.facts()).toMatchObject({ lockHeld: false, databaseOpen: false })
  })

  it('releases the lock when the database cannot be opened', async () => {
    const stateDir = join(root, 'state-bad-db')
    await mkdir(join(stateDir, 'state.db'), { recursive: true })
    const runtime = runtimeAt(stateDir)
    await expect(runtime.ready).rejects.toThrow()
    await runtime.stop()
    expect(existsSync(join(stateDir, '.lock'))).toBe(false)

    // A later runtime can take the directory once the obstacle is gone.
    await rm(join(stateDir, 'state.db'), { recursive: true, force: true })
    const recovered = runtimeAt(stateDir)
    await recovered.ready
    expect(recovered.facts().databaseOpen).toBe(true)
  })
})
