/**
 * Browser-facing view models of the management API.
 *
 * These types describe wire values only. Host domain objects live in `src/core`;
 * the app layer maps one to the other. Keep this module free of Node and Zod
 * imports so the client bundle can import it safely.
 */
import type { PersonaSettings, SettingsBlock } from './settings.ts'
import type { PermissionPreset, ReplyMode, TargetKind } from './limits.ts'

export type HealthStatus = 'ok' | 'degraded' | 'error'

/**
 * The directory one target's conversations use.
 *
 * `ready` means one concrete directory exists (or is about to be provisioned)
 * for the target itself; `per-conversation` means the target is a global
 * subscription (`at-me`) or a send-only open id, so each conversation creates
 * its own workspace on its first message and there is no single path yet.
 */
export interface TargetWorkspace {
  readonly path: string | null
  readonly title: string
  readonly mode: 'ready' | 'per-conversation'
}

/** One configured channel target. */
export interface Target {
  readonly id: string
  readonly kind: TargetKind
  readonly label: string
  readonly enabled: boolean
  readonly mentionOnly: boolean
  readonly replyMode: ReplyMode
  /** Read-only workspace projection; the panel never edits it. */
  readonly workspace?: TargetWorkspace
  readonly discoveredAt?: string
  readonly validatedAt?: string
}

/** A target proposed by discovery, before the user saves it. */
export interface TargetCandidate {
  readonly kind: TargetKind
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** One target row submitted for validation. */
export interface TargetDraft {
  readonly kind: TargetKind
  readonly id: string
  readonly label?: string
}

/** Validation result for one target row. */
export interface TargetValidation {
  readonly target: TargetDraft
  readonly valid: boolean
  readonly error?: string
}

export interface TargetsView {
  readonly targets: readonly Target[]
  readonly supportedKinds: readonly TargetKind[]
}

export type ThreadKind = 'at-me' | 'group' | 'dm'

export interface ThreadSummary {
  readonly key: string
  readonly title: string
  readonly kind: ThreadKind
  readonly lastMessageAt: string
  readonly unreadCount: number
  readonly taskId: string | null
}

export interface MessageView {
  readonly id: string
  readonly threadKey: string
  readonly direction: 'incoming' | 'outgoing'
  readonly senderId: string
  readonly senderName: string
  readonly text: string
  readonly sentAt: string
}

export interface ThreadDetail {
  readonly thread: ThreadSummary
  readonly messages: readonly MessageView[]
  /** Cursor for an older page; null when the start of the thread is reached. */
  readonly nextBefore: string | null
}

/**
 * Task lifecycle. `awaiting-approval` is the only state an approved task may
 * leave for `queued`; `running` cannot be reached without an approved Approval.
 */
export type TaskStatus =
  | 'captured'
  | 'awaiting-approval'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface Task {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly threadKey: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly approvalId: string | null
}

export interface Approval {
  readonly id: string
  readonly taskId: string
  readonly status: ApprovalStatus
  readonly requestedAt: string
  readonly expiresAt: string
  readonly decidedAt: string | null
  readonly decidedBy: string | null
}

export interface TaskDetail {
  readonly task: Task
  readonly approval: Approval | null
  readonly messages: readonly MessageView[]
}

export interface ThreadsPage {
  readonly items: readonly ThreadSummary[]
  readonly nextOffset: number | null
}

export interface TasksPage {
  readonly items: readonly Task[]
  readonly nextOffset: number | null
}

export interface ApprovalDecisionResult {
  readonly task: Task
  readonly approval: Approval
}

export interface AuditEntry {
  readonly id: string
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly target: string
  readonly outcome: 'ok' | 'denied' | 'failed'
  readonly detail?: string
}

export interface AuditPage {
  readonly items: readonly AuditEntry[]
  readonly nextOffset: number | null
}

export interface HealthCheck {
  readonly id: string
  readonly status: HealthStatus
  readonly detail: string
  readonly observedAt: string
}

export interface Health {
  readonly ok: boolean
  readonly status: HealthStatus
  readonly checks: readonly HealthCheck[]
  readonly dws: {
    readonly binaryPath: string
    readonly available: boolean
    readonly authenticated: boolean | null
  }
}

export interface Overview {
  readonly generatedAt: string
  readonly monitor: {
    readonly enabled: boolean
    readonly paused: boolean
    readonly running: boolean
  }
  readonly counts: {
    readonly targets: number
    readonly threads: number
    readonly tasks: number
    readonly awaitingApproval: number
  }
  readonly health: Health
}

/** Successful `GET /whale-chan/api/state` payload. */
export interface StateView {
  readonly ok: true
  readonly name: string
  readonly version: string
  readonly stateDir: string
  readonly startedAt: string
}

/** Settings value and its optimistic-concurrency revision. */
export interface SettingsBlockView {
  readonly block: SettingsBlock
  readonly value: unknown
  readonly revision: number
}

export interface SettingsView {
  readonly blocks: Readonly<Record<SettingsBlock, SettingsBlockView>>
  readonly revision: number
}

export interface PersonaView {
  readonly persona: PersonaSettings
  readonly revision: number
}

export interface MonitorPauseResult {
  readonly paused: boolean
}

export interface DiscoverTargetsResult {
  readonly candidates: readonly TargetCandidate[]
}

export interface ValidateTargetsResult {
  readonly results: readonly TargetValidation[]
}

export interface SettingsUpdateResult {
  readonly block: SettingsBlock
  readonly value: unknown
  readonly revision: number
}

export interface TaskActionRequest {
  readonly reason?: string
}

export interface ApproveTaskRequest {
  readonly approvalId?: string
}

export interface DiscoverTargetsRequest {
  readonly kind: TargetKind
  readonly query?: string
}

export interface ValidateTargetsRequest {
  readonly targets: readonly TargetDraft[]
}

export interface SettingsUpdateRequest {
  readonly value: Record<string, unknown>
  /** Required optimistic-concurrency token; missing revisions are rejected. */
  readonly revision: number
}

export interface PermissionPresetView {
  readonly id: PermissionPreset
  readonly label: string
}
