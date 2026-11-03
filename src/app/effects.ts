/**
 * Durable effects queue.
 *
 * A domain command cannot perform a side effect: it can only stage one. The
 * caller therefore enqueues an effect after its transaction committed, and this
 * queue owns retries and ordering. The queue does not know about transactions;
 * a row that is enqueued inside a transaction is simply written by that
 * transaction and first runs afterwards.
 *
 * Retries use exponential backoff: `baseDelayMs * 2^(attempts-1)`, capped at
 * five minutes, plus a small jitter so several failing keys do not wake at the
 * same instant. `Later` defers one attempt by a second without counting it as a
 * failure, which a handler uses when it is merely not allowed to run yet.
 *
 * A row keeps at most one active execution. The partial unique index admits one
 * `waiting`/`running` row per `(kind, key)`; enqueueing that key while its
 * attempt is running cannot insert a second row, so it rewrites the payload,
 * bumps `generation`, and the finishing attempt puts the row back to `waiting`
 * instead of deleting it. The newer work is never lost and the running attempt
 * never deletes it either.
 */
import { randomUUID } from 'node:crypto'
import type { StatementSync } from 'node:sqlite'
import type { Store } from './store.ts'

/** Thrown by a handler that cannot run now; the attempt is deferred without counting as a failure. */
export class Later extends Error {
  constructor(message = 'Effect deferred until later') {
    super(message)
    this.name = 'Later'
  }
}

/** The longest automatic retry delay. */
export const MAX_BACKOFF_MS = 5 * 60_000

/** Delay applied to an attempt that throws `Later`. */
export const LATER_DELAY_MS = 1000

export type EffectState = 'waiting' | 'running' | 'dead'

/** One effect row as the panel and tests may inspect it. */
export interface EffectRecord {
  readonly id: string
  readonly kind: string
  readonly key: string
  readonly state: EffectState
  readonly attempts: number
  /** Epoch milliseconds at which the row becomes due. */
  readonly dueAt: number
  readonly lastError: string | null
  readonly payload: unknown
  readonly createdAt: number
  readonly updatedAt: number
  readonly generation: number
}

export type EffectHandler = (payload: unknown, key: string) => void | Promise<void>

export interface HandleOptions {
  /** Failed attempts after which the row becomes `dead`; defaults to 5. */
  readonly maxAttempts?: number
  /** First retry delay in milliseconds; doubles per failed attempt; defaults to 2000. */
  readonly baseDelayMs?: number
}

export interface StartOptions {
  /** Attempts that may run at the same time across all kinds; defaults to 1. */
  readonly concurrency?: number
}

export interface EffectsOptions {
  /** Epoch-millisecond clock seam; tests advance it to reach backoff deadlines. */
  readonly now?: () => number
  /** Jitter source in `[0, 1)`; defaults to `Math.random`. */
  readonly random?: () => number
}

interface Handler {
  readonly run: EffectHandler
  readonly maxAttempts: number
  readonly baseDelayMs: number
}

interface EffectRow {
  readonly id: string
  readonly kind: string
  readonly key: string
  readonly payloadJson: string
  readonly state: EffectState
  readonly attempts: number
  readonly dueAt: number
  readonly lastError: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly generation: number
}

const COLUMNS = 'id, kind, key, payload_json, state, attempts, due_at, last_error, created_at, updated_at, generation'

export class Effects {
  private readonly handlers = new Map<string, Handler>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly inFlightKeys = new Set<string>()
  private readonly statements = new Map<string, StatementSync>()
  private readonly now: () => number
  private readonly random: () => number
  private concurrency = 1
  private started = false
  private stopped = false
  private pumpScheduled = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly store: Store,
    options: EffectsOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? (() => Math.random())
  }

  /**
   * Stage an effect. A `waiting` row with the same `(kind, key)` takes the new
   * payload and becomes due immediately; a `running` row takes the new payload
   * and runs again when its attempt ends; otherwise a new row is inserted.
   */
  enqueue(kind: string, key: string, payload: unknown): void {
    const at = this.now()
    const json = JSON.stringify(payload ?? null)
    const waiting = this.statement(
      `UPDATE effects SET payload_json = ?, attempts = 0, last_error = NULL, due_at = ?, updated_at = ?,
         generation = generation + 1
       WHERE kind = ? AND key = ? AND state = 'waiting'`,
    ).run(json, at, at, kind, key)
    if (Number(waiting.changes) === 0) {
      const running = this.statement(
        `UPDATE effects SET payload_json = ?, attempts = 0, last_error = NULL, updated_at = ?,
           generation = generation + 1
         WHERE kind = ? AND key = ? AND state = 'running'`,
      ).run(json, at, kind, key)
      if (Number(running.changes) === 0) {
        this.statement(
          `INSERT INTO effects (id, kind, key, payload_json, state, attempts, due_at, created_at, updated_at, generation)
           VALUES (?, ?, ?, ?, 'waiting', 0, ?, ?, ?, 0)`,
        ).run(randomUUID(), kind, key, json, at, at, at)
      }
    }
    this.kick()
  }

  /** Register the one handler of a kind; registering a second handler is a programming error. */
  handle(kind: string, run: EffectHandler, options: HandleOptions = {}): void {
    if (this.handlers.has(kind)) throw new Error(`Effects of kind "${kind}" already have a handler`)
    this.handlers.set(kind, {
      run,
      maxAttempts: options.maxAttempts ?? 5,
      baseDelayMs: options.baseDelayMs ?? 2000,
    })
    this.kick()
  }

  /** Begin dispatching due rows; rows enqueued before `start` wait for it. */
  start(options: StartOptions = {}): void {
    if (options.concurrency !== undefined) this.concurrency = Math.max(1, Math.floor(options.concurrency))
    this.started = true
    this.stopped = false
    this.kick()
  }

  /**
   * Claim what is due now, then stop starting new work and wait for the
   * attempts that are running. Waiting rows stay in SQLite for the next start.
   */
  async drain(): Promise<void> {
    this.dispatch()
    this.stopped = true
    this.clearTimer()
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()])
    }
  }

  /** Resolve once nothing is running and no due row can start now. */
  async idle(): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.inFlight.values()]
      if (running.length > 0) {
        await Promise.allSettled(running)
        continue
      }
      return
    }
  }

  /** Rows still waiting or running, earliest due first. */
  pending(): readonly EffectRecord[] {
    return this.select(
      `SELECT ${COLUMNS} FROM effects WHERE state IN ('waiting', 'running') ORDER BY due_at, rowid`,
    ).map(effectRecord)
  }

  /** Rows that exhausted their attempts; they stay for inspection until a new enqueue replaces them. */
  dead(): readonly EffectRecord[] {
    return this.select(`SELECT ${COLUMNS} FROM effects WHERE state = 'dead' ORDER BY updated_at, rowid`).map(
      effectRecord,
    )
  }

  private dispatch(): void {
    if (!this.started || this.stopped) return
    if (this.inFlight.size >= this.concurrency) return
    const at = this.now()
    const due = this.select(
      `SELECT ${COLUMNS} FROM effects WHERE state = 'waiting' AND due_at <= ? ORDER BY due_at, rowid LIMIT 64`,
      at,
    )
    for (const row of due) {
      if (this.inFlight.size >= this.concurrency) break
      const handler = this.handlers.get(row.kind)
      if (!handler) continue
      const claim = `${row.kind}\u0000${row.key}`
      if (this.inFlightKeys.has(claim)) continue
      const claimed = this.statement(
        "UPDATE effects SET state = 'running', updated_at = ? WHERE id = ? AND state = 'waiting' AND generation = ?",
      ).run(at, row.id, row.generation)
      if (Number(claimed.changes) === 0) continue
      this.inFlightKeys.add(claim)
      const task = this.attempt(row, handler).finally(() => {
        this.inFlight.delete(row.id)
        this.inFlightKeys.delete(claim)
        this.kick()
      })
      this.inFlight.set(row.id, task)
    }
  }

  private async attempt(row: EffectRow, handler: Handler): Promise<void> {
    const at = this.now()
    let error: unknown = undefined
    let failed = false
    try {
      await handler.run(this.parsePayload(row), row.key)
    } catch (caught) {
      failed = true
      error = caught
    }
    const current = this.row(row.id)
    const replaced = current !== undefined && current.generation !== row.generation
    if (!failed) {
      if (current === undefined || !replaced) {
        this.statement('DELETE FROM effects WHERE id = ? AND generation = ?').run(row.id, row.generation)
      } else {
        // A newer payload was staged during this attempt: keep it and run again now.
        this.statement(
          `UPDATE effects SET state = 'waiting', attempts = 0, last_error = NULL, due_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(at, at, row.id)
      }
      return
    }
    if (replaced) {
      this.statement(
        `UPDATE effects SET state = 'waiting', attempts = 0, last_error = ?, due_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(describe(error), at, at, row.id)
      return
    }
    if (error instanceof Later) {
      this.statement(
        "UPDATE effects SET state = 'waiting', last_error = NULL, due_at = ?, updated_at = ? WHERE id = ?",
      ).run(at + LATER_DELAY_MS, at, row.id)
      return
    }
    const attempts = row.attempts + 1
    if (attempts >= handler.maxAttempts) {
      this.statement(
        "UPDATE effects SET state = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
      ).run(attempts, describe(error), at, row.id)
      return
    }
    const delay = Math.min(MAX_BACKOFF_MS, handler.baseDelayMs * 2 ** (attempts - 1))
    const jitter = Math.floor(this.random() * Math.min(1000, delay * 0.1))
    this.statement(
      `UPDATE effects SET state = 'waiting', attempts = ?, last_error = ?, due_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(attempts, describe(error), at + delay + jitter, at, row.id)
  }

  private kick(): void {
    if (!this.started || this.stopped || this.pumpScheduled) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      if (!this.started || this.stopped) return
      this.dispatch()
      this.scheduleTimer()
    })
  }

  /** Wake up when the next row of a registered kind becomes due. */
  private scheduleTimer(): void {
    this.clearTimer()
    if (!this.started || this.stopped) return
    const kinds = [...this.handlers.keys()]
    if (kinds.length === 0) return
    const placeholders = kinds.map(() => '?').join(', ')
    const found = this.statement(
      `SELECT MIN(due_at) AS due FROM effects WHERE state = 'waiting' AND kind IN (${placeholders})`,
    ).get(...kinds)
    const due = found?.['due'] === null || found?.['due'] === undefined ? null : Number(found['due'])
    if (due === null) return
    const delay = due - this.now()
    // A due row that dispatch could not start is blocked on an in-flight
    // attempt, whose completion reschedules; a timer here would spin.
    if (delay <= 0) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        if (!this.started || this.stopped) return
        this.dispatch()
        this.scheduleTimer()
      },
      Math.min(delay, 2 ** 31 - 1),
    )
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private parsePayload(row: EffectRow): unknown {
    try {
      return JSON.parse(row.payloadJson) as unknown
    } catch {
      throw new Error(`Effect ${row.id} has an unreadable payload`)
    }
  }

  private select(sql: string, ...parameters: (string | number)[]): EffectRow[] {
    return this.statement(sql)
      .all(...parameters)
      .map((row) => toRow(row))
  }

  private row(id: string): EffectRow | undefined {
    const found = this.statement(`SELECT ${COLUMNS} FROM effects WHERE id = ?`).get(id)
    return found === undefined ? undefined : toRow(found)
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

function toRow(row: Record<string, unknown>): EffectRow {
  return {
    id: String(row['id']),
    kind: String(row['kind']),
    key: String(row['key']),
    payloadJson: String(row['payload_json']),
    state: String(row['state']) as EffectState,
    attempts: Number(row['attempts']),
    dueAt: Number(row['due_at']),
    lastError: row['last_error'] === null || row['last_error'] === undefined ? null : String(row['last_error']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    generation: Number(row['generation']),
  }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 1000)
}

/** Public view of one row, decoding the payload column into `payload`. */
function effectRecord(row: EffectRow): EffectRecord {
  const record: EffectRecord = {
    id: row.id,
    kind: row.kind,
    key: row.key,
    state: row.state,
    attempts: row.attempts,
    dueAt: row.dueAt,
    lastError: row.lastError,
    payload: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    generation: row.generation,
  }
  try {
    return Object.assign({}, record, { payload: JSON.parse(row.payloadJson) as unknown })
  } catch {
    return record
  }
}
