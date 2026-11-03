/**
 * Durable, versioned settings.
 *
 * Every block is stored as one JSON row with its own revision, which is the
 * optimistic-concurrency token the management API exposes. A write validates
 * the merged block against the frozen `SettingsSchema` and then commits three
 * things in one transaction: the block row, one history row and the global
 * revision. A restart therefore reloads exactly what the owner saved, and a
 * stale `revision` is refused instead of overwriting a newer value.
 *
 * A block that cannot be read or no longer validates never prevents startup:
 * it falls back to its frozen default and is reported through `warnings()`, so
 * the health view can show what happened instead of the plugin failing to load.
 */
import type { StatementSync } from 'node:sqlite'
import type { Clock } from '../core/index.ts'
import type { PersonaView, SettingsBlockView, SettingsUpdateResult, SettingsView } from '../shared/models.ts'
import { EMPTY_PERSONA, PERSONA_PRESETS } from '../shared/persona-defaults.ts'
import {
  SETTINGS_BLOCKS,
  SETTINGS_DEFAULTS,
  SettingsSchema,
  type Settings,
  type SettingsBlock,
} from '../shared/settings.ts'
import type { Store } from './store.ts'

/** A write carried a revision that is not the block's current one. */
export class SettingsConflictError extends Error {
  readonly code = 'settings_conflict'

  constructor(
    readonly block: SettingsBlock,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Settings for ${block} changed: expected revision ${expectedRevision}, current revision ${actualRevision}`)
    this.name = 'SettingsConflictError'
  }
}

/** The merged block is not a valid settings value. */
export class SettingsValueError extends Error {
  readonly code = 'invalid_settings'

  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super('The settings value does not match the frozen schema')
    this.name = 'SettingsValueError'
  }
}

/** One historical settings value, as recorded by `settings_history`. */
export interface SettingsVersion {
  readonly block: SettingsBlock
  readonly value: unknown
  readonly revision: number
  readonly source: string
  readonly savedAt: string
}

/** One committed settings write, delivered to `onChange` listeners. */
export interface SettingsChange {
  readonly block: SettingsBlock
  readonly value: unknown
  readonly revision: number
  readonly source: string
}

/** A settings block that could not be loaded; the block kept its default value. */
export interface SettingsWarning {
  readonly block: string
  readonly message: string
}

export type SettingsListener = (change: SettingsChange) => void

/** `source` recorded for a write that came through the management panel. */
export const SETTINGS_SOURCE_PANEL = 'panel'

/** `source` recorded for a system write such as `monitor/pause`. */
export const SETTINGS_SOURCE_INTERNAL = 'internal'

/** True only for plain records; arrays, null and scalars are replacements. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Recursively merge one settings block.
 *
 * Only two plain objects are merged. Arrays, scalars and `null` replace the
 * previous value wholesale, and an absent key keeps its previous value. Unknown
 * keys survive this step so `SettingsSchema` can reject them with strict mode.
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const merged = Object.fromEntries(Object.entries(base))
  for (const [key, value] of Object.entries(patch)) {
    const next = Object.prototype.hasOwnProperty.call(base, key) ? deepMerge(base[key], value) : value
    Object.defineProperty(merged, key, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return merged
}

function isBlock(value: string): value is SettingsBlock {
  return (SETTINGS_BLOCKS as readonly string[]).includes(value)
}

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): readonly {
  path: string
  message: string
}[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))
}

/** Durable settings service: one row per block plus append-only history. */
export class SettingsService {
  private value: Settings
  private readonly revisions: Record<SettingsBlock, number>
  private global: number
  private readonly loadWarnings: SettingsWarning[] = []
  private readonly listeners = new Set<SettingsListener>()
  private readonly statements = new Map<string, StatementSync>()

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {
    this.value = structuredClone(SETTINGS_DEFAULTS)
    this.revisions = Object.fromEntries(SETTINGS_BLOCKS.map((block) => [block, 0])) as Record<SettingsBlock, number>
    this.global = 0
    this.load()
  }

  /** The current complete settings value; callers receive a copy. */
  current(): Settings {
    return structuredClone(this.value)
  }

  /** Every block with its value and revision, plus the global revision. */
  view(): SettingsView {
    const blocks = Object.fromEntries(
      SETTINGS_BLOCKS.map((block) => [
        block,
        {
          block,
          value: structuredClone(this.value[block]),
          revision: this.revisions[block],
        } satisfies SettingsBlockView,
      ]),
    ) as Record<SettingsBlock, SettingsBlockView>
    return { blocks, revision: this.global }
  }

  /**
   * The persona block, its own revision, the empty default and the shipped presets.
   *
   * `defaults` and `presets` are deep copies: the client fills its draft from
   * them, and a caller must never be able to mutate the frozen definitions.
   */
  persona(): PersonaView {
    return {
      persona: structuredClone(this.value.persona),
      revision: this.revisions.persona,
      defaults: structuredClone(EMPTY_PERSONA),
      presets: structuredClone(PERSONA_PRESETS),
    }
  }

  /** Blocks that fell back to their defaults because the stored row was unusable. */
  warnings(): readonly SettingsWarning[] {
    return [...this.loadWarnings]
  }

  /**
   * Merge one block and commit it, refusing a stale or malformed write.
   *
   * The expected revision is the block revision the caller last read; a
   * mismatch means someone else saved first and the caller must reload.
   */
  update(block: SettingsBlock, patch: Record<string, unknown>, expectedRevision: number): SettingsUpdateResult {
    return this.write(block, patch, expectedRevision, SETTINGS_SOURCE_PANEL)
  }

  /**
   * Write one block without an expected revision.
   *
   * Only the host itself uses this, for settings it owns rather than the owner:
   * pausing the monitor must not fail because the panel was open. The value is
   * still validated and still recorded in the history.
   */
  patchInternal(
    block: SettingsBlock,
    patch: Record<string, unknown>,
    source: string = SETTINGS_SOURCE_INTERNAL,
  ): SettingsUpdateResult {
    return this.write(block, patch, undefined, source)
  }

  /** Newest-first history, optionally for one block. */
  history(block?: SettingsBlock, limit = 100): readonly SettingsVersion[] {
    const rows = (
      block === undefined
        ? this.statement(
            'SELECT block, value_json, revision, source, saved_at FROM settings_history ORDER BY id DESC LIMIT ?',
          ).all(limit)
        : this.statement(
            'SELECT block, value_json, revision, source, saved_at FROM settings_history WHERE block = ? ORDER BY id DESC LIMIT ?',
          ).all(block, limit)
    ) as readonly Record<string, unknown>[]
    const versions: SettingsVersion[] = []
    for (const row of rows) {
      const name = String(row['block'])
      if (!isBlock(name)) continue
      let value: unknown
      try {
        value = JSON.parse(String(row['value_json']))
      } catch {
        continue
      }
      versions.push({
        block: name,
        value,
        revision: Number(row['revision']),
        source: String(row['source']),
        savedAt: String(row['saved_at']),
      })
    }
    return versions
  }

  /** Observe committed writes; the returned function unsubscribes. */
  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private write(
    block: SettingsBlock,
    patch: Record<string, unknown>,
    expectedRevision: number | undefined,
    source: string,
  ): SettingsUpdateResult {
    const actualRevision = this.revisions[block]
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
      throw new SettingsConflictError(block, expectedRevision, actualRevision)
    }

    const merged = deepMerge(this.value[block], patch)
    const parsed = SettingsSchema.safeParse({ ...this.value, [block]: merged })
    if (!parsed.success) throw new SettingsValueError(issuesOf(parsed.error))

    const next = parsed.data[block]
    const revision = actualRevision + 1
    const at = this.clock.now().toISOString()
    const valueJson = JSON.stringify(next)
    const global = this.global + 1

    this.store.atomic(() => {
      this.statement(
        `INSERT INTO settings (block, value_json, revision, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(block) DO UPDATE SET
           value_json = excluded.value_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      ).run(block, valueJson, revision, at)
      this.statement(
        'INSERT INTO settings_history (block, value_json, revision, source, saved_at) VALUES (?, ?, ?, ?, ?)',
      ).run(block, valueJson, revision, source, at)
      this.statement(
        `INSERT INTO settings_meta (id, revision, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`,
      ).run(global, at)
    })

    this.value = parsed.data
    this.revisions[block] = revision
    this.global = global
    const change: SettingsChange = { block, value: structuredClone(next), revision, source }
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A listener cannot undo a committed write, and one failing listener
        // must not stop the others.
      }
    }
    return { block, value: change.value, revision }
  }

  /**
   * Read every block once at startup.
   *
   * A missing block keeps its default; an unreadable or invalid row keeps its
   * default and records a warning. The global revision is repaired upwards if
   * it is missing or behind the block revisions, so a hand-edited database
   * cannot make the panel observe a revision that is lower than a block's.
   */
  private load(): void {
    const rows = this.store.db.prepare('SELECT block, value_json, revision FROM settings').all() as readonly Record<
      string,
      unknown
    >[]
    let highestStored = 0
    for (const row of rows) {
      const name = String(row['block'])
      if (!isBlock(name)) {
        this.loadWarnings.push({ block: name, message: 'unknown settings block was ignored' })
        continue
      }
      const storedRevision = Number(row['revision'])
      const revision = Number.isInteger(storedRevision) && storedRevision >= 0 ? storedRevision : 0
      // Even an unusable row keeps the global revision from regressing: the
      // panel may still hold that revision as its last observed version.
      highestStored = Math.max(highestStored, revision)
      let decoded: unknown
      try {
        decoded = JSON.parse(String(row['value_json']))
      } catch {
        this.loadWarnings.push({ block: name, message: 'stored value is not readable JSON; defaults are in effect' })
        continue
      }
      const parsed = SettingsSchema.safeParse({ ...this.value, [name]: decoded })
      if (!parsed.success) {
        this.loadWarnings.push({
          block: name,
          message: 'stored value no longer matches the schema; defaults are in effect',
        })
        continue
      }
      if (revision !== storedRevision) {
        this.loadWarnings.push({ block: name, message: 'stored revision is invalid; the block restarts at revision 0' })
      }
      this.revisions[name] = revision
      this.value = { ...this.value, [name]: parsed.data[name] }
    }

    const meta = this.store.db.prepare('SELECT revision FROM settings_meta WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined
    const stored = meta === undefined ? 0 : Number(meta['revision'])
    const floor = Math.max(highestStored, ...Object.values(this.revisions))
    if (!Number.isInteger(stored) || stored < floor) {
      this.loadWarnings.push({
        block: 'meta',
        message: 'global settings revision was repaired from the block revisions',
      })
      this.global = floor
      this.store.atomic(() => {
        this.statement(
          `INSERT INTO settings_meta (id, revision, updated_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`,
        ).run(floor, this.clock.now().toISOString())
      })
    } else {
      this.global = stored
    }
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.store.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }
}
