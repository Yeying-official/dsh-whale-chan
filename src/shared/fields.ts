/**
 * Field registry of every leaf in the frozen settings contract.
 *
 * The registry is browser-safe (no Node imports and no Zod) so the client can
 * render future settings forms without importing host code. `tests/contract.spec.ts`
 * proves a one-to-one correspondence with `SettingsSchema`.
 */
import { LIMITS, LOG_LEVELS, PERMISSION_PRESETS, PERSONA_LANGUAGES } from './limits.ts'
import { EMPTY_PERSONA } from './persona-defaults.ts'
import type { SettingsBlock } from './settings.ts'

export type FieldType = 'boolean' | 'number' | 'string' | 'enum' | 'string-list' | 'rows'
export type FieldUnit = 'seconds' | 'minutes' | 'hours' | 'milliseconds' | 'characters' | 'count' | 'days'

export interface FieldSpec {
  readonly block: SettingsBlock
  /** Dot path inside the block, with object leaves flattened. */
  readonly path: string
  readonly type: FieldType
  readonly labelKey: string
  readonly hintKey: string
  /** Default value in the frozen schema. Arrays and rows use immutable empty arrays. */
  readonly defaultValue: unknown
  readonly min?: number
  readonly max?: number
  readonly unit?: FieldUnit
  readonly options?: readonly string[]
}

const field = (
  block: SettingsBlock,
  path: string,
  type: FieldType,
  defaultValue: unknown,
  extra: Omit<Partial<FieldSpec>, 'block' | 'path' | 'type' | 'defaultValue' | 'labelKey' | 'hintKey'> = {},
): FieldSpec => ({
  block,
  path,
  type,
  labelKey: `settings.${block}.${path}.label`,
  hintKey: `settings.${block}.${path}.hint`,
  defaultValue,
  ...extra,
})

/** Every settings leaf, in block order. */
export const FIELDS: readonly FieldSpec[] = [
  field('monitor', 'enabled', 'boolean', true),
  field('monitor', 'intervalSeconds', 'number', 45, { ...LIMITS.monitor.intervalSeconds, unit: 'seconds' }),
  field('monitor', 'catchUpMinutes', 'number', 10, { ...LIMITS.monitor.catchUpMinutes, unit: 'minutes' }),
  field('monitor', 'quietHours.enabled', 'boolean', true),
  field('monitor', 'quietHours.start', 'string', '22:00'),
  field('monitor', 'quietHours.end', 'string', '08:00'),
  field('monitor', 'replyDuringQuiet', 'boolean', false),
  field('monitor', 'paused', 'boolean', false),
  field('monitor', 'maxTargets', 'number', 10, { ...LIMITS.monitor.maxTargets, unit: 'count' }),

  field('targets', 'rows', 'rows', []),

  field('persona', 'name', 'string', EMPTY_PERSONA.name),
  field('persona', 'identity', 'string', EMPTY_PERSONA.identity),
  field('persona', 'tone', 'string', EMPTY_PERSONA.tone),
  field('persona', 'language', 'enum', EMPTY_PERSONA.language, { options: PERSONA_LANGUAGES }),
  field('persona', 'signature', 'string', EMPTY_PERSONA.signature),
  field('persona', 'rules', 'string-list', [...EMPTY_PERSONA.rules]),
  field('persona', 'knowledge', 'string', EMPTY_PERSONA.knowledge),
  field('persona', 'samples', 'string-list', [...EMPTY_PERSONA.samples]),
  field('persona', 'allowEmoji', 'boolean', EMPTY_PERSONA.allowEmoji),
  field('persona', 'maxReplyChars', 'number', EMPTY_PERSONA.maxReplyChars, {
    ...LIMITS.persona.maxReplyChars,
    unit: 'characters',
  }),

  field('reply', 'autoReply', 'boolean', true),
  field('reply', 'allowedSenders', 'string-list', []),
  field('reply', 'blockedSenders', 'string-list', []),
  field('reply', 'maxPerConversationPerHour', 'number', 20, {
    ...LIMITS.reply.maxPerConversationPerHour,
    unit: 'count',
  }),
  field('reply', 'minGapSeconds', 'number', 8, { ...LIMITS.reply.minGapSeconds, unit: 'seconds' }),
  field('reply', 'ignoreBroadcast', 'boolean', true),
  field('reply', 'requireMentionInGroups', 'boolean', true),
  field('reply', 'ackOnTaskCapture', 'boolean', true),
  field('reply', 'declineOnReject', 'boolean', false),
  field('reply', 'autoRetry', 'boolean', true),

  field('research', 'enabled', 'boolean', true),
  field('research', 'onQuestionsOnly', 'boolean', true),
  field('research', 'maxResults', 'number', 5, { ...LIMITS.research.maxResults, unit: 'count' }),
  field('research', 'timeoutMs', 'number', 8000, { ...LIMITS.research.timeoutMs, unit: 'milliseconds' }),
  field('research', 'includeCitations', 'boolean', true),
  field('research', 'cacheMinutes', 'number', 30, { ...LIMITS.research.cacheMinutes, unit: 'minutes' }),

  field('tasks', 'enabled', 'boolean', true),
  field('tasks', 'approvalTtlHours', 'number', 24, { ...LIMITS.tasks.approvalTtlHours, unit: 'hours' }),
  field('tasks', 'maxOpen', 'number', 10, { ...LIMITS.tasks.maxOpen, unit: 'count' }),
  field('tasks', 'workspaceRoot', 'string', ''),
  field('tasks', 'permissionPreset', 'enum', 'workspace-write', { options: PERMISSION_PRESETS }),
  field('tasks', 'timeoutMinutes', 'number', 20, { ...LIMITS.tasks.timeoutMinutes, unit: 'minutes' }),
  field('tasks', 'maxConcurrent', 'number', 2, { ...LIMITS.tasks.maxConcurrent, unit: 'count' }),

  field('models', 'reply.provider', 'string', ''),
  field('models', 'reply.model', 'string', ''),
  field('models', 'reply.effort', 'string', ''),
  field('models', 'worker.provider', 'string', ''),
  field('models', 'worker.model', 'string', ''),
  field('models', 'worker.effort', 'string', ''),

  field('dws', 'binaryPath', 'string', 'dws'),
  field('dws', 'profile', 'string', ''),
  field('dws', 'eventTtlHours', 'number', 24, { ...LIMITS.dws.eventTtlHours, unit: 'hours' }),
  field('dws', 'restartBackoffMaxSeconds', 'number', 60, {
    ...LIMITS.dws.restartBackoffMaxSeconds,
    unit: 'seconds',
  }),
  field('dws', 'debug', 'boolean', false),

  field('advanced', 'logLevel', 'enum', 'info', { options: LOG_LEVELS }),
  field('advanced', 'auditRetentionDays', 'number', 30, {
    ...LIMITS.advanced.auditRetentionDays,
    unit: 'days',
  }),
  field('advanced', 'dryRun', 'boolean', false),
  field('advanced', 'debugPayloads', 'boolean', false),
]

export const FIELD_COUNT = FIELDS.length

export function fieldsOf(block: SettingsBlock): readonly FieldSpec[] {
  return FIELDS.filter((item) => item.block === block)
}

export function fieldAt(block: SettingsBlock, path: string): FieldSpec | undefined {
  return FIELDS.find((item) => item.block === block && item.path === path)
}
