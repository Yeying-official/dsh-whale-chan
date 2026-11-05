import { describe, expect, it } from 'vitest'
import { FIELDS } from '../src/shared/fields.ts'
import { EMPTY_PERSONA, PERSONA_PRESETS, WHALE_MAID_PERSONA } from '../src/shared/persona-defaults.ts'
import { SETTINGS_DEFAULTS, SettingsSchema, type Settings } from '../src/shared/settings.ts'

function withPath(path: string, value: unknown): Settings {
  const clone = structuredClone(SETTINGS_DEFAULTS) as unknown as Record<string, unknown>
  const parts = path.split('.')
  let cursor: Record<string, unknown> = clone
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (typeof next !== 'object' || next === null) throw new Error(`Missing settings path: ${path}`)
    cursor = next as Record<string, unknown>
  }
  cursor[parts[parts.length - 1] as string] = value
  return clone as unknown as Settings
}

const fullPath = (block: string, path: string): string => `${block}.${path}`

describe('settings defaults', () => {
  it('matches the committed default snapshot', () => {
    expect(SETTINGS_DEFAULTS).toMatchSnapshot()
  })

  it('parses an empty object into the full default shape', () => {
    const parsed = SettingsSchema.parse({})
    expect(parsed).toEqual(SETTINGS_DEFAULTS)
    expect(parsed.persona.name).toBe('鲸鱼酱')
    expect(parsed.monitor.intervalSeconds).toBe(45)
    expect(parsed.targets.rows).toEqual([])
    expect(parsed.models.reply).toEqual({ provider: '', model: '', effort: '' })
  })
})

describe('persona defaults and presets', () => {
  it('defaults to the empty persona, not a character template', () => {
    expect(SETTINGS_DEFAULTS.persona).toEqual(EMPTY_PERSONA)
    expect(SettingsSchema.parse({}).persona).toEqual(EMPTY_PERSONA)
    expect(EMPTY_PERSONA.name).toBe('鲸鱼酱')
    expect(EMPTY_PERSONA.identity).toBe('')
    expect(EMPTY_PERSONA.tone).toBe('')
    expect(EMPTY_PERSONA.language).toBe('auto')
    expect(EMPTY_PERSONA.signature).toBe('')
    expect(EMPTY_PERSONA.rules).toEqual([])
    expect(EMPTY_PERSONA.knowledge).toBe('')
    expect(EMPTY_PERSONA.samples).toEqual([])
  })

  it('mirrors the empty persona in the field registry', () => {
    const defaults = new Map(
      FIELDS.filter((field) => field.block === 'persona').map((field) => [field.path, field.defaultValue]),
    )
    for (const [path, value] of Object.entries(EMPTY_PERSONA)) {
      expect(defaults.get(path), path).toEqual(value)
    }
    expect(defaults.size).toBe(Object.keys(EMPTY_PERSONA).length)
  })

  it('does not share persona arrays between parses or with the frozen constant', () => {
    const first = SettingsSchema.parse({}).persona
    const second = SettingsSchema.parse({}).persona
    expect(first.rules).not.toBe(second.rules)
    expect(first.samples).not.toBe(second.samples)
    expect(first.rules).not.toBe(EMPTY_PERSONA.rules)
    first.rules.push('只有这一份草稿能看到')
    expect(second.rules).toEqual([])
    expect(EMPTY_PERSONA.rules).toEqual([])
  })

  it('ships the whale maid as an opt-in preset that differs from the default', () => {
    expect(PERSONA_PRESETS).toHaveLength(1)
    const preset = PERSONA_PRESETS[0]
    expect(preset?.id).toBe('whale-maid')
    expect(preset?.name).toBe('蓝白鲸鱼女仆')
    expect(preset?.persona).toEqual(WHALE_MAID_PERSONA)
    expect(preset?.persona.language).toBe('zh-CN')
    expect(preset?.persona.tone.length).toBeGreaterThan(0)
    expect(preset?.persona.rules.length).toBeGreaterThan(0)
    expect(preset?.persona.knowledge.length).toBeGreaterThan(0)
    expect(preset?.persona.samples.length).toBeGreaterThan(0)
    expect(preset?.persona).not.toEqual(EMPTY_PERSONA)
  })
})

describe('settings validation', () => {
  it('rejects unknown keys at the root and inside a block', () => {
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, unexpected: true }).success).toBe(false)
    expect(SettingsSchema.safeParse({ monitor: { unexpected: true } }).success).toBe(false)
    expect(
      SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, monitor: { ...SETTINGS_DEFAULTS.monitor, extra: 1 } }).success,
    ).toBe(false)
  })

  it('enforces the lower and upper bound of every numeric field', () => {
    for (const field of FIELDS.filter((item) => item.type === 'number')) {
      const min = field.min
      const max = field.max
      expect(min, field.path).toEqual(expect.any(Number))
      expect(max, field.path).toEqual(expect.any(Number))
      const path = fullPath(field.block, field.path)
      expect(SettingsSchema.safeParse(withPath(path, min)).success, `${path}=min`).toBe(true)
      expect(SettingsSchema.safeParse(withPath(path, max)).success, `${path}=max`).toBe(true)
      expect(SettingsSchema.safeParse(withPath(path, (min as number) - 1)).success, `${path}=below`).toBe(false)
      expect(SettingsSchema.safeParse(withPath(path, (max as number) + 1)).success, `${path}=above`).toBe(false)
      expect(SettingsSchema.safeParse(withPath(path, (min as number) + 0.5)).success, `${path}=fraction`).toBe(false)
    }
  })

  it('accepts only declared enum values', () => {
    for (const field of FIELDS.filter((item) => item.type === 'enum')) {
      const path = fullPath(field.block, field.path)
      for (const option of field.options ?? []) {
        expect(SettingsSchema.safeParse(withPath(path, option)).success, `${path}=${option}`).toBe(true)
      }
      expect(SettingsSchema.safeParse(withPath(path, '__not-a-real-option__')).success, path).toBe(false)
    }
  })

  it('rejects wrong scalar types and malformed quiet-hour times', () => {
    expect(SettingsSchema.safeParse(withPath('monitor.enabled', 'yes')).success).toBe(false)
    expect(SettingsSchema.safeParse(withPath('persona.maxReplyChars', '300')).success).toBe(false)
    expect(SettingsSchema.safeParse(withPath('reply.allowedSenders', 'someone')).success).toBe(false)
    expect(SettingsSchema.safeParse(withPath('monitor.quietHours.start', '25:00')).success).toBe(false)
    expect(SettingsSchema.safeParse(withPath('monitor.quietHours.end', '8:00')).success).toBe(false)
    expect(SettingsSchema.safeParse(withPath('persona.language', 'fr')).success).toBe(false)
    expect(SettingsSchema.safeParse(withPath('tasks.permissionPreset', 'root')).success).toBe(false)
  })

  it('defaults the compose retry switch on and keeps the reply block strict', () => {
    expect(SETTINGS_DEFAULTS.reply.autoRetry).toBe(true)
    expect(SettingsSchema.parse({}).reply.autoRetry).toBe(true)
    expect(SettingsSchema.parse({ reply: { autoRetry: false } }).reply.autoRetry).toBe(false)
    expect(SettingsSchema.safeParse({ reply: { autoRetry: 'yes' } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ reply: { autoRetry: true, extra: true } }).success).toBe(false)
  })

  it('validates target rows without accepting unknown row fields', () => {
    const valid = {
      kind: 'group',
      id: 'cid-example',
      label: 'AI工程师孵化中心',
      mentionOnly: true,
      replyMode: 'auto',
      enabled: true,
    }
    expect(
      SettingsSchema.safeParse({
        targets: { rows: [valid] },
      }).success,
    ).toBe(true)
    expect(SettingsSchema.safeParse({ targets: { rows: [{ ...valid, id: '' }] } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ targets: { rows: [{ ...valid, kind: 'unknown' }] } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ targets: { rows: [{ ...valid, extra: true }] } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ targets: { rows: [{ ...valid, replyMode: 'shout' }] } }).success).toBe(false)
  })
})
