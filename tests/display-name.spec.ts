/**
 * Display-name contract for the DSH助理 rename.
 *
 * Stage one only renames user-visible product surfaces. The internal identity
 * stays frozen — package name, version, state directory, API prefix, panel id,
 * preset ids and the database are all unchanged — and the default persona name
 * is still 鲸鱼酱, which the owner may edit on the persona page. These tests
 * pin both halves so a later UI change cannot silently rename the persona or
 * break an installed profile.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { PANEL_ID, PLUGIN_DISPLAY_NAME, PLUGIN_NAME, PLUGIN_VERSION } from '../src/shared/limits.ts'
import { SETTINGS_DEFAULTS } from '../src/shared/settings.ts'

const PRODUCT_ZH = 'DSH助理'
const PRODUCT_EN = 'DSH Assistant'
const DEFAULT_PERSONA = '鲸鱼酱'

type Dictionary = Record<string, unknown> & {
  meta: { title: string; description: string }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function stringAt(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  expect(typeof value, key).toBe('string')
  return value as string
}

const zh = readJson<Dictionary>('locale/zh.json')
const en = readJson<Dictionary>('locale/en.json')
const manifest = readJson<Record<string, unknown>>('package.json')

describe('product display name', () => {
  it('names the plugin DSH助理 and keeps the old name out of it', () => {
    expect(PLUGIN_DISPLAY_NAME).toBe('DSH助理 · 钉钉助理')
    expect(PLUGIN_DISPLAY_NAME).toContain(PRODUCT_ZH)
    expect(PLUGIN_DISPLAY_NAME).not.toContain(DEFAULT_PERSONA)
  })

  it('renames every Chinese product surface', () => {
    expect(zh.meta.title).toBe(PLUGIN_DISPLAY_NAME)
    expect(zh.meta.description).toContain(PRODUCT_ZH)
    expect(stringAt(zh, 'panel.label')).toBe(PRODUCT_ZH)
    expect(stringAt(zh, 'overview.title')).toBe('DSH助理 · 钉钉助理')
    for (const surface of [
      zh.meta.title,
      zh.meta.description,
      stringAt(zh, 'panel.label'),
      stringAt(zh, 'overview.title'),
    ]) {
      expect(surface).not.toContain(DEFAULT_PERSONA)
    }
  })

  it('renames every English product surface', () => {
    expect(en.meta.title).toBe('DSH Assistant · DingTalk Assistant')
    expect(en.meta.description).toContain(PRODUCT_EN)
    expect(stringAt(en, 'panel.label')).toBe(PRODUCT_EN)
    expect(stringAt(en, 'overview.title')).toBe('DSH Assistant · DingTalk Assistant')
    for (const surface of [
      en.meta.title,
      en.meta.description,
      stringAt(en, 'panel.label'),
      stringAt(en, 'overview.title'),
    ]) {
      expect(surface).not.toMatch(/Whale Chan|鲸鱼酱/)
    }
  })

  it('keeps the package identity frozen while renaming its description', () => {
    expect(manifest.name).toBe(PLUGIN_NAME)
    expect(manifest.name).toBe('dsh-whale-chan-assistant')
    expect(manifest.version).toBe(PLUGIN_VERSION)
    expect(PANEL_ID).toBe('whale-chan')
    expect(String(manifest.description)).toContain(PRODUCT_ZH)
    expect(String(manifest.description)).not.toContain(DEFAULT_PERSONA)
  })

  it('labels the sidebar icon with the renamed title', () => {
    const icon = readFileSync('assets/icon.svg', 'utf8')
    expect(icon).toContain(`<title id="title">${PLUGIN_DISPLAY_NAME}</title>`)
    expect(icon).not.toContain(DEFAULT_PERSONA)
  })
})

describe('agent presets', () => {
  interface Row {
    readonly id?: string
    readonly config?: { readonly id?: string; readonly name?: string; readonly description?: string }
  }
  const document = parse(readFileSync('cordis.patch.yml', 'utf8'), { logLevel: 'error' }) as Array<{
    insert?: Row[]
  }>
  const rows = document.flatMap((layer) => layer.insert ?? [])

  function preset(rowId: string) {
    const row = rows.find((item) => item.id === rowId)
    expect(row, rowId).toBeDefined()
    return row?.config as NonNullable<Row['config']>
  }

  it('renames both preset display names and descriptions', () => {
    for (const [rowId, expected] of [
      ['dsh-whale-chan-replier-preset', 'DSH助理 · 回复器'],
      ['dsh-whale-chan-worker-preset', 'DSH助理 · 任务执行器'],
    ] as const) {
      const config = preset(rowId)
      expect(config.name).toBe(expected)
      expect(config.name).toContain(PRODUCT_ZH)
      expect(config.description).toContain(PRODUCT_ZH)
      expect(config.description).not.toContain(DEFAULT_PERSONA)
    }
  })

  it('keeps the preset ids the executor and installed profiles use', () => {
    expect(preset('dsh-whale-chan-replier-preset').id).toBe('dsh-whale-chan-replier')
    expect(preset('dsh-whale-chan-worker-preset').id).toBe('dsh-whale-chan-worker')
  })
})

describe('default persona', () => {
  it('stays 鲸鱼酱 so existing settings and prompts keep working', () => {
    expect(SETTINGS_DEFAULTS.persona.name).toBe(DEFAULT_PERSONA)
    // The label tells the owner this is the assistant's own name, not the
    // product name shown in the sidebar and header.
    expect(stringAt(zh, 'settings.persona.name.label')).toBe('助理名字')
    expect(stringAt(en, 'settings.persona.name.label')).toBe('Assistant name')
  })
})

describe('workspace copy', () => {
  const workspaceKeys = [
    'targets.workspace.title',
    'targets.workspace.ready',
    'targets.workspace.perConversation',
    'targets.workspace.copy',
    'targets.workspace.copied',
    'targets.workspace.hint',
  ] as const

  it('translates every read-only workspace key in both locales', () => {
    for (const key of workspaceKeys) {
      expect(stringAt(zh, key).trim().length, `zh:${key}`).toBeGreaterThan(0)
      expect(stringAt(en, key).trim().length, `en:${key}`).toBeGreaterThan(0)
      expect(stringAt(zh, key), `zh:${key}`).not.toContain(DEFAULT_PERSONA)
      expect(stringAt(en, key), `en:${key}`).not.toContain(DEFAULT_PERSONA)
    }
    expect(stringAt(zh, 'targets.workspace.perConversation')).toBe('按会话创建')
    expect(stringAt(en, 'targets.workspace.perConversation')).toBe('Per conversation')
  })

  it('explains the shared root and the absolute-path exception', () => {
    expect(stringAt(zh, 'settings.tasks.workspaceRoot.hint')).toContain('相对路径')
    expect(stringAt(zh, 'settings.tasks.workspaceRoot.hint')).toContain('共用')
    expect(stringAt(en, 'settings.tasks.workspaceRoot.hint')).toContain('relative path')
    expect(stringAt(en, 'settings.tasks.workspaceRoot.hint')).toContain('Shared root')
    expect(stringAt(zh, 'tasks.approve.workspaceHint')).toContain('会话')
    expect(stringAt(zh, 'tasks.approve.workspaceHint')).toContain('绝对路径')
    expect(stringAt(en, 'tasks.approve.workspaceHint')).toContain('conversation')
    expect(stringAt(en, 'tasks.approve.workspaceHint')).toContain('absolute path')
  })
})
