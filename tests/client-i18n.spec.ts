import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locale.ts'
import { FIELDS } from '../src/shared/fields.ts'
import { SETTINGS_BLOCKS } from '../src/shared/settings.ts'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(name) ? [path] : []
  })
}

const files = sourceFiles('src/client')
const sources = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }))

describe('client i18n', () => {
  it('keeps the Chinese and English dictionaries in lockstep', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(zhKeys).toEqual(enKeys)
    for (const key of zhKeys) {
      expect(zh[key as keyof typeof zh], key).toEqual(expect.any(String))
      expect(en[key as keyof typeof en], key).toEqual(expect.any(String))
      expect(String(zh[key as keyof typeof zh]).trim().length, key).toBeGreaterThan(0)
      expect(String(en[key as keyof typeof en]).trim().length, key).toBeGreaterThan(0)
    }
  })

  it('has copy for every tab, status and settings block', () => {
    for (const key of [
      'tabs.overview',
      'tabs.threads',
      'tabs.tasks',
      'tabs.targets',
      'tabs.persona',
      'tabs.settings',
      'tabs.audit',
      'common.refresh',
      'common.retry',
      'common.saved',
      'errors.offline',
      'errors.conflict',
      'errors.channelUnavailable',
      'dialog.close',
      'session.notReady',
      'session.notListed',
    ]) {
      expect(zh[key as keyof typeof zh], key).toEqual(expect.any(String))
      expect(en[key as keyof typeof en], key).toEqual(expect.any(String))
    }
    for (const status of [
      'captured',
      'awaiting-approval',
      'queued',
      'running',
      'succeeded',
      'failed',
      'rejected',
      'cancelled',
      'expired',
    ]) {
      expect(zh[`tasks.status.${status}` as keyof typeof zh], status).toEqual(expect.any(String))
    }
    for (const approval of ['pending', 'approved', 'rejected', 'expired']) {
      expect(zh[`tasks.approval.${approval}` as keyof typeof zh], approval).toEqual(expect.any(String))
    }
    for (const kind of ['at-me', 'group', 'dm']) {
      expect(zh[`threads.kind.${kind}` as keyof typeof zh], kind).toEqual(expect.any(String))
      expect(zh[`targets.kind.${kind}` as keyof typeof zh], kind).toEqual(expect.any(String))
    }
    for (const mode of ['auto', 'review', 'off']) {
      expect(zh[`targets.replyMode.${mode}` as keyof typeof zh], mode).toEqual(expect.any(String))
    }
    for (const check of ['state', 'stateDir', 'database', 'lock', 'settings', 'channel', 'executor']) {
      expect(zh[`health.check.${check}` as keyof typeof zh], check).toEqual(expect.any(String))
    }
    for (const block of SETTINGS_BLOCKS) {
      expect(zh[`settings.block.${block}.label` as keyof typeof zh], block).toEqual(expect.any(String))
    }
  })

  it('keeps every settings field label and hint translated', () => {
    for (const field of FIELDS) {
      for (const key of [field.labelKey, field.hintKey]) {
        expect(zh[key as keyof typeof zh], key).toEqual(expect.any(String))
        expect(en[key as keyof typeof en], key).toEqual(expect.any(String))
        expect(String(zh[key as keyof typeof zh]).trim().length, key).toBeGreaterThan(0)
        expect(String(en[key as keyof typeof en]).trim().length, key).toBeGreaterThan(0)
      }
    }
  })

  it('uses only keys that exist in both dictionaries', () => {
    const referenced = new Set<string>()
    for (const { text } of sources) {
      for (const match of text.matchAll(/\bt\(\s*'([^']+)'/g)) if (match[1]) referenced.add(match[1])
    }
    expect(referenced.size).toBeGreaterThan(150)
    for (const key of referenced) {
      expect(zh[key as keyof typeof zh], `zh:${key}`).toEqual(expect.any(String))
      expect(en[key as keyof typeof en], `en:${key}`).toEqual(expect.any(String))
    }
  })

  it('has no hard-coded CJK text in client sources', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('has no placeholder copy left in either language', () => {
    for (const dictionary of [zh, en]) {
      for (const [key, value] of Object.entries(dictionary)) {
        if (typeof value !== 'string') continue
        expect(value, key).not.toMatch(/TODO|FIXME|TBD/)
      }
    }
  })

  it('keeps the English dictionary free of Chinese copy', () => {
    for (const [key, value] of Object.entries(en)) {
      if (typeof value !== 'string') continue
      expect(value, key).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })
})
