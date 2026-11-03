/**
 * Typed key-value records stored in the same SQLite database as the domain.
 *
 * The table is generic on purpose: each later workstream registers the keys it
 * owns with `record` or `family`, so a key is spelled once and its value type is
 * checked at the call site. A value that no longer parses raises
 * `StoreCorruptionError` through the shared JSON reader.
 */
import type { StatementSync } from 'node:sqlite'
import type { Store } from './store.ts'
import { decodeJson, StoreCorruptionError } from './store-read.ts'

/** A KV key carrying its value type; the brand exists only at compile time. */
export type Key<V> = string & { readonly __value?: V }

/** Declare one typed key. */
export function record<V>(key: string): Key<V> {
  return key as Key<V>
}

/** Declare a family of typed keys sharing a prefix. */
export function family<V, A extends unknown[] = [string]>(
  prefix: string,
  format: (...name: A) => string = (...name: A) => name.join(':'),
): ((...name: A) => Key<V>) & { readonly prefix: string } {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

/** Durable key-value access over the store's `kv` table. */
export class Kv {
  private readonly statements = new Map<string, StatementSync>()

  constructor(private readonly store: Store) {}

  get<V>(key: Key<V> | string): V | undefined {
    const row = this.statement('SELECT v_json FROM kv WHERE k = ?').get(key)
    if (row === undefined) return undefined
    return decodeJson<V>('kv', 'v_json', String(key), row['v_json'])
  }

  set<V>(key: Key<V> | string, value: V): void {
    this.statement(
      'INSERT INTO kv (k, v_json) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v_json = excluded.v_json',
    ).run(key, JSON.stringify(value))
  }

  delete(key: Key<unknown> | string): boolean {
    return Number(this.statement('DELETE FROM kv WHERE k = ?').run(key).changes) > 0
  }

  /** Keys starting with `prefix`, in lexical order. */
  keys(prefix = ''): string[] {
    const pattern = `${prefix.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
    return this.statement("SELECT k FROM kv WHERE k LIKE ? ESCAPE '\\' ORDER BY k")
      .all(pattern)
      .map((row) => String(row['k']))
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

export { StoreCorruptionError }
