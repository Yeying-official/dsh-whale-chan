/**
 * Domain errors thrown by the engine.
 *
 * A `UserError` always means the command was refused before it committed:
 * either the referenced record is unknown (`missing`, so a route answers 404)
 * or the current state forbids the change (`refused`, so a route answers 409).
 * Every command validates and throws inside its transaction, so a rejection
 * leaves no partial write behind.
 */

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
  missingTaskDetail: ['refused', 'A task decision needs the captured task title'],
  missingApprovalTtl: ['refused', 'A task decision needs a positive approval TTL'],
  missingWorkspace: ['refused', 'Approving a task needs the workspace its assignment runs in'],
  alreadyDecided: ['refused', 'The task approval was already decided'],
  approvalExpired: ['refused', 'The task approval expired; the task must expire instead of running'],
  notAwaitingApproval: ['refused', 'The task is not awaiting approval'],
  notApproved: ['refused', 'The task is not approved; no assignment may start'],
  notRunning: ['refused', 'The task is not running'],
  notCancellable: ['refused', 'Only an awaiting, approved or running task can be cancelled'],
  assignmentMismatch: ['refused', 'The assignment does not own this task'],
  assignmentNotPending: ['refused', 'The assignment is not pending'],
  assignmentNotRunning: ['refused', 'The assignment is not running'],
  outboundMissing: ['refused', 'The decision has no outbound message to update'],
} as const satisfies Record<string, readonly ['missing' | 'refused', string]>

/** Stable code of a refused or missing command. */
export type UserErrorCode = keyof typeof USER_ERRORS

/** Structured refusal of a domain command. */
export class UserError extends Error {
  readonly missing: boolean
  readonly values: Record<string, string>

  constructor(
    readonly code: UserErrorCode,
    values: Record<string, string> = {},
  ) {
    const [category, template] = USER_ERRORS[code]
    super(template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match))
    this.name = 'UserError'
    this.missing = category === 'missing'
    this.values = values
  }
}
