import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PromptLoadError,
  PromptRenderError,
  PromptStore,
  defaultPromptDir,
  render,
  resolvePromptDir,
} from '../src/brain/prompts.ts'
import { PROMPT_NAMES } from '../src/brain/types.ts'
import { SHIPPED_PROMPTS, shippedPromptStore } from './fixtures/brain.ts'

const temporaryDirs: string[] = []

function temporaryPromptDir(files: Record<string, string>): { path: string; url: URL } {
  const path = mkdtempSync(join(tmpdir(), 'whale-brain-prompts-'))
  temporaryDirs.push(path)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text, 'utf8')
  return { path, url: resolvePromptDir(path) }
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('PromptStore', () => {
  it('loads every shipped template', () => {
    const store = shippedPromptStore()
    for (const name of PROMPT_NAMES) {
      const text = store.get(name)
      expect(text.length, name).toBeGreaterThan(100)
      expect(text, name).not.toContain('<!--')
    }
    expect(Object.keys(store.preload()).sort()).toEqual([...PROMPT_NAMES].sort())
  })

  it('strips the documentation comments a template carries', () => {
    const persona = shippedPromptStore().get('persona')
    expect(persona).not.toContain('人设骨架')
    expect(persona).toContain('你是「{{name}}」')
  })

  it('caches a template until it is reloaded', () => {
    const dir = temporaryPromptDir({ 'safety.md': '第一版安全规则' })
    const store = new PromptStore({ dir: dir.url })
    expect(store.get('safety')).toBe('第一版安全规则')

    writeFileSync(join(dir.path, 'safety.md'), '第二版安全规则', 'utf8')
    expect(store.get('safety')).toBe('第一版安全规则')

    store.reload('safety')
    expect(store.get('safety')).toBe('第二版安全规则')
  })

  it('fails fast when a template is missing', () => {
    const store = new PromptStore({ dir: new URL('../does-not-exist/', import.meta.url) })
    expect(() => store.get('classifier')).toThrow(PromptLoadError)
    try {
      store.get('classifier')
    } catch (error) {
      const failure = error as PromptLoadError
      expect(failure.reason).toBe('missing')
      expect(failure.prompt).toBe('classifier')
      expect(failure.path).toContain('classifier.md')
      expect(failure.message).toContain('prompts')
    }
  })

  it('refuses a template that is only whitespace', () => {
    const store = new PromptStore({ dir: temporaryPromptDir({ 'reply.md': '  \n\n\t ' }).url })
    try {
      store.get('reply')
      throw new Error('expected the empty template to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(PromptLoadError)
      expect((error as PromptLoadError).reason).toBe('empty')
    }
  })

  it('preload rejects the whole set when one template is missing', () => {
    const store = new PromptStore({ dir: temporaryPromptDir({ 'safety.md': '安全' }).url })
    expect(() => store.preload()).toThrow(PromptLoadError)
  })

  it('resolves the packaged directory from either build layout', () => {
    const packaged = defaultPromptDir(new URL('../lib/index.js', import.meta.url))
    const source = defaultPromptDir(new URL('../src/brain/prompts.ts', import.meta.url))
    expect(packaged.href).toBe(SHIPPED_PROMPTS.href)
    expect(source.href).toBe(SHIPPED_PROMPTS.href)
    expect(resolvePromptDir(fileURLToPath(SHIPPED_PROMPTS)).href.endsWith('/')).toBe(true)
  })
})

describe('render', () => {
  it('replaces scalars and lists in one pass', () => {
    const text = render('名字={{name}} 上限={{limit}} 规则={{rules}}', {
      name: '鲸鱼酱',
      limit: 300,
      rules: ['- 不承诺', '- 不泄露'],
    })
    expect(text).toBe('名字=鲸鱼酱 上限=300 规则=- 不承诺\n- 不泄露')
  })

  it('does not rescan text it inserted', () => {
    expect(render('{{outer}}', { outer: '{{inner}}' })).toBe('{{inner}}')
  })

  it('tolerates spaces inside the braces', () => {
    expect(render('{{ name }}', { name: '鲸鱼酱' })).toBe('鲸鱼酱')
  })

  it('reports every unknown variable and leaves the placeholder visible', () => {
    try {
      render('{{known}} {{missing_a}} {{missing_b}}', { known: 'x' })
      throw new Error('expected unknown variables to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(PromptRenderError)
      expect((error as PromptRenderError).variables).toEqual(['missing_a', 'missing_b'])
    }
  })
})
