/**
 * Product-wide constants and numeric boundaries shared by the host and the browser.
 *
 * This module is the single source for limits used by the settings schema, the
 * field registry and the contract tests. It must stay free of Node.js imports so
 * that the client bundle can include it.
 */

export const PLUGIN_NAME = 'dsh-whale-chan-assistant' as const
export const PLUGIN_DISPLAY_NAME = 'DSH助理 · 钉钉助理' as const
export const PLUGIN_VERSION = '0.4.0' as const
export const PANEL_ID = 'whale-chan' as const
export const DEFAULT_STATE_DIR = '~/.dsh-whale-chan' as const
export const DEFAULT_LOCALE = 'zh' as const

export const LIMITS = {
  monitor: {
    intervalSeconds: { min: 15, max: 300 },
    catchUpMinutes: { min: 0, max: 120 },
    maxTargets: { min: 1, max: 20 },
  },
  persona: {
    maxReplyChars: { min: 1, max: 800 },
  },
  reply: {
    maxPerConversationPerHour: { min: 1, max: 60 },
    minGapSeconds: { min: 3, max: 120 },
  },
  research: {
    maxResults: { min: 1, max: 8 },
    timeoutMs: { min: 1000, max: 20000 },
    cacheMinutes: { min: 0, max: 1440 },
  },
  tasks: {
    approvalTtlHours: { min: 1, max: 168 },
    maxOpen: { min: 1, max: 50 },
    timeoutMinutes: { min: 1, max: 120 },
    maxConcurrent: { min: 1, max: 4 },
  },
  dws: {
    eventTtlHours: { min: 1, max: 720 },
    restartBackoffMaxSeconds: { min: 10, max: 300 },
  },
  advanced: {
    auditRetentionDays: { min: 1, max: 365 },
  },
} as const

export type LogLevel = 'info' | 'debug' | 'warn' | 'error'
export const LOG_LEVELS = ['info', 'debug', 'warn', 'error'] as const satisfies readonly LogLevel[]

export type PermissionPreset = 'workspace-write' | 'danger-full-access'
export const PERMISSION_PRESETS = [
  'workspace-write',
  'danger-full-access',
] as const satisfies readonly PermissionPreset[]

export type TargetKind = 'at-me' | 'group' | 'dm'
export const TARGET_KINDS = ['at-me', 'group', 'dm'] as const satisfies readonly TargetKind[]

export type ReplyMode = 'auto' | 'review' | 'off'
export const REPLY_MODES = ['auto', 'review', 'off'] as const satisfies readonly ReplyMode[]

export type PersonaLanguage = 'auto' | 'zh-CN' | 'en'
export const PERSONA_LANGUAGES = ['auto', 'zh-CN', 'en'] as const satisfies readonly PersonaLanguage[]
