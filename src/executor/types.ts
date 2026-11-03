/**
 * Contracts of the task executor and the reply model adapter.
 *
 * Two ports keep this layer testable without a running DSH host:
 *
 * - `SessionHost` owns every DSH API call (sessions, workspaces, permissions,
 *   durable delivery, turn boundaries and cancellation). Production uses
 *   `DshSessionHost`; tests use an in-memory fake.
 * - `TaskExecutor` is the surface the app layer calls; it never creates a
 *   session for an unapproved task and reports exactly one ending per start.
 *
 * The model and retrieval ports are *not* redeclared here: `ModelPort` and
 * `ResearchPort` come from `src/brain/types.ts` so the brain can be wired to a
 * DSH session without an adapter type of its own.
 */
import type { Approval, AssignmentOutcome, Task } from '../core/model.ts'
import type { PermissionPreset } from '../shared/limits.ts'
import type { ModelRoute, Settings } from '../shared/settings.ts'

/** Preset ids declared by this bundle in `cordis.patch.yml`. */
export const WORKER_PRESET = 'dsh-whale-chan-worker'
export const REPLIER_PRESET = 'dsh-whale-chan-replier'

/** Source kind stamped on every message this plugin delivers into a session. */
export const DELIVERY_SOURCE = 'dsh-whale-chan' as const

/** Characters an assignment id may contribute to a session id. */
const SESSION_ID_SAFE = /[^A-Za-z0-9_-]/g

/**
 * Session id of the worker that runs one assignment of `taskId`.
 *
 * The last eight characters of the assignment id make a retry a *new* session:
 * the domain treats a retry as a new assignment, so the worker must not resume
 * the conversation of the attempt that failed. The id stays deterministic, so a
 * cancel can address the session before it exists.
 */
export function taskSessionId(taskId: string, assignmentId?: string | null): string {
  const cleaned = (assignmentId ?? '').replace(SESSION_ID_SAFE, '')
  const suffix = cleaned.length === 0 ? 'initial' : cleaned.slice(-8)
  return `whale-task-${taskId}-${suffix}`
}

/**
 * Session id of the replier that serves one conversation thread.
 *
 * `digest` is the first 12 hex characters of the SHA-1 of the thread key (see
 * `threadDigest` in `model.ts`), so a conversation title never becomes a path
 * or a session id.
 */
export function replySessionId(digest: string): string {
  return `whale-reply-${digest}`
}

/** Prefix of the ids delivered into a session, which makes repeated delivery of one request id a no-op. */
export const DELIVERY_ID_PREFIX = `${DELIVERY_SOURCE}:`

/** What one execution produced. `outcome` uses the domain's assignment vocabulary. */
export type ExecutorOutcome = Extract<AssignmentOutcome, 'succeeded' | 'failed' | 'timeout' | 'cancelled'>

/** One approved task asked to run. */
export interface ExecutorRequest {
  readonly task: Task
  readonly approval: Approval
  readonly settings: Settings
  /**
   * The directory the approving person chose (`Assignment.workspace`).
   *
   * It wins over `tasks.workspaceRoot`: a person who approved a task into a
   * directory expects the worker to run there, and the setting is only the
   * default for approvals that name none. `~` is expanded; a relative path is
   * refused rather than resolved against the host's working directory.
   */
  readonly workspace?: string
  /** Caller lifetime; aborting it cancels the run and its session turn. */
  readonly signal: AbortSignal
}

/** The result the app layer maps onto `assignmentEnded`. */
export interface ExecutorResult {
  readonly outcome: ExecutorOutcome
  /**
   * The worker's own final text, or the empty string when the session produced
   * none. It is never composed from anything else: an empty summary means the
   * worker said nothing, which is a fact the panel must be able to show.
   */
  readonly summary: string
  readonly sessionId: string
  /** Stable machine-readable failure, when there is one. */
  readonly error?: string
}

/** A live session this executor works with. */
export interface SessionRef {
  /** The session the host actually uses; a rebuild may return a different id than requested. */
  readonly sessionId: string
  readonly workspace: string
}

export interface EnsureSessionOptions {
  /** Requested identity; the host may mint another one when it cannot reuse this. */
  readonly sessionId: string
  /** Directory the session owns; created before the session is. */
  readonly workspace: string
  readonly title: string
  readonly preset: string
  readonly permission: PermissionPreset
  /**
   * System prompt registered for this session, when the caller supplies one.
   * An existing session keeps the prompt it was created with.
   */
  readonly systemPrompt?: string
  /**
   * Route from `settings.models`, seeded onto a brand-new session.
   *
   * An empty or half-configured route leaves the deployment default in place;
   * an existing session keeps the selection it already recorded.
   */
  readonly model?: ModelRoute
  /** Abandon the current session of this identity and build a fresh one. */
  readonly fresh?: boolean
  readonly signal: AbortSignal
}

/** Where a delivered message enters the agent loop. */
export type DeliveryMode = 'queue' | 'steer'

export interface DeliverOptions {
  /** Stable idempotency key: the same `requestId` never enters one session twice. */
  readonly requestId: string
  readonly text: string
  /** `queue` opens a new turn (default); `steer` joins the turn already running. */
  readonly mode?: DeliveryMode
}

/** Why the wait for a turn end finished. */
export type TurnEndStatus = 'completed' | 'timeout' | 'aborted' | 'failed'

export interface TurnEndOutcome {
  readonly status: TurnEndStatus
  /** DSH's own reason for the turn's end, when it reported one. */
  readonly detail?: string
}

export interface AwaitTurnOptions {
  readonly timeoutMs: number
  readonly signal: AbortSignal
  /**
   * Message whose turn to wait for. When omitted the host waits for the next
   * turn boundary after the caller's call, which is what a `steer` delivery
   * into a running turn needs.
   */
  readonly requestId?: string
}

/** The worker's final assistant text, and whether the session had one at all. */
export interface FinalText {
  readonly text: string
  readonly found: boolean
}

/**
 * Every DSH call the executor needs, behind one seam.
 *
 * The host holds no cross-task session state: each method is addressed by an
 * explicit `SessionRef`, so two concurrent tasks cannot read each other's
 * deliveries or turn boundaries.
 */
export interface SessionHost {
  ensureSession(options: EnsureSessionOptions): Promise<SessionRef>
  deliver(ref: SessionRef, options: DeliverOptions): Promise<void>
  awaitTurnEnd(ref: SessionRef, options: AwaitTurnOptions): Promise<TurnEndOutcome>
  readFinalText(ref: SessionRef): Promise<FinalText>
  /** Abort the active turn and clear queued work. Safe to call repeatedly, and on an idle session. */
  cancel(ref: SessionRef, reason?: string): Promise<void>
  dispose(): Promise<void>
}

/** A logger seam; messages are expected to be already redacted. */
export interface ExecutorLogger {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

/**
 * The surface the app layer drives.
 *
 * `onStarted` fires once the worker session exists (which is when the app
 * binds `assignmentStarted`), and `onFinished` fires exactly once per started
 * run. A run refused before its session exists throws instead of reporting an
 * ending, because the domain has nothing running to end.
 */
export interface TaskExecutor {
  execute(request: ExecutorRequest): Promise<ExecutorResult>
  /** Cancel one running task; returns whether it was running. Repeated cancels are no-ops. */
  cancel(taskId: string, reason?: string): Promise<boolean>
  onStarted?(taskId: string, sessionId: string): void
  onFinished?(taskId: string, result: ExecutorResult): void
}
