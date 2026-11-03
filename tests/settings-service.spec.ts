import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, SCHEMA_VERSION } from '../src/app/migration.ts'
import { SettingsConflictError, SettingsService, SettingsValueError } from '../src/app/settings.ts'
import { Store } from '../src/app/store.ts'
import { SETTINGS_BLOCKS, SETTINGS_DEFAULTS } from '../src/shared/settings.ts'
import { createClock } from './fixtures/domain.ts'

let root = ''
let store: Store | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-settings-'))
})

afterEach(async () => {
  try {
    store?.close()
  } catch {
    // A test may have closed the handle itself.
  }
  store = undefined
  await rm(root, { recursive: true, force: true })
})

function open(clock = createClock()): { settings: SettingsService; database: Store } {
  try {
    store?.close()
  } catch {
    // A test may have closed the handle directly before reopening.
  }
  store = Store.open(root)
  return { settings: new SettingsService(store, clock), database: store }
}

describe('settings service defaults', () => {
  it('starts from the frozen defaults with every block at revision zero', () => {
    const { settings } = open()
    const view = settings.view()
    expect(view.revision).toBe(0)
    expect(Object.keys(view.blocks).sort()).toEqual([...SETTINGS_BLOCKS].sort())
    for (const block of SETTINGS_BLOCKS) {
      expect(view.blocks[block]).toEqual({ block, value: SETTINGS_DEFAULTS[block], revision: 0 })
    }
    expect(settings.current()).toEqual(SETTINGS_DEFAULTS)
    expect(settings.persona()).toEqual({ persona: SETTINGS_DEFAULTS.persona, revision: 0 })
    expect(settings.warnings()).toEqual([])
  })

  it('returns copies so a caller cannot mutate the service state', () => {
    const { settings } = open()
    const value = settings.current()
    value.monitor.paused = true
    expect(settings.current().monitor.paused).toBe(false)
  })
})

describe('settings persistence', () => {
  it('writes one block and reloads it after reopening the database', () => {
    const first = open()
    const result = first.settings.update('monitor', { paused: true }, 0)
    expect(result).toEqual({ block: 'monitor', value: expect.objectContaining({ paused: true }), revision: 1 })
    store?.close()

    const second = open()
    expect(second.settings.current().monitor.paused).toBe(true)
    expect(second.settings.view().blocks.monitor?.revision).toBe(1)
    expect(second.settings.view().revision).toBe(1)
  })

  it('increments each block revision and the global revision independently', () => {
    const { settings } = open()
    settings.update('monitor', { paused: true }, 0)
    settings.update('monitor', { paused: false }, 1)
    settings.update('reply', { autoReply: false }, 0)
    const view = settings.view()
    expect(view.blocks.monitor?.revision).toBe(2)
    expect(view.blocks.reply?.revision).toBe(1)
    expect(view.blocks.persona?.revision).toBe(0)
    expect(view.revision).toBe(3)
  })

  it('refuses a stale block revision without writing anything', () => {
    const { settings } = open()
    settings.update('monitor', { paused: true }, 0)
    const error = (() => {
      try {
        settings.update('monitor', { paused: false }, 0)
        return undefined
      } catch (failure) {
        return failure
      }
    })()
    expect(error).toBeInstanceOf(SettingsConflictError)
    expect(error).toMatchObject({ code: 'settings_conflict', block: 'monitor', expectedRevision: 0, actualRevision: 1 })
    expect(settings.current().monitor.paused).toBe(true)
    expect(settings.history('monitor')).toHaveLength(1)
  })

  it('deep-merges nested objects and replaces arrays wholesale', () => {
    const { settings } = open()
    settings.update('monitor', { quietHours: { enabled: false } }, 0)
    expect(settings.current().monitor.quietHours).toEqual({ enabled: false, start: '22:00', end: '08:00' })

    settings.update('reply', { allowedSenders: ['alice', 'bob'] }, 0)
    settings.update('reply', { allowedSenders: ['carol'] }, 1)
    expect(settings.current().reply.allowedSenders).toEqual(['carol'])
  })

  it('rejects an unknown key and keeps the previous value and revision', () => {
    const { settings } = open()
    const error = (() => {
      try {
        settings.update('monitor', { quietHours: { foo: true } }, 0)
        return undefined
      } catch (failure) {
        return failure
      }
    })()
    expect(error).toBeInstanceOf(SettingsValueError)
    expect((error as SettingsValueError).issues.map((issue) => issue.path)).toContain('monitor.quietHours')
    expect(settings.current().monitor.quietHours).toEqual(SETTINGS_DEFAULTS.monitor.quietHours)
    expect(settings.view().blocks.monitor?.revision).toBe(0)
    expect(settings.history()).toEqual([])
  })

  it('rejects a value outside the schema boundaries', () => {
    const { settings } = open()
    expect(() => settings.update('monitor', { intervalSeconds: 1 }, 0)).toThrow(SettingsValueError)
    expect(() => settings.update('monitor', { intervalSeconds: 301 }, 0)).toThrow(SettingsValueError)
    expect(settings.current().monitor.intervalSeconds).toBe(45)
  })
})

describe('settings recovery', () => {
  it('falls back to the default of a corrupt row and keeps the other blocks', () => {
    const first = open()
    first.settings.update('reply', { autoReply: false }, 0)
    first.database.db
      .prepare("INSERT INTO settings (block, value_json, revision, updated_at) VALUES ('monitor', '{', 4, ?)")
      .run('2026-11-02T09:00:00.000Z')
    store?.close()

    const second = open()
    expect(second.settings.current().monitor).toEqual(SETTINGS_DEFAULTS.monitor)
    expect(second.settings.current().reply.autoReply).toBe(false)
    expect(second.settings.warnings().map((warning) => warning.block)).toContain('monitor')
    // The global revision never regresses below a stored block revision.
    expect(second.settings.view().revision).toBe(4)
  })

  it('falls back when a stored block no longer matches the schema', () => {
    const first = open()
    first.database.db
      .prepare("INSERT INTO settings (block, value_json, revision, updated_at) VALUES ('monitor', ?, 1, ?)")
      .run(JSON.stringify({ ...SETTINGS_DEFAULTS.monitor, intervalSeconds: 1 }), '2026-11-02T09:00:00.000Z')
    store?.close()

    const second = open()
    expect(second.settings.current().monitor).toEqual(SETTINGS_DEFAULTS.monitor)
    expect(second.settings.warnings()).toContainEqual(
      expect.objectContaining({ block: 'monitor', message: expect.stringContaining('schema') }),
    )
  })

  it('repairs a missing global revision row from the block revisions', () => {
    const first = open()
    first.settings.update('monitor', { paused: true }, 0)
    first.settings.update('monitor', { paused: false }, 1)
    first.database.db.exec('DELETE FROM settings_meta')
    store?.close()

    const second = open()
    expect(second.settings.view().revision).toBe(2)
    expect(second.settings.warnings().map((warning) => warning.block)).toContain('meta')
  })
})

describe('settings history', () => {
  it('records every write with its revision and source, newest first', () => {
    const { settings } = open()
    settings.update('monitor', { paused: true }, 0)
    settings.patchInternal('monitor', { paused: false })
    settings.update('reply', { autoReply: false }, 0)

    const all = settings.history()
    expect(all).toHaveLength(3)
    expect(all.map((version) => version.block)).toEqual(['reply', 'monitor', 'monitor'])
    expect(all[1]).toMatchObject({ block: 'monitor', revision: 2, source: 'internal' })
    expect(all[2]).toMatchObject({ block: 'monitor', revision: 1, source: 'panel' })

    const monitor = settings.history('monitor')
    expect(monitor.map((version) => version.revision)).toEqual([2, 1])
    expect(monitor[0]?.value).toMatchObject({ paused: false })
  })

  it('lets the host write a system block without an expected revision', () => {
    const { settings } = open()
    settings.patchInternal('monitor', { paused: true })
    settings.patchInternal('monitor', { paused: false })
    expect(settings.view().blocks.monitor?.revision).toBe(2)
    expect(() => settings.patchInternal('monitor', { intervalSeconds: 0 })).toThrow(SettingsValueError)
  })

  it('notifies listeners only after a committed write', () => {
    const { settings } = open()
    const seen: string[] = []
    const unsubscribe = settings.onChange((change) => seen.push(`${change.block}:${change.revision}`))
    settings.update('monitor', { paused: true }, 0)
    expect(() => settings.update('monitor', { nope: true }, 1)).toThrow(SettingsValueError)
    settings.patchInternal('reply', { autoReply: false })
    unsubscribe()
    settings.update('persona', { name: '小鲸鱼' }, 0)
    expect(seen).toEqual(['monitor:1', 'reply:1'])
  })
})

describe('settings schema migration', () => {
  it('upgrades a version 1 database to version 2 and is idempotent', () => {
    const file = join(root, 'state.db')
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA user_version = 1')
    raw.close()

    const first = Store.open(root)
    expect(first.schemaVersion()).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(2)
    const tables = first.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row['name']))
    expect(tables).toEqual(expect.arrayContaining(['settings', 'settings_history', 'settings_meta']))
    first.close()

    const second = Store.open(root)
    expect(second.schemaVersion()).toBe(SCHEMA_VERSION)
    // Running the version 2 step again is a no-op, not an error.
    MIGRATIONS[1]?.(second.db)
    MIGRATIONS[1]?.(second.db)
    const meta = second.db.prepare('SELECT COUNT(*) AS n FROM settings_meta').get()
    expect(Number(meta?.['n'])).toBe(1)
    const version = second.db.prepare('SELECT revision FROM settings_meta WHERE id = 1').get()
    expect(Number(version?.['revision'])).toBe(0)
    second.close()
  })

  it('creates the settings tables on a fresh database', () => {
    const { database } = open()
    const names = database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'settings_history_block'")
      .all()
    expect(names).toHaveLength(1)
    expect(database.schemaVersion()).toBe(SCHEMA_VERSION)
  })
})
