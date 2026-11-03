/**
 * The bundle patch declares two agent presets and keeps the host row.
 *
 * The real Loader evaluates `!!js` expressions and resolves each `name` against
 * the installed DSH packages; this test cannot do either, so it asserts the
 * part a patch owns — the row ids, the declaration fields the preset registry
 * reads, the plugin lists, and that no id is declared twice. The plugin package
 * names used here ship with DSH (`@deepseek-ai/dsh-persona`,
 * `@deepseek-ai/dsh-tool-web`, …); `docs/test-reports/WS4.md` records how that
 * was verified.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPLIER_PRESET, WORKER_PRESET } from '../src/executor/index.ts'

interface Row {
  readonly id?: string
  readonly name?: string
  readonly group?: boolean
  readonly disabled?: unknown
  readonly isolate?: unknown
  readonly config?: unknown
}

interface PresetConfig {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly Row[]
}

const raw = readFileSync('cordis.patch.yml', 'utf8')
const document = parse(raw, { logLevel: 'error' }) as Array<{ insert?: Row[] }>
const rows = document.flatMap((layer) => layer.insert ?? [])

/** Every row in a plugin list, including the children of a `cordis:group`. */
function flatten(list: readonly Row[]): Row[] {
  return list.flatMap((row) => [row, ...(Array.isArray(row.config) ? flatten(row.config as Row[]) : [])])
}

function rowById(id: string): Row | undefined {
  return rows.find((row) => row.id === id)
}

function presetOf(rowId: string): PresetConfig {
  const row = rowById(rowId)
  expect(row, rowId).toBeDefined()
  expect(row?.name).toBe('@deepseek-ai/dsh-agent-preset')
  return row?.config as PresetConfig
}

const replier = presetOf('dsh-whale-chan-replier-preset')
const worker = presetOf('dsh-whale-chan-worker-preset')

describe('host row', () => {
  it('still mounts the plugin itself without configuration', () => {
    const host = rowById('dsh-whale-chan-assistant')
    expect(host).toEqual({ id: 'dsh-whale-chan-assistant', name: 'dsh-whale-chan-assistant' })
  })

  it('declares no duplicate loader id', () => {
    const ids = rows.map((row) => row.id)
    expect(ids.every((id) => typeof id === 'string')).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('replier preset', () => {
  it('is the declaration the executor names', () => {
    expect(replier.id).toBe(REPLIER_PRESET)
    expect(replier.name).toBe('鲸鱼酱 · 回复器')
    expect(replier.order).toBe(90)
    expect(replier.description).toContain('不供手动选择')
  })

  it('carries persona, instructions, time, web and compaction', () => {
    const ids = replier.plugins.map((plugin) => plugin.id)
    expect(ids).toEqual(['persona', 'agent-instructions', 'time-context', 'tool-web', 'compaction'])
  })

  it('has no shell, filesystem, jobs, skill or todo plugin', () => {
    const names = flatten(replier.plugins).map((plugin) => plugin.name ?? '')
    for (const forbidden of ['dsh-bash-sandbox', 'dsh-pwsh-sandbox', 'dsh-tool-bash', 'dsh-tool-pwsh']) {
      expect(names).not.toContain(`@deepseek-ai/${forbidden}`)
    }
    for (const forbidden of [
      'dsh-tool-fs',
      'dsh-tool-fs-search',
      'dsh-tool-jobs',
      'dsh-tool-skill',
      'dsh-skill-filesystem',
    ]) {
      expect(names).not.toContain(`@deepseek-ai/${forbidden}`)
    }
    const ids = replier.plugins.map((plugin) => plugin.id)
    expect(ids).not.toContain('skill-filesystem')
    expect(ids).not.toContain('tool-skill')
    expect(ids).not.toContain('tool-todo')
  })

  it('uses a neutral persona prefix that cannot fight the dynamic persona', () => {
    const persona = replier.plugins.find((plugin) => plugin.id === 'persona')
    const config = persona?.config as { prefix?: string } | undefined
    expect(config?.prefix).toContain('动态人设')
    // The owner's name lives in settings and in the rendered persona block; a
    // hard-coded name here would contradict it after a rename.
    expect(config?.prefix).not.toContain('鲸鱼酱')
  })

  it('keeps web search enabled and fetch off', () => {
    const web = replier.plugins.find((plugin) => plugin.id === 'tool-web')
    expect(web?.name).toBe('@deepseek-ai/dsh-tool-web')
    expect(web?.config).toEqual({ fetch: false, searchTimeoutMs: 60000 })
  })
})

describe('worker preset', () => {
  it('is the declaration the executor names', () => {
    expect(worker.id).toBe(WORKER_PRESET)
    expect(worker.name).toBe('鲸鱼酱 · 任务执行器')
    expect(worker.order).toBe(91)
    expect(worker.description).toContain('不供手动选择')
  })

  it('carries the work tools a task needs', () => {
    const ids = worker.plugins.map((plugin) => plugin.id)
    expect(ids).toEqual([
      'persona',
      'agent-instructions',
      'time-context',
      'shell',
      'tool-fs',
      'tool-fs-search',
      'tool-jobs',
      'skill-filesystem',
      'tool-skill',
      'tool-web',
      'tool-todo',
      'compaction',
    ])
  })

  it('isolates the shell and platform-gates bash and pwsh', () => {
    const shell = worker.plugins.find((plugin) => plugin.id === 'shell')
    expect(shell?.name).toBe('cordis:group')
    expect(shell?.group).toBe(true)
    expect(shell?.isolate).toEqual({ shell: true })
    const children = shell?.config as Row[]
    const bash = children.find((child) => child.id === 'bash-sandbox')
    const pwsh = children.find((child) => child.id === 'pwsh-sandbox')
    expect(bash?.disabled).toContain("process.platform === 'win32'")
    expect(pwsh?.disabled).toContain("process.platform !== 'win32'")
    expect(bash?.config).toEqual({ timeoutMs: 5000, maxTimeoutMs: 5000 })
    expect(pwsh?.config).toEqual({ timeoutMs: 5000, maxTimeoutMs: 5000 })
  })

  it('uses a neutral persona prefix that cannot fight the dynamic persona', () => {
    const persona = worker.plugins.find((plugin) => plugin.id === 'persona')
    const config = persona?.config as { prefix?: string } | undefined
    expect(config?.prefix).toContain('动态人设')
    expect(config?.prefix).not.toContain('鲸鱼酱')
  })

  it('moves long job waits to the background after five seconds', () => {
    const jobs = worker.plugins.find((plugin) => plugin.id === 'tool-jobs')
    expect(jobs?.config).toEqual({ waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 })
  })

  it('keeps compaction isolated with its pruner', () => {
    const compaction = worker.plugins.find((plugin) => plugin.id === 'compaction')
    expect(compaction?.name).toBe('cordis:group')
    expect(compaction?.isolate).toEqual({ compaction: true, toolResultPruner: true })
    expect((compaction?.config as Row[]).map((child) => child.id)).toEqual([
      'compaction-basic',
      'command-compact',
      'tool-result-pruner',
    ])
  })
})

describe('patch hygiene', () => {
  const allPlugins = [...flatten(replier.plugins), ...flatten(worker.plugins)]

  it('names every plugin with a real package specifier or the group marker', () => {
    for (const plugin of allPlugins) {
      expect(typeof plugin.name, String(plugin.id)).toBe('string')
      expect(plugin.name, String(plugin.id)).toMatch(/^(?:cordis:group|@deepseek-ai\/dsh-[a-z0-9-]+)$/)
    }
  })

  it('declares every plugin id once', () => {
    const ids = replier.plugins.map((plugin) => plugin.id)
    expect(new Set(ids).size).toBe(ids.length)
    const workerIds = worker.plugins.map((plugin) => plugin.id)
    expect(new Set(workerIds).size).toBe(workerIds.length)
  })

  it('uses !!js only where the loader evaluates it, and keeps it as text here', () => {
    // The generic YAML parser has no `js` tag, so every `!!js` scalar arrives as
    // its source text. That is exactly what lets this test assert the guard.
    for (const plugin of allPlugins) {
      if (plugin.disabled === undefined) continue
      expect(typeof plugin.disabled).toBe('string')
      expect(String(plugin.disabled)).toContain('process.platform')
    }
    for (const plugin of allPlugins) {
      expect(JSON.stringify(plugin.config ?? {})).not.toContain('!!js')
    }
  })

  it('keeps both presets out of the manual picker by their own description', () => {
    expect(replier.description).not.toHaveLength(0)
    expect(worker.description).not.toHaveLength(0)
    expect(replier.description).not.toBe(worker.description)
  })
})
