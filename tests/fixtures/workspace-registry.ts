/**
 * In-memory DSH workspace registry and session persistence doubles.
 *
 * Both app services (`ConversationSessions`, `SessionArchiveService`) are
 * written against structural ports, so these doubles satisfy the shipped
 * registry's contract without a Cordis context: path-keyed records, the
 * registry-global archive set, the archive outcomes (active / unknown / other)
 * and the header listing that finds sessions whose record was removed.
 *
 * The fake is deliberately honest about the two error *names* the services
 * branch on: DSH reports activity and absence as `WorkspaceActiveSessionError`
 * and `WorkspaceUnknownSessionError`, so the doubles keep those names instead
 * of a project-local enum the production code could not observe.
 */
import type { ArchiveWorkspaceRecord, SessionArchiveRegistryPort } from '../../src/app/session-archive.ts'
import type { SessionRecoveryRegistryPort, SessionWorkspaceRecord } from '../../src/app/session-recovery.ts'

/** The error `WorkspaceRegistry.archiveSession` throws for an active session. */
export class FakeActiveSessionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly activity: readonly unknown[],
  ) {
    super(`session ${sessionId} is active`)
    this.name = 'WorkspaceActiveSessionError'
  }
}

/** The error `WorkspaceRegistry.archiveSession` throws for a session it cannot find. */
export class FakeUnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} is unknown`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/** One fake registry record. */
export interface FakeWorkspaceRecord extends SessionWorkspaceRecord {
  readonly path: string
  title: string
  /** Replace the title; the preflight must never call this. */
  setTitle(title: string): Promise<void>
  /** Sessions this record accepted through `attachSession`, in call order. */
  readonly attached: string[]
  /** When set, `attachSession` throws it instead of recording. */
  attachError: Error | undefined
  /** How many times `setTitle` was called; a preflight must never call it. */
  setTitleCalls: number
}

function makeRecord(path: string, title: string): FakeWorkspaceRecord {
  const record: FakeWorkspaceRecord = {
    path,
    title,
    attached: [],
    attachError: undefined,
    setTitleCalls: 0,
    async attachSession(sessionId: string): Promise<void> {
      if (record.attachError !== undefined) throw record.attachError
      record.attached.push(sessionId)
    },
    async setTitle(next: string): Promise<void> {
      record.setTitleCalls += 1
      record.title = next
    },
  }
  return record
}

/** In-memory `ctx.workspaceRegistry` for the recovery and archive services. */
export class FakeWorkspaceRegistry implements SessionRecoveryRegistryPort, SessionArchiveRegistryPort {
  /** Records by path, exactly as `resolveByPath` looks them up. */
  readonly records = new Map<string, FakeWorkspaceRecord>()
  /** Session ids in the registry-global archive set, in archive order. */
  readonly archived = new Set<string>()
  /** Every `archiveSession` call, in order, including calls that threw. */
  readonly archiveCalls: Array<{ sessionId: string; stopActivity: boolean | undefined }> = []
  readonly createCalls: Array<{ path: string; title: string | undefined }> = []
  readonly resolveCalls: string[] = []
  /** How many times `list()` was called. */
  listCalls = 0
  /** Sessions the fake treats as existing; only consulted when `strictUnknown` is on. */
  readonly known = new Set<string>()
  /** Active sessions and the activity list the host would report. */
  readonly active = new Map<string, readonly unknown[]>()
  /** Per-session archive failures, thrown as-is. */
  readonly failures = new Map<string, Error>()
  /** When true, archiving an id outside `known` reports `WorkspaceUnknownSessionError`. */
  strictUnknown = false
  /** When set, `list` throws it. */
  listError: Error | undefined
  /** When set, every record created afterwards refuses `attachSession` with it. */
  attachErrorForNew: Error | undefined
  /** Paths whose `resolveByPath` throws, to exercise a failing registry. */
  readonly resolveErrors = new Map<string, Error>()
  /** Accounted session ids per record path; this is what `list` projects. */
  private readonly sessions = new Map<string, Set<string>>()

  /** Create one record that owns `sessionIds`. */
  seed(path: string, title: string, sessionIds: readonly string[] = []): FakeWorkspaceRecord {
    const record = makeRecord(path, title)
    this.records.set(path, record)
    for (const sessionId of sessionIds) this.own(path, sessionId)
    return record
  }

  /** Account one session to a record path (and treat it as an existing session). */
  own(path: string, sessionId: string): void {
    this.known.add(sessionId)
    const current = this.sessions.get(path) ?? new Set<string>()
    current.add(sessionId)
    this.sessions.set(path, current)
  }

  get archivedSessionIds(): readonly string[] {
    return [...this.archived]
  }

  list(): readonly ArchiveWorkspaceRecord[] {
    this.listCalls += 1
    if (this.listError !== undefined) throw this.listError
    return [...this.records.values()].map((record) => ({
      path: record.path,
      sessionIds: [...(this.sessions.get(record.path) ?? [])],
    }))
  }

  async resolveByPath(path: string): Promise<FakeWorkspaceRecord | undefined> {
    this.resolveCalls.push(path)
    const error = this.resolveErrors.get(path)
    if (error !== undefined) throw error
    return this.records.get(path)
  }

  async create(path: string, title?: string): Promise<FakeWorkspaceRecord> {
    this.createCalls.push({ path, title })
    const existing = this.records.get(path)
    if (existing !== undefined) return existing
    const record = makeRecord(path, title ?? path)
    record.attachError = this.attachErrorForNew
    this.records.set(path, record)
    return record
  }

  async archiveSession(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void> {
    this.archiveCalls.push({ sessionId, stopActivity: options?.stopActivity })
    if (this.archived.has(sessionId)) return
    const failure = this.failures.get(sessionId)
    if (failure !== undefined) throw failure
    const activity = this.active.get(sessionId)
    if (activity !== undefined) throw new FakeActiveSessionError(sessionId, activity)
    if (this.strictUnknown && !this.known.has(sessionId)) throw new FakeUnknownSessionError(sessionId)
    this.archived.add(sessionId)
  }
}

/** One stored session header. */
export interface FakeStoredSession {
  readonly header: { readonly id: string; readonly cwd?: string }
}

/** In-memory `ctx.sessionPersistence` listing. */
export class FakeSessionPersistence {
  snapshots: FakeStoredSession[] = []
  listCalls = 0
  error: Error | undefined
  /**
   * Sessions this listing knows are also known to the registry in production.
   * A harness wires it to the fake registry's `known` set so a session found
   * through its stored header can be archived instead of reported unknown.
   */
  known: Set<string> | undefined

  async list(): Promise<readonly FakeStoredSession[]> {
    this.listCalls += 1
    if (this.error !== undefined) throw this.error
    return this.snapshots
  }

  /** Record one stored session header. */
  add(id: string, cwd?: string): void {
    this.snapshots.push({ header: cwd === undefined ? { id } : { id, cwd } })
    this.known?.add(id)
  }
}
