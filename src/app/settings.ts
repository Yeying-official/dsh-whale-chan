/**
 * In-memory settings canary for the WS0 API contract.
 *
 * It proves the settings wire shape, per-block revisions and optimistic
 * concurrency behaviour before WS4 adds durable storage. Nothing here is
 * persisted, and this module never performs I/O. A restart resets every value
 * to the frozen defaults and every revision to zero.
 */
import type { PersonaView, SettingsBlockView, SettingsUpdateResult, SettingsView } from '../shared/models.ts'
import {
  SETTINGS_BLOCKS,
  SETTINGS_DEFAULTS,
  SettingsSchema,
  type Settings,
  type SettingsBlock,
} from '../shared/settings.ts'

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

export class SettingsValueError extends Error {
  readonly code = 'invalid_settings'

  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super('The settings value does not match the frozen schema')
    this.name = 'SettingsValueError'
  }
}

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

/** Mutable settings state used by the HTTP contract canary. */
export class SettingsState {
  private current: Settings
  private readonly revisions: Record<SettingsBlock, number>
  private globalRevision = 0

  constructor(initial: Settings = SETTINGS_DEFAULTS) {
    this.current = structuredClone(initial)
    this.revisions = Object.fromEntries(SETTINGS_BLOCKS.map((block) => [block, 0])) as Record<SettingsBlock, number>
  }

  view(): SettingsView {
    const blocks = Object.fromEntries(
      SETTINGS_BLOCKS.map((block) => [
        block,
        { block, value: structuredClone(this.current[block]), revision: this.revisions[block] },
      ]),
    ) as Record<SettingsBlock, SettingsBlockView>
    return { blocks, revision: this.globalRevision }
  }

  persona(): PersonaView {
    return { persona: structuredClone(this.current.persona), revision: this.revisions.persona }
  }

  /** Merge one block and reject a stale or malformed write. */
  update(block: SettingsBlock, value: Record<string, unknown>, expectedRevision: number): SettingsUpdateResult {
    const actualRevision = this.revisions[block]
    if (expectedRevision !== actualRevision) {
      throw new SettingsConflictError(block, expectedRevision, actualRevision)
    }

    const merged = deepMerge(this.current[block], value)
    const parsed = SettingsSchema.safeParse({ ...this.current, [block]: merged })
    if (!parsed.success) {
      throw new SettingsValueError(
        parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      )
    }

    this.current = parsed.data
    this.revisions[block] += 1
    this.globalRevision += 1
    return { block, value: structuredClone(this.current[block]), revision: this.revisions[block] }
  }
}
