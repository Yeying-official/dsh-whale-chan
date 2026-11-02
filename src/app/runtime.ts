/**
 * Minimal host runtime for WS0: resolve a private state directory, create it,
 * expose readiness, and release it on unload.
 *
 * No monitor, channel, database, lock or network client is started in this
 * workstream. Later work extends this class behind the same `ready`/`stop`
 * lifecycle instead of adding work to the plugin entry.
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { PLUGIN_NAME, PLUGIN_VERSION, type LogLevel } from '../shared/limits.ts'
import type { DeploymentConfig } from './deployment.ts'

/** Expand a leading `~` and return an absolute state-directory path. */
export function resolveStateDir(raw: string, home = homedir()): string {
  const value = raw.trim()
  if (!value) throw new Error('stateDir must not be empty')
  if (value === '~') return resolve(home)
  // Match exactly one separator after `~`: `~/x` and the Windows form.
  // `String.fromCharCode(92)` is one backslash, with no escape ambiguity.
  const homePrefixes = ['~/', `~${String.fromCharCode(92)}`] as const
  if (homePrefixes.some((prefix) => value.startsWith(prefix))) {
    return resolve(join(home, value.slice(2)))
  }
  if (!isAbsolute(value)) throw new Error('stateDir must be an absolute path or start with ~')
  return resolve(value)
}

export interface RuntimeInfo {
  readonly name: string
  readonly version: string
  readonly stateDir: string
  readonly startedAt: string
}

export interface RuntimeOptions {
  /** Clock seam for tests; production uses the wall clock. */
  readonly now?: () => Date
}

export class Runtime {
  readonly name = PLUGIN_NAME
  readonly version = PLUGIN_VERSION
  readonly stateDir: string
  readonly startedAt: string
  readonly logLevel: LogLevel
  readonly ready: Promise<void>
  private closing = false
  private stopping: Promise<void> | undefined

  constructor(config: DeploymentConfig, options: RuntimeOptions = {}) {
    this.stateDir = resolveStateDir(config.stateDir)
    this.logLevel = config.logLevel
    this.startedAt = (options.now?.() ?? new Date()).toISOString()
    this.ready = this.prepare()
  }

  private async prepare(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    if (this.closing) return
  }

  info(): RuntimeInfo {
    return {
      name: this.name,
      version: this.version,
      stateDir: this.stateDir,
      startedAt: this.startedAt,
    }
  }

  get closed(): boolean {
    return this.closing
  }

  /**
   * Mark the runtime closed and wait for startup to settle.
   *
   * Startup errors are intentionally swallowed here: the caller that awaited
   * `ready` already reports them, and unload must not fail because a directory
   * could not be created.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.closing = true
    this.stopping = this.ready.then(
      () => undefined,
      () => undefined,
    )
    return this.stopping
  }
}
