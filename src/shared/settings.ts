/**
 * Frozen settings contract shared by the host and the browser.
 *
 * Every block is strict: unknown keys are rejected rather than silently kept.
 * Numeric boundaries come from `limits.ts`; the same values are mirrored by the
 * field registry in `fields.ts` and checked by `tests/contract.spec.ts`.
 */
import { z } from 'zod'
import { LOG_LEVELS, LIMITS, PERMISSION_PRESETS, PERSONA_LANGUAGES, REPLY_MODES, TARGET_KINDS } from './limits.ts'
import { EMPTY_PERSONA } from './persona-defaults.ts'

export const SETTINGS_BLOCKS = [
  'monitor',
  'targets',
  'persona',
  'reply',
  'research',
  'tasks',
  'models',
  'dws',
  'advanced',
] as const

export type SettingsBlock = (typeof SETTINGS_BLOCKS)[number]
export const SettingsBlockSchema = z.enum(SETTINGS_BLOCKS)

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/

export const QuietHoursSchema = z
  .object({
    enabled: z.boolean().default(true),
    start: z.string().regex(TIME_OF_DAY, 'Expected HH:mm').default('22:00'),
    end: z.string().regex(TIME_OF_DAY, 'Expected HH:mm').default('08:00'),
  })
  .strict()

export const TargetRowSchema = z
  .object({
    kind: z.enum(TARGET_KINDS),
    id: z.string().trim().min(1),
    label: z.string().trim().default(''),
    mentionOnly: z.boolean().default(true),
    replyMode: z.enum(REPLY_MODES).default('auto'),
    enabled: z.boolean().default(true),
  })
  .strict()

export const MonitorSchema = z
  .object({
    enabled: z.boolean().default(true),
    intervalSeconds: z
      .number()
      .int()
      .min(LIMITS.monitor.intervalSeconds.min)
      .max(LIMITS.monitor.intervalSeconds.max)
      .default(45),
    catchUpMinutes: z
      .number()
      .int()
      .min(LIMITS.monitor.catchUpMinutes.min)
      .max(LIMITS.monitor.catchUpMinutes.max)
      .default(10),
    quietHours: QuietHoursSchema.default(QuietHoursSchema.parse({})),
    replyDuringQuiet: z.boolean().default(false),
    paused: z.boolean().default(false),
    maxTargets: z.number().int().min(LIMITS.monitor.maxTargets.min).max(LIMITS.monitor.maxTargets.max).default(10),
  })
  .strict()

export const TargetsSchema = z
  .object({
    rows: z.array(TargetRowSchema).default([]),
  })
  .strict()

export const PersonaSchema = z
  .object({
    name: z.string().trim().min(1).default(EMPTY_PERSONA.name),
    identity: z.string().default(EMPTY_PERSONA.identity),
    tone: z.string().default(EMPTY_PERSONA.tone),
    language: z.enum(PERSONA_LANGUAGES).default(EMPTY_PERSONA.language),
    signature: z.string().default(EMPTY_PERSONA.signature),
    // Array defaults are factories so parsed values never share the constant's arrays.
    rules: z.array(z.string()).default(() => [...EMPTY_PERSONA.rules]),
    knowledge: z.string().default(EMPTY_PERSONA.knowledge),
    samples: z.array(z.string()).default(() => [...EMPTY_PERSONA.samples]),
    allowEmoji: z.boolean().default(EMPTY_PERSONA.allowEmoji),
    maxReplyChars: z
      .number()
      .int()
      .min(LIMITS.persona.maxReplyChars.min)
      .max(LIMITS.persona.maxReplyChars.max)
      .default(EMPTY_PERSONA.maxReplyChars),
  })
  .strict()

export const ReplySchema = z
  .object({
    autoReply: z.boolean().default(true),
    allowedSenders: z.array(z.string()).default([]),
    blockedSenders: z.array(z.string()).default([]),
    maxPerConversationPerHour: z
      .number()
      .int()
      .min(LIMITS.reply.maxPerConversationPerHour.min)
      .max(LIMITS.reply.maxPerConversationPerHour.max)
      .default(20),
    minGapSeconds: z.number().int().min(LIMITS.reply.minGapSeconds.min).max(LIMITS.reply.minGapSeconds.max).default(8),
    ignoreBroadcast: z.boolean().default(true),
    requireMentionInGroups: z.boolean().default(true),
    ackOnTaskCapture: z.boolean().default(true),
    declineOnReject: z.boolean().default(false),
  })
  .strict()

export const ResearchSchema = z
  .object({
    enabled: z.boolean().default(true),
    onQuestionsOnly: z.boolean().default(true),
    maxResults: z.number().int().min(LIMITS.research.maxResults.min).max(LIMITS.research.maxResults.max).default(5),
    timeoutMs: z.number().int().min(LIMITS.research.timeoutMs.min).max(LIMITS.research.timeoutMs.max).default(8000),
    includeCitations: z.boolean().default(true),
    cacheMinutes: z
      .number()
      .int()
      .min(LIMITS.research.cacheMinutes.min)
      .max(LIMITS.research.cacheMinutes.max)
      .default(30),
  })
  .strict()

export const TasksSchema = z
  .object({
    enabled: z.boolean().default(true),
    approvalTtlHours: z
      .number()
      .int()
      .min(LIMITS.tasks.approvalTtlHours.min)
      .max(LIMITS.tasks.approvalTtlHours.max)
      .default(24),
    maxOpen: z.number().int().min(LIMITS.tasks.maxOpen.min).max(LIMITS.tasks.maxOpen.max).default(10),
    workspaceRoot: z.string().default(''),
    permissionPreset: z.enum(PERMISSION_PRESETS).default('workspace-write'),
    timeoutMinutes: z
      .number()
      .int()
      .min(LIMITS.tasks.timeoutMinutes.min)
      .max(LIMITS.tasks.timeoutMinutes.max)
      .default(20),
    maxConcurrent: z.number().int().min(LIMITS.tasks.maxConcurrent.min).max(LIMITS.tasks.maxConcurrent.max).default(2),
  })
  .strict()

export const ModelRouteSchema = z
  .object({
    provider: z.string().trim().default(''),
    model: z.string().trim().default(''),
    effort: z.string().trim().default(''),
  })
  .strict()

export const ModelsSchema = z
  .object({
    reply: ModelRouteSchema.default(ModelRouteSchema.parse({})),
    worker: ModelRouteSchema.default(ModelRouteSchema.parse({})),
  })
  .strict()

export const DwsSchema = z
  .object({
    binaryPath: z.string().trim().min(1).default('dws'),
    profile: z.string().trim().default(''),
    eventTtlHours: z.number().int().min(LIMITS.dws.eventTtlHours.min).max(LIMITS.dws.eventTtlHours.max).default(24),
    restartBackoffMaxSeconds: z
      .number()
      .int()
      .min(LIMITS.dws.restartBackoffMaxSeconds.min)
      .max(LIMITS.dws.restartBackoffMaxSeconds.max)
      .default(60),
    debug: z.boolean().default(false),
  })
  .strict()

export const AdvancedSchema = z
  .object({
    logLevel: z.enum(LOG_LEVELS).default('info'),
    auditRetentionDays: z
      .number()
      .int()
      .min(LIMITS.advanced.auditRetentionDays.min)
      .max(LIMITS.advanced.auditRetentionDays.max)
      .default(30),
    dryRun: z.boolean().default(false),
    debugPayloads: z.boolean().default(false),
  })
  .strict()

/**
 * The complete persisted settings shape. `parse({})` yields every default, so
 * the host can treat a missing section as an empty user overlay.
 */
export const SettingsSchema = z
  .object({
    monitor: MonitorSchema.default(MonitorSchema.parse({})),
    targets: TargetsSchema.default(TargetsSchema.parse({})),
    // A factory keeps every parse's persona arrays independent; a shared default
    // object would hand the same arrays to every caller that omits the block.
    persona: PersonaSchema.default(() => PersonaSchema.parse({})),
    reply: ReplySchema.default(ReplySchema.parse({})),
    research: ResearchSchema.default(ResearchSchema.parse({})),
    tasks: TasksSchema.default(TasksSchema.parse({})),
    models: ModelsSchema.default(ModelsSchema.parse({})),
    dws: DwsSchema.default(DwsSchema.parse({})),
    advanced: AdvancedSchema.default(AdvancedSchema.parse({})),
  })
  .strict()

export type Settings = z.infer<typeof SettingsSchema>
export type MonitorSettings = z.infer<typeof MonitorSchema>
export type TargetRow = z.infer<typeof TargetRowSchema>
export type PersonaSettings = z.infer<typeof PersonaSchema>
export type ReplySettings = z.infer<typeof ReplySchema>
export type ResearchSettings = z.infer<typeof ResearchSchema>
export type TaskSettings = z.infer<typeof TasksSchema>
export type ModelRoute = z.infer<typeof ModelRouteSchema>
export type DwsSettings = z.infer<typeof DwsSchema>
export type AdvancedSettings = z.infer<typeof AdvancedSchema>

/** Latest complete default settings, used by the host and by contract tests. */
export const SETTINGS_DEFAULTS: Settings = SettingsSchema.parse({})

export type BlockValue<K extends SettingsBlock> = Settings[K]
