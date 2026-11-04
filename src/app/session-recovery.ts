/**
 * Replier session generations of one conversation.
 *
 * The app layer owns two facts the pure identity rules cannot:
 *
 * 1. **Which generation is current.** It is durable (`kv`), so a restart does
 *    not silently resume a session the owner archived, and it is written only
 *    when the current session is actually in the host's archive set.
 * 2. **Which workspace record the session belongs to.** The directory is
 *    derived from the thread key, but DSH owns the registry record. When the
 *    owner removes that record in DSH the directory may still exist; the next
 *    message then recreates the record, re-attaches the still-valid session
 *    when the host accepts it, and otherwise starts a new generation.
 *
 * Every decision that reads and writes the generation of one conversation runs
 * behind `runExclusive(threadKey, ...)`. The archive service uses the same
 * chain, so "archive the current session and rotate it" can never interleave
 * with a message preflight that still resolves the pre-archive generation.
 *
 * Nothing here deletes a directory, a session log or a registry record: the
 * owner's history is data, and an archived session stays where it is.
 */
import { mkdir } from 'node:fs/promises'
import { replySessionIdForGeneration } from '../executor/reply-session.ts'
import { record, type Key, type Kv } from './kv.ts'

/** KV key prefix of one conversation's replier generation. */
export const REPLY_GENERATION_PREFIX = 'session.reply-generation:'

/** KV key prefix of one worker session id's generation. */
export const WORKER_GENERATION_PREFIX = 'session.worker-generation:'

/** Upper bound of generations one preflight may skip before giving up. */
export const MAX_GENERATION_STEPS = 32

/** Directory mode of a conversation workspace; private to the owner. */
export const WORKSPACE_DIRECTORY_MODE = 0o700

/** Stored value of one generation key. */
export interface ReplyGenerationRecord {
  readonly generation: number
}

/** Options passed to the directory seam; the production call is `mkdir`'s own. */
export interface WorkspaceDirectoryOptions {
  readonly recursive: true
  readonly mode: number
}

/** The minimum of a DSH `Workspace` record this service writes to. */
export interface SessionWorkspaceRecord {
  readonly path: string
  readonly title: string
  /** Present on the host record; the preflight itself never renames a record. */
  setTitle(title: string): Promise<void>
  /** Optional so a minimal test double (and a registry without the method) degrades instead of throwing. */
  attachSession?(sessionId: string): Promise<void>
}

/**
 * The subset of `ctx.workspaceRegistry` this service depends on.
 *
 * Method syntax is deliberate: the host's parameters are branded
 * (`SessionId`, `WorkspaceId`), and a method signature keeps those arguments
 * bivariant so the shipped registry satisfies this port structurally.
 */
export interface SessionRecoveryRegistryPort {
  resolveByPath(path: string): Promise<SessionWorkspaceRecord | undefined>
  create(path: string, title?: string): Promise<SessionWorkspaceRecord>
  readonly archivedSessionIds: readonly string[]
}

/** The one workspace rule this service reuses from the app layer. */
export interface ThreadWorkspaceResolver {
  resolveThreadWorkspace(threadKey: string, title?: string): { readonly path: string; readonly title: string }
}

/** Logging seam; a missing method means no logging. */
export interface SessionRecoveryLogger {
  debug?(message: string): void
  warn?(message: string): void
}

export interface ConversationSessionsOptions {
  readonly workspaces: ThreadWorkspaceResolver
  readonly kv: Kv
  /** DSH registry; absent on an API-only runtime, where the preflight degrades to generation 0. */
  readonly registry?: SessionRecoveryRegistryPort
  readonly logger?: SessionRecoveryLogger
  /** Creates one directory recursively; replaced by tests so the options can be asserted. */
  readonly makeDirectory?: (path: string, options: WorkspaceDirectoryOptions) => Promise<unknown>
}

/** What one reply preflight resolved. */
export interface PreparedReplySession {
  readonly sessionId: string
  readonly workspace: { readonly path: string; readonly title: string }
  readonly generation: number
  /** Whether this call moved to a later generation (archived session, or an unattachable one). */
  readonly rotated: boolean
  /** Whether the workspace record was created by this call. */
  readonly workspaceRecreated: boolean
  /** Whether the still-valid old session was attached to the recreated record. */
  readonly attached: boolean
}

function generationKey(threadKey: string): Key<ReplyGenerationRecord> {
  return record<ReplyGenerationRecord>(`${REPLY_GENERATION_PREFIX}${threadKey}`)
}

function workerGenerationKey(baseSessionId: string): Key<ReplyGenerationRecord> {
  return record<ReplyGenerationRecord>(`${WORKER_GENERATION_PREFIX}${baseSessionId}`)
}

/**
 * Session id of one task's worker at a rotation generation.
 *
 * Generation 0 is the historical `taskSessionId` value, so a task that never
 * had its session archived keeps resuming the same worker session (a retry uses
 * a new assignment and therefore a new base id anyway). A later generation
 * appends `-g<n>`, which is a different session and leaves the archived one
 * alone.
 */
export function workerSessionIdForGeneration(baseSessionId: string, generation: number): string {
  const safe = Number.isFinite(generation) ? Math.max(0, Math.trunc(generation)) : 0
  return safe === 0 ? baseSessionId : `${baseSessionId}-g${safe}`
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300)
  return String(error).slice(0, 300)
}

/**
 * Durable replier generations and workspace records of every conversation.
 *
 * The class holds no session: it resolves identities and keeps the one lock
 * per conversation that the replier and the archive command share.
 */
export class ConversationSessions {
  private readonly workspaces: ThreadWorkspaceResolver
  private readonly kv: Kv
  private readonly registry: SessionRecoveryRegistryPort | undefined
  private readonly logger: SessionRecoveryLogger | undefined
  private readonly makeDirectory: (path: string, options: WorkspaceDirectoryOptions) => Promise<unknown>
  /** Tail of the per-conversation mutex; every generation decision chains onto it. */
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(options: ConversationSessionsOptions) {
    this.workspaces = options.workspaces
    this.kv = options.kv
    this.registry = options.registry
    this.logger = options.logger
    this.makeDirectory =
      options.makeDirectory ??
      (async (path: string, directoryOptions: WorkspaceDirectoryOptions): Promise<unknown> => {
        return await mkdir(path, directoryOptions)
      })
  }

  /**
   * Serialize one unit of work per conversation.
   *
   * The replier preflight and the archive command both call this with the same
   * `threadKey`, so an archive can never be observed half-applied by a message
   * that is about to deliver into the session being archived. Calls for other
   * conversations are independent.
   */
  async runExclusive<T>(threadKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(threadKey) ?? Promise.resolve()
    const current = previous.then(work, work)
    const settled = current.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(threadKey, settled)
    void settled.then(() => {
      if (this.chains.get(threadKey) === settled) this.chains.delete(threadKey)
    })
    return await current
  }

  /**
   * Make sure one conversation workspace exists as a directory and a registry
   * record.
   *
   * An existing record is reused exactly as it is: a task joining the shared
   * workspace, and the replier preflight that runs on every turn, must never
   * rename it. Only a missing record is created, with `title` as its initial
   * name; `WorkspaceService.provisionTargets` remains the owner of title
   * corrections.
   */
  async ensureWorkspace(path: string, title: string): Promise<{ created: boolean }> {
    const ensured = await this.ensureRecord(path, title)
    return { created: ensured.created }
  }

  /**
   * Resolve the replier session the next turn of `threadKey` must use.
   *
   * `currentSessionId` is the session the caller has cached. It is only
   * consulted when this call created the workspace record: the host can attach
   * a session only when its header cwd still resolves to that directory, and a
   * failed attach means the old session can never appear under the recreated
   * record. In that case the generation advances, so the next turn builds a new
   * session inside the new record instead of resuming an invisible one.
   */
  async prepareReply(threadKey: string, title: string, currentSessionId?: string): Promise<PreparedReplySession> {
    return await this.runExclusive(
      threadKey,
      async () => await this.prepareReplyUnlocked(threadKey, title, currentSessionId),
    )
  }

  /** The session id the current generation names; read-only. */
  currentReplySessionId(threadKey: string): string {
    return replySessionIdForGeneration(threadKey, this.readGeneration(threadKey))
  }

  /**
   * Advance the generation durably and return the new session id.
   *
   * Callers that also archive must run this inside `runExclusive(threadKey,
   * ...)`; the archive service does. This method does not take the lock itself
   * so it can be composed into one atomic archive-and-rotate unit.
   */
  rotateReplySession(threadKey: string): string {
    const next = this.readGeneration(threadKey) + 1
    this.writeGeneration(threadKey, next)
    return replySessionIdForGeneration(threadKey, next)
  }

  /**
   * The worker session id one task run must use.
   *
   * A retry creates a new assignment and therefore a new base id, but an
   * *archived* worker session would be blocked by the host's archive gate if the
   * same base id were requested again (for example a task re-run after the
   * owner archived its workspace sessions). The generation is durable, so a
   * restart keeps resolving the same new session.
   */
  async ensureWorkerSessionId(baseSessionId: string): Promise<string> {
    const registry = this.registry
    if (registry === undefined) return baseSessionId
    const key = workerGenerationKey(baseSessionId)
    const stored = this.readGenerationRecord(key)
    let generation = stored
    let sessionId = workerSessionIdForGeneration(baseSessionId, generation)
    let archived: ReadonlySet<string>
    try {
      archived = new Set<string>(registry.archivedSessionIds.map((id) => String(id)))
    } catch (error) {
      this.logger?.warn?.(`dsh-whale-chan: could not read the archive set for ${baseSessionId}: ${describe(error)}`)
      return sessionId
    }
    for (let step = 0; archived.has(sessionId) && step < MAX_GENERATION_STEPS; step += 1) {
      generation += 1
      sessionId = workerSessionIdForGeneration(baseSessionId, generation)
    }
    if (generation !== stored) this.writeGenerationRecord(key, generation)
    return sessionId
  }

  private async prepareReplyUnlocked(
    threadKey: string,
    title: string,
    currentSessionId?: string,
  ): Promise<PreparedReplySession> {
    const workspace = this.workspaces.resolveThreadWorkspace(threadKey, title)
    const registry = this.registry
    if (registry === undefined) {
      // No host: no session can be created, so identity is the only thing this
      // call can promise. Never throw from a preflight the replier depends on.
      return {
        sessionId: replySessionIdForGeneration(threadKey, 0),
        workspace,
        generation: 0,
        rotated: false,
        workspaceRecreated: false,
        attached: false,
      }
    }

    const storedGeneration = this.readGeneration(threadKey)
    let ensured: { created: boolean; record?: SessionWorkspaceRecord }
    try {
      ensured = await this.ensureRecord(workspace.path, workspace.title)
    } catch (error) {
      // A preflight is a best-effort improvement, not a new failure mode for
      // every reply: a broken registry must not stop a conversation that was
      // already working. The cached session keeps serving, and an archived
      // current id still rotates because that check only needs the archive set.
      this.logger?.warn?.(
        `dsh-whale-chan: the workspace preflight of ${threadKey} failed; keeping its current replier generation: ${describe(error)}`,
      )
      return this.fallbackReply(threadKey, workspace, storedGeneration, registry)
    }

    const explicit = (currentSessionId ?? '').trim()
    // A caller with no cached session (first message after a restart) still
    // has a candidate: the session its stored generation names. Attaching it
    // to a recreated record preserves the conversation context when it exists.
    const candidate = explicit.length > 0 ? explicit : replySessionIdForGeneration(threadKey, storedGeneration)
    let generation = storedGeneration
    let attached = false

    if (ensured.created && ensured.record?.attachSession !== undefined) {
      try {
        await ensured.record.attachSession(candidate)
        attached = true
      } catch (error) {
        if (explicit.length > 0) {
          // The new record cannot own the cached session. Fall forward to a new
          // generation so the reply keeps working; the old session log stays.
          this.logger?.warn?.(
            `dsh-whale-chan: could not attach session ${candidate} to the recreated workspace ${workspace.path}: ${describe(error)}`,
          )
          generation += 1
        } else {
          // The implicit candidate is only the id the current generation names.
          // If it does not exist yet, `ensureSession` creates it in the new
          // record; there is nothing to fall forward from.
          this.logger?.debug?.(
            `dsh-whale-chan: the recreated workspace of ${threadKey} does not own ${candidate} yet: ${describe(error)}`,
          )
        }
      }
    }

    const skipped = this.skipArchived(threadKey, generation, registry)
    generation = skipped.generation

    const rotated = generation !== storedGeneration
    if (rotated) this.writeGeneration(threadKey, generation)
    if (ensured.created) {
      this.logger?.debug?.(
        `dsh-whale-chan: recreated the workspace record of ${threadKey} at ${workspace.path}` +
          ` (attached: ${String(attached)}, generation: ${String(generation)})`,
      )
    }
    return {
      sessionId: skipped.sessionId,
      workspace,
      generation,
      rotated,
      workspaceRecreated: ensured.created,
      attached,
    }
  }

  /** Resolve a generation without touching the registry, for a failed preflight. */
  private fallbackReply(
    threadKey: string,
    workspace: { readonly path: string; readonly title: string },
    storedGeneration: number,
    registry: SessionRecoveryRegistryPort,
  ): PreparedReplySession {
    let skipped: { generation: number; sessionId: string }
    try {
      skipped = this.skipArchived(threadKey, storedGeneration, registry)
    } catch (error) {
      this.logger?.warn?.(`dsh-whale-chan: could not read the archive set of ${threadKey}: ${describe(error)}`)
      skipped = {
        generation: storedGeneration,
        sessionId: replySessionIdForGeneration(threadKey, storedGeneration),
      }
    }
    const rotated = skipped.generation !== storedGeneration
    if (rotated) this.writeGeneration(threadKey, skipped.generation)
    return {
      sessionId: skipped.sessionId,
      workspace,
      generation: skipped.generation,
      rotated,
      workspaceRecreated: false,
      attached: false,
    }
  }

  /** Advance past every archived generation, up to the documented bound. */
  private skipArchived(
    threadKey: string,
    generation: number,
    registry: SessionRecoveryRegistryPort,
  ): { generation: number; sessionId: string } {
    const archived = new Set<string>(registry.archivedSessionIds.map((id) => String(id)))
    let current = generation
    let sessionId = replySessionIdForGeneration(threadKey, current)
    for (let step = 0; archived.has(sessionId) && step < MAX_GENERATION_STEPS; step += 1) {
      current += 1
      sessionId = replySessionIdForGeneration(threadKey, current)
    }
    return { generation: current, sessionId }
  }

  /**
   * Make the directory and (when possible) the registry record of one
   * conversation workspace.
   *
   * A registry failure propagates: the caller then reports a failed reply or a
   * failed task instead of silently running somewhere DSH does not know.
   */
  private async ensureRecord(
    path: string,
    title: string,
  ): Promise<{ created: boolean; record?: SessionWorkspaceRecord }> {
    await this.makeDirectory(path, { recursive: true, mode: WORKSPACE_DIRECTORY_MODE })
    const registry = this.registry
    if (registry === undefined) return { created: false }
    const existing = await registry.resolveByPath(path)
    // Deliberately no setTitle: an existing record keeps the title its owner
    // gave it. The replier preflight runs on every turn and a task joins the
    // same record, so retitling here would make either of them the owner.
    if (existing !== undefined) return { created: false, record: existing }
    const created = await registry.create(path, title)
    return { created: true, record: created }
  }

  private readGeneration(threadKey: string): number {
    return this.readGenerationRecord(generationKey(threadKey))
  }

  private readGenerationRecord(key: Key<ReplyGenerationRecord>): number {
    const stored = this.kv.get<ReplyGenerationRecord>(key)
    const generation = stored?.generation
    return typeof generation === 'number' && Number.isInteger(generation) && generation >= 0 ? generation : 0
  }

  private writeGeneration(threadKey: string, generation: number): void {
    this.writeGenerationRecord(generationKey(threadKey), generation)
  }

  private writeGenerationRecord(key: Key<ReplyGenerationRecord>, generation: number): void {
    this.kv.set<ReplyGenerationRecord>(key, { generation })
  }
}
