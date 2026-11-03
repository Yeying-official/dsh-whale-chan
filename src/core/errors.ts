/**
 * Domain errors thrown by the engine.
 *
 * A `UserError` always means the command was refused before it committed. The
 * category says what the caller should do about it:
 *
 * - `missing`: the referenced record does not exist (a route answers 404);
 * - `invalid`: the caller supplied a value it can correct (a route answers 400);
 * - `refused`: the record exists but its current state forbids the change
 *   (a route answers 409).
 *
 * Every command validates and throws inside its transaction, so a rejection
 * leaves no partial write behind.
 */

/** What the caller can do about a rejected command. */
export type UserErrorCategory = 'missing' | 'invalid' | 'refused'

/** Codes mapped to their category and English message template. */
export const USER_ERRORS = {
  unknownDecision: ['missing', 'Unknown decision'],
  unknownTask: ['missing', 'Unknown task'],
  unknownMessage: ['missing', 'Unknown message'],
  unknownThread: ['missing', 'Unknown thread'],
  unknownApproval: ['missing', 'Unknown approval'],
  unknownAssignment: ['missing', 'Unknown assignment'],
  unknownOutbound: ['missing', 'Unknown outbound message'],
  notQueued: ['refused', 'Only a queued decision can be classified'],
  notClassified: ['refused', 'Only a classified decision can be drafted'],
  notDrafted: ['refused', 'Only a drafted decision can queue a reply'],
  notSending: ['refused', 'Only a decision that is sending can report a delivery result'],
  notDeferrable: ['refused', 'Only a queued or classified decision can be deferred'],
  /** The task decision is missing a title the owner can supply. */
  missingTaskDetail: ['invalid', 'A task decision needs the captured task title'],
  /** The approval TTL is a caller-supplied number, not a stored state. */
  missingApprovalTtl: ['invalid', 'A task decision needs a positive approval TTL'],
  /** Approving needs a directory the owner can choose. */
  missingWorkspace: ['invalid', 'Approving a task needs the workspace its assignment runs in'],
  /**
   * The workspace named at approval time is not an absolute path.
   *
   * It is a user-correctable input error, not an internal one: the panel must
   * ask the owner for another directory instead of reporting a bug, so the API
   * answers 400 rather than 409.
   */
  invalidWorkspace: ['invalid', 'The approved workspace must be an absolute path'],
  alreadyDecided: ['refused', 'The task approval was already decided'],
  approvalExpired: ['refused', 'The task approval expired; the task must expire instead of running'],
  notAwaitingApproval: ['refused', 'The task is not awaiting approval'],
  notApproved: ['refused', 'The task is not approved; no assignment may start'],
  notRunning: ['refused', 'The task is not running'],
  /**
   * Only a task that failed may be retried.
   *
   * A cancelled task is deliberately excluded: the owner ended it on purpose,
   * and retrying it would silently overrule that decision.
   */
  notFailed: ['refused', 'Only a failed task can be retried'],
  notCancellable: ['refused', 'Only an awaiting, approved or running task can be cancelled'],
  assignmentMismatch: ['refused', 'The assignment does not own this task'],
  assignmentNotPending: ['refused', 'The assignment is not pending'],
  assignmentNotRunning: ['refused', 'The assignment is not running'],
  outboundMissing: ['refused', 'The decision has no outbound message to update'],
  /** A caller-supplied instant did not parse; the owner can resend it. */
  invalidTime: ['invalid', 'The supplied time is not a valid ISO-8601 instant'],
} as const satisfies Record<string, readonly [UserErrorCategory, string]>

/** Stable code of a rejected command. */
export type UserErrorCode = keyof typeof USER_ERRORS

/** Structured refusal of a domain command. */
export class UserError extends Error {
  /** What the caller can do about the rejection. */
  readonly category: UserErrorCategory
  /** True only for `missing`; kept so existing callers need no change. */
  readonly missing: boolean
  readonly values: Record<string, string>

  constructor(
    readonly code: UserErrorCode,
    values: Record<string, string> = {},
  ) {
    const [category, template] = USER_ERRORS[code]
    super(template.replace(/\\{(\\w+)\\}/g, (match, name: string) => values[name] ?? match))
    this.name = 'UserError'
    this.category = category
    this.missing = category === 'missing'
    this.values = values
  }
}
