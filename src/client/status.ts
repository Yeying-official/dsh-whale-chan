/** Tone mapping shared by badges for tasks, approvals, health and audit rows. */
import type { BadgeTone } from './controls.tsx'
import type { ApprovalStatus, AuditEntry, HealthStatus, TaskStatus } from '../shared/models.ts'

export function taskTone(status: TaskStatus): BadgeTone {
  switch (status) {
    case 'awaiting-approval':
      return 'warning'
    case 'queued':
    case 'captured':
      return 'info'
    case 'running':
      return 'info'
    case 'succeeded':
      return 'success'
    case 'failed':
      return 'error'
    default:
      return 'neutral'
  }
}

export function approvalTone(status: ApprovalStatus): BadgeTone {
  switch (status) {
    case 'pending':
      return 'warning'
    case 'approved':
      return 'success'
    case 'rejected':
      return 'error'
    default:
      return 'neutral'
  }
}

export function healthTone(status: HealthStatus): BadgeTone {
  return status === 'ok' ? 'success' : status === 'degraded' ? 'warning' : 'error'
}

export function outcomeTone(outcome: AuditEntry['outcome']): BadgeTone {
  return outcome === 'ok' ? 'success' : outcome === 'denied' ? 'warning' : 'error'
}
