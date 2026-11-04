/**
 * Archive every session of one target's conversation workspace.
 *
 * The owner can already archive one session in DSH. This command does the
 * target-wide version: it enumerates the sessions that belong to the
 * conversation's workspace, archives the inactive ones, reports the ones the
 * host refused because they are still running, and rotates the replier
 * generation when the current replier session ended up archived — so the next
 * DingTalk message opens a new session instead of being blocked by
 * `ArchivedSessionGate`.
 *
 * What it deliberately does not do:
 *
 * - **No directory deletion.** The workspace directory is the owner's data.
 * - **No unarchive.** A session this command archived stays archived.
 * - **No session-log deletion.** DSH owns the log; an archive only hides it.
 * - **No guessing about membership.** A session belongs to the workspace when
 *   its registry path or its stored header cwd names that directory. Titles and
 *   fuzzy name matches are never used.
 *
 * The whole pass runs behind the conversation's `ConversationSessions` mutex,
 * the same one the reply preflight uses. That is what makes "archive the current
 * replier, then rotate" atomic from a message's point of view: a message either
 * preflights before the archive (and its session is then archived and replaced)
 * or after it (and it already sees the new generation).
 */
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isSameWorkspacePath } from '../executor/workspace.ts'
import type {
  ArchiveTargetSessionsRequest,
  ArchiveTargetSessionsResult,
  ArchivedSessionActivity,
  FailedArchivedSession,
  RefusedArchivedSession,
} from '../shared/models.ts'
import type { Settings } from '../shared/settings.ts'
import type { ConversationSessions, ThreadWorkspaceResolver } from './session-recovery.ts'
import { targetThreadKey } from './workspaces.ts'

/** Upper bound of stored headers one pass reads; protects the route from a pathological store. */
export const MAX_ARCHIVE_CANDIDATES = 500

/** Stable refusal code of an archive command; the route maps each to one status. */
export type SessionArchiveRefusal = 'unknown_target' | 'per_conversation_workspace'

/** The target cannot be archived for a caller-correctable reason. */
export class SessionArchiveTargetError extends Error {
  constructor(
    readonly code: SessionArchiveRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'SessionArchiveTargetError'
  }
}

/** The DSH workspace registry is not attached, so no archive can be addressed. */
export class SessionArchiveUnavailableError extends Error {
  constructor() {
    super('The DSH workspace registry is not attached')
    this.name = 'SessionArchiveUnavailableError'
  }
}

/** The one workspace record shape this service reads. */
export interface ArchiveWorkspaceRecord {
  readonly path: string
  readonly sessionIds: readonly string[]
}

/**
 * The subset of `ctx.workspaceRegistry` this service depends on.
 *
 * Method syntax keeps the host's branded `SessionId` arguments bivariant, so the
 * shipped registry satisfies this port without importing its implementation.
 */
export interface SessionArchiveRegistryPort {
  list(): readonly ArchiveWorkspaceRecord[]
  readonly archivedSessionIds: readonly string[]
  archiveSession(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
}

/** One stored session header, as far as this command cares. */
export interface StoredSessionSnapshot {
  readonly header: { readonly id: string; readonly cwd?: string }
}

/** The subset of `ctx.sessionPersistence` this service reads. */
export interface SessionPersistencePort {
  list(): Promise<readonly StoredSessionSnapshot[]>
}

/** Durable audit sink; the store's `appendEvent` in production. */
export interface SessionArchiveAuditSink {
  appendEvent(type: string, at: string, data: unknown): void
}

/** Clock seam. */
export interface SessionArchiveClock {
  now(): Date
}

/** Logging seam; a missing method means no logging. */
export interface SessionArchiveLogger {
  debug?(message: string): void
  warn?(message: string): void
}

export interface SessionArchiveServiceOptions {
  /** Current settings; the target row is looked up here, never cached. */
  readonly settings: () => Settings
  readonly workspaces: ThreadWorkspaceResolver
  readonly sessions: ConversationSessions
  readonly store: SessionArchiveAuditSink
  readonly clock: SessionArchiveClock
  /** DSH registry; absent on an API-only runtime, where the command is unavailable. */
  readonly registry?: SessionArchiveRegistryPort
  /** Stored session headers, used to find sessions whose registry record was removed by hand. */
  readonly sessionPersistence?: SessionPersistencePort
  readonly logger?: SessionArchiveLogger
  /** `fs.realpath`; replaced by tests so path normalization is observable. */
  readonly realpath?: (path: string) => Promise<string>
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300)
  return String(error).slice(0, 300)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize the host's activity report into the wire shape.
 *
 * Activity families are declared by whichever providers are composed, so the
 * payload is untrusted: only a string `kind` and item ids/labels survive, and
 * anything else is dropped instead of leaking provider internals.
 */
export function normalizeSessionActivity(value: unknown): ArchivedSessionActivity[] {
  if (!Array.isArray(value)) return []
  const normalized: ArchivedSessionActivity[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['kind'] !== 'string') continue
    const kind = entry['kind']
    const rawItems = entry['items']
    if (!Array.isArray(rawItems)) {
      normalized.push({ kind })
      continue
    }
    const items = rawItems.flatMap((item) => {
      if (!isRecord(item) || typeof item['id'] !== 'string') return []
      const label = item['label']
      return [typeof label === 'string' ? { id: item['id'], label } : { id: item['id'] }]
    })
    normalized.push({ kind, items })
  }
  return normalized
}

/**
 * Target-wide session archiving for one conversation workspace.
 *
 * One instance serves the whole runtime; calls are serialized per conversation
 * by `ConversationSessions`, so two archive requests for the same target cannot
 * interleave their generation decisions.
 */
export class SessionArchiveService {
  private readonly settings: () => Settings
  private readonly workspaces: ThreadWorkspaceResolver
  private readonly sessions: ConversationSessions
  private readonly store: SessionArchiveAuditSink
  private readonly clock: SessionArchiveClock
  private readonly registry: SessionArchiveRegistryPort | undefined
  private readonly sessionPersistence: SessionPersistencePort | undefined
  private readonly logger: SessionArchiveLogger | undefined
  private readonly realpath: (path: string) => Promise<string>

  constructor(options: SessionArchiveServiceOptions) {
    this.settings = options.settings
    this.workspaces = options.workspaces
    this.sessions = options.sessions
    this.store = options.store
    this.clock = options.clock
    this.registry = options.registry
    this.sessionPersistence = options.sessionPersistence
    this.logger = options.logger
    this.realpath = options.realpath ?? (async (path: string): Promise<string> => await realpath(path))
  }

  /**
   * Archive every session of `targetId`'s conversation workspace.
   *
   * The target row decides the conversation; a global subscription (`at-me`,
   * `open:` dm) has no single workspace and is refused rather than guessed at.
   * The returned arrays partition the candidate set, and the replier rotation
   * decision is read back from the host's archive set after the loop.
   */
  async archiveTarget(
    targetId: string,
    options: ArchiveTargetSessionsRequest = {},
  ): Promise<ArchiveTargetSessionsResult> {
    const stopActivity = options.stopActivity === true
    const row = this.settings().targets.rows.find((target) => target.id === targetId)
    if (row === undefined) {
      throw new SessionArchiveTargetError('unknown_target', 'Unknown target')
    }
    const threadKey = targetThreadKey(row)
    if (threadKey === undefined) {
      throw new SessionArchiveTargetError(
        'per_conversation_workspace',
        'This target has no single conversation workspace',
      )
    }
    const registry = this.registry
    if (registry === undefined) throw new SessionArchiveUnavailableError()
    const workspace = this.workspaces.resolveThreadWorkspace(threadKey, row.label)

    return await this.sessions.runExclusive(threadKey, async () => {
      const cache = new Map<string, string>()
      const targetPath = await this.canonical(workspace.path, cache)
      const candidates = await this.collectCandidates(registry, targetPath, threadKey, cache)

      const alreadyArchivedSet = new Set<string>(registry.archivedSessionIds.map((id) => String(id)))
      const alreadyArchived: string[] = []
      const pending: string[] = []
      for (const sessionId of candidates.ids) {
        if (alreadyArchivedSet.has(sessionId)) alreadyArchived.push(sessionId)
        else pending.push(sessionId)
      }

      const archived: string[] = []
      const refused: RefusedArchivedSession[] = []
      const missing: string[] = []
      const failed: FailedArchivedSession[] = []
      for (const sessionId of pending) {
        try {
          await registry.archiveSession(sessionId, { stopActivity })
          archived.push(sessionId)
        } catch (error) {
          const name = errorName(error)
          if (name === 'WorkspaceActiveSessionError') {
            refused.push({
              sessionId,
              activity: normalizeSessionActivity((error as { activity?: unknown }).activity),
            })
            continue
          }
          if (name === 'WorkspaceUnknownSessionError') {
            missing.push(sessionId)
            continue
          }
          // The internal message may name a path or a storage detail; it is
          // logged, never returned to the caller.
          failed.push({ sessionId, error: 'archive_failed' })
          this.logger?.warn?.(
            `dsh-whale-chan: archiving session ${sessionId} of ${threadKey} failed: ${describe(error)}`,
          )
        }
      }

      // Rotation trusts the host's archive set as it is *now*, not whether this
      // pass archived the current replier: an earlier pass, a manual archive in
      // DSH, or a concurrent archive all leave the same durable fact.
      const archivedNow = new Set<string>(registry.archivedSessionIds.map((id) => String(id)))
      const current = this.sessions.currentReplySessionId(threadKey)
      let replySessionRotated = false
      let nextReplySessionId = current
      if (archivedNow.has(current)) {
        nextReplySessionId = this.sessions.rotateReplySession(threadKey)
        replySessionRotated = true
      }

      this.store.appendEvent('workspace.sessions-archived', this.clock.now().toISOString(), {
        threadKey,
        targetId,
        archived: archived.length,
        refused: refused.length,
        failed: failed.length,
        missing: missing.length,
        stopActivity,
        replySessionRotated,
      })

      return {
        targetId,
        threadKey,
        workspace,
        archived,
        alreadyArchived,
        refused,
        missing,
        failed,
        replySessionRotated,
        nextReplySessionId,
        stopActivity,
        truncated: candidates.truncated,
        candidateCount: candidates.candidateCount,
      }
    })
  }

  /**
   * Every session that names the target workspace, deduplicated and sorted.
   *
   * Three sources, because any one of them can be incomplete: the registry
   * record (its account survives an archive), stored session headers (the
   * registry record may have been removed by hand in DSH), and the current
   * replier id (it may not have been created yet, and then the archive reports
   * it as missing).
   *
   * The result is capped so a pathological store cannot make one request read
   * an unbounded number of headers. The cap is applied after a stable sort, the
   * total is reported so the panel can say "only the first N", and the current
   * replier is never dropped: it decides the rotation.
   */
  private async collectCandidates(
    registry: SessionArchiveRegistryPort,
    targetPath: string,
    threadKey: string,
    cache: Map<string, string>,
  ): Promise<{ ids: string[]; truncated: boolean; candidateCount: number }> {
    const ids = new Set<string>()
    for (const record of registry.list()) {
      if (!(await this.matches(record.path, targetPath, cache))) continue
      for (const sessionId of record.sessionIds) ids.add(String(sessionId))
    }

    const persistence = this.sessionPersistence
    if (persistence !== undefined) {
      try {
        for (const snapshot of await persistence.list()) {
          const cwd = snapshot.header.cwd
          if (typeof cwd !== 'string' || cwd.trim().length === 0) continue
          if (!(await this.matches(cwd, targetPath, cache))) continue
          ids.add(String(snapshot.header.id))
        }
      } catch (error) {
        // The registry account still covers the sessions it knows about; a
        // storage fault must not turn a partial listing into a failed archive.
        this.logger?.warn?.(`dsh-whale-chan: listing stored sessions failed: ${describe(error)}`)
      }
    }

    const current = this.sessions.currentReplySessionId(threadKey)
    ids.add(current)
    const sorted = [...ids].sort()
    const candidateCount = sorted.length
    if (sorted.length <= MAX_ARCHIVE_CANDIDATES) return { ids: sorted, truncated: false, candidateCount }
    // The cap protects the route from a pathological store, but it must never
    // drop the current replier: that id is what decides the rotation below.
    const kept = sorted.slice(0, MAX_ARCHIVE_CANDIDATES)
    const capped = kept.includes(current) ? kept : [...sorted.slice(0, MAX_ARCHIVE_CANDIDATES - 1), current].sort()
    return { ids: capped, truncated: true, candidateCount }
  }

  /** Whether one stored path names the target workspace. */
  private async matches(candidate: string, targetPath: string, cache: Map<string, string>): Promise<boolean> {
    if (candidate.trim().length === 0) return false
    return isSameWorkspacePath(await this.canonical(candidate, cache), targetPath)
  }

  /**
   * Canonicalize one path for comparison.
   *
   * A workspace root reached through a symbolic link produces a different
   * spelling than the registry's `realpath`; the directory may also be gone, in
   * which case the resolved spelling is the best available identity. Results
   * are cached for one pass so repeated paths cost one `realpath` call.
   */
  private async canonical(path: string, cache: Map<string, string>): Promise<string> {
    const key = resolve(path)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    let value = key
    try {
      value = resolve(await this.realpath(key))
    } catch {
      value = key
    }
    cache.set(key, value)
    return value
  }
}
