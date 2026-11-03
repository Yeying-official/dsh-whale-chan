/**
 * Host runtime: one state directory, one database, one settings service.
 *
 * Startup is a single ordered sequence so a failure leaves nothing half-open:
 * create the directory, take the state-directory lock, open `state.db` and
 * apply the forward schema migration, then construct the settings service, the
 * domain engine and the effects queue. The channel, the effects dispatcher and
 * the executor are deliberately not started here; WS5b owns them.
 *
 * A second runtime pointed at the same directory fails with a clear lock error
 * instead of racing the first one. `stop()` releases the lock and closes the
 * database, and both `ready` and `stop()` are safe to call twice.
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import type { Clock } from '../core/index.ts'
import { Engine } from '../core/index.ts'
import { PLUGIN_NAME, PLUGIN_VERSION, type LogLevel } from '../shared/limits.ts'
import type { Health, StateView } from '../shared/models.ts'
import type { ChannelPort } from './channel-port.ts'
import type { DeploymentConfig } from './deployment.ts'
import { Effects } from './effects.ts'
import { SettingsService } from './settings.ts'
import { Store } from './store.ts'
import { healthView, stateView, type ViewContext } from './views.ts'

/** How long a lock left by a dead process is honoured before it is reclaimed. */
export const LOCK_STALE_MS = 10_000

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

/** Facts the health view reports about the open runtime. */
export interface RuntimeFacts {
  readonly stateDirWritable: boolean
  readonly lockHeld: boolean
  readonly databaseOpen: boolean
  readonly schemaVersion: number
}

export interface RuntimeOptions {
  /** Clock seam for tests; production uses the wall clock. */
  readonly now?: () => Date
  /** Channel adapter for `targets/discover|validate`; absent in WS5a. */
  readonly channel?: ChannelPort
}

async function writable(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export class Runtime {
  readonly name = PLUGIN_NAME
  readonly version = PLUGIN_VERSION
  readonly stateDir: string
  readonly startedAt: string
  readonly logLevel: LogLevel
  readonly ready: Promise<void>
  readonly channel: ChannelPort | undefined
  private readonly time: Clock
  private storeRef: Store | undefined
  private settingsRef: SettingsService | undefined
  private engineRef: Engine | undefined
  private effectsRef: Effects | undefined
  private releaseLock: (() => Promise<void>) | undefined
  private releasePromise: Promise<void> | undefined
  private lockCompromised = false
  private stateDirWritable = false
  private closing = false
  private stopping: Promise<void> | undefined

  constructor(config: DeploymentConfig, options: RuntimeOptions = {}) {
    this.stateDir = resolveStateDir(config.stateDir)
    this.logLevel = config.logLevel
    this.startedAt = (options.now?.() ?? new Date()).toISOString()
    const now = options.now ?? (() => new Date())
    this.time = { now: () => new Date(now()) }
    this.channel = options.channel
    this.ready = this.prepare()
  }

  /** The open state database; throws before `ready` has settled successfully. */
  get store(): Store {
    return this.require(this.storeRef, 'store')
  }

  /** The durable settings service; throws before `ready` has settled successfully. */
  get settings(): SettingsService {
    return this.require(this.settingsRef, 'settings')
  }

  /** The domain engine bound to the open database. */
  get engine(): Engine {
    return this.require(this.engineRef, 'engine')
  }

  /** The effects queue, constructed but not started. */
  get effects(): Effects {
    return this.require(this.effectsRef, 'effects')
  }

  /** Clock seam shared by settings, engine and effects. */
  get clock(): Clock {
    return this.time
  }

  info(): RuntimeInfo {
    return {
      name: this.name,
      version: this.version,
      stateDir: this.stateDir,
      startedAt: this.startedAt,
    }
  }

  /** Facts for the health view; safe to call before startup settles. */
  facts(): RuntimeFacts {
    return {
      stateDirWritable: this.stateDirWritable,
      lockHeld: this.releaseLock !== undefined && !this.lockCompromised,
      databaseOpen: this.storeRef !== undefined,
      schemaVersion: this.storeRef?.schemaVersion() ?? 0,
    }
  }

  /** The frozen `GET state` view. */
  state(): StateView {
    return stateView(this)
  }

  /** The frozen `GET health` view. */
  health(): Health {
    return healthView(this.viewContext())
  }

  /** Everything a view builder may read. */
  viewContext(): ViewContext {
    return {
      runtime: this,
      settings: this.settings,
      store: this.store,
      clock: this.time,
      effects: this.effects,
      channel: this.channel,
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
   * could not be created. A runtime stopped mid-startup releases whatever it
   * already opened.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.closing = true
    this.stopping = this.ready.then(
      () => this.releaseResources(),
      () => this.releaseResources(),
    )
    return this.stopping
  }

  private async prepare(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    this.stateDirWritable = await writable(this.stateDir)
    this.releaseLock = await this.acquireLock()
    try {
      const store = Store.open(this.stateDir)
      this.storeRef = store
      this.settingsRef = new SettingsService(store, this.time)
      this.engineRef = new Engine({
        repos: store,
        ids: { next: (prefix) => `${prefix}-${randomUUID()}` },
        clock: this.time,
        // The audit trail is the durable copy of every committed domain event.
        emit: (event) => store.appendEvent(event.type, event.at, event.data),
      })
      this.effectsRef = new Effects(store, { now: () => this.time.now().getTime() })
    } catch (error) {
      await this.releaseResources()
      throw error
    }
    if (this.closing) await this.releaseResources()
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    try {
      return await lock(this.stateDir, {
        lockfilePath: join(this.stateDir, '.lock'),
        stale: LOCK_STALE_MS,
        retries: 0,
        realpath: false,
        // A compromised lock must not crash the host; the health view reports it.
        onCompromised: () => {
          this.lockCompromised = true
        },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
        throw new Error(
          `The state directory is already in use by another process: ${this.stateDir}. ` +
            'Stop the other instance, or point this one at a different stateDir.',
        )
      }
      throw error
    }
  }

  private releaseResources(): Promise<void> {
    this.releasePromise ??= this.releaseNow()
    return this.releasePromise
  }

  private async releaseNow(): Promise<void> {
    const release = this.releaseLock
    this.releaseLock = undefined
    if (release) {
      try {
        await release()
      } catch {
        // The lock was already reclaimed as stale; nothing left to release.
      }
    }
    const store = this.storeRef
    this.storeRef = undefined
    this.settingsRef = undefined
    this.engineRef = undefined
    this.effectsRef = undefined
    if (store) {
      try {
        store.close()
      } catch {
        // Closing twice is harmless; the first close already flushed WAL.
      }
    }
  }

  private require<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new Error(`The runtime is not ready: ${name} is not open`)
    return value
  }
}
