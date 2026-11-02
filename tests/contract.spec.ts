import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_PREFIX, API_ROUTES, apiUrl, type ApiRoute } from '../src/shared/api.ts'
import { FIELDS } from '../src/shared/fields.ts'
import { PANEL_ID, PLUGIN_DISPLAY_NAME, PLUGIN_NAME, PLUGIN_VERSION } from '../src/shared/limits.ts'
import { SETTINGS_BLOCKS, SETTINGS_DEFAULTS, SettingsSchema } from '../src/shared/settings.ts'

type Shape = Record<string, unknown>

/** Find the object shape under zero or more Zod default wrappers. */
function shapeOf(schema: unknown): Shape | undefined {
  let current = schema as { shape?: unknown; unwrap?: () => unknown; _def?: { type?: string } } | undefined
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current.shape && typeof current.shape === 'object') return current.shape as Shape
    if (current._def?.type !== 'default' || typeof current.unwrap !== 'function') break
    current = current.unwrap() as typeof current
  }
  return undefined
}

function leafPaths(schema: unknown, prefix: string): string[] {
  const shape = shapeOf(schema)
  if (!shape) return [prefix]
  return Object.entries(shape).flatMap(([key, child]) => leafPaths(child, `${prefix}.${key}`))
}

function valueAt(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (typeof value !== 'object' || value === null) return undefined
    return (value as Record<string, unknown>)[key]
  }, root)
}

const rootShape = shapeOf(SettingsSchema)
if (!rootShape) throw new Error('SettingsSchema must be a Zod object')

const schemaPaths = SETTINGS_BLOCKS.flatMap((block) => leafPaths(rootShape[block], block)).sort()
const fieldPaths = FIELDS.map((field) => `${field.block}.${field.path}`).sort()

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join('locale', `${name}.json`), 'utf8')) as Record<string, unknown>
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

/** Every import specifier of one source: `from`, dynamic and side-effect imports. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  )
}

describe('settings schema and field registry', () => {
  it('covers exactly the same leaf paths in both directions', () => {
    expect(schemaPaths).toEqual(fieldPaths)
    expect(new Set(schemaPaths).size).toBe(schemaPaths.length)
  })

  it('declares one field per block and only known blocks', () => {
    for (const block of SETTINGS_BLOCKS) {
      expect(FIELDS.some((field) => field.block === block)).toBe(true)
      expect(Object.keys(rootShape)).toContain(block)
    }
    for (const field of FIELDS) {
      expect(SETTINGS_BLOCKS).toContain(field.block)
      expect(field.path).not.toHaveLength(0)
    }
  })

  it('mirrors every schema default in the field registry', () => {
    for (const field of FIELDS) {
      expect(valueAt(SETTINGS_DEFAULTS, `${field.block}.${field.path}`)).toEqual(field.defaultValue)
    }
    expect(SettingsSchema.parse({})).toEqual(SETTINGS_DEFAULTS)
  })

  it('gives every label and hint key a unique, non-empty translation in both locales', () => {
    const zh = readJson('zh')
    const en = readJson('en')
    const zhKeys = Object.keys(zh)
      .filter((key) => key !== 'meta')
      .sort()
    const enKeys = Object.keys(en)
      .filter((key) => key !== 'meta')
      .sort()
    expect(zhKeys).toEqual(enKeys)
    for (const field of FIELDS) {
      for (const key of [field.labelKey, field.hintKey]) {
        expect(zh[key], `zh:${key}`).toEqual(expect.any(String))
        expect(en[key], `en:${key}`).toEqual(expect.any(String))
        expect(String(zh[key])).not.toHaveLength(0)
        expect(String(en[key])).not.toHaveLength(0)
        expect(String(zh[key])).not.toMatch(/TODO|FIXME/)
        expect(String(en[key])).not.toMatch(/TODO|FIXME/)
      }
    }
    for (const block of SETTINGS_BLOCKS) {
      const key = `settings.block.${block}.label`
      expect(zh[key], `zh:${key}`).toEqual(expect.any(String))
      expect(en[key], `en:${key}`).toEqual(expect.any(String))
    }
    expect((zh.meta as Record<string, unknown>).title).toBe(PLUGIN_DISPLAY_NAME)
    expect((en.meta as Record<string, unknown>).title).toEqual(expect.any(String))
    expect(zh['overview.title']).toEqual(expect.any(String))
    expect(en['overview.errorOffline']).toEqual(expect.any(String))
  })
})

describe('management API contract', () => {
  const expectedRoutes: readonly ApiRoute[] = [
    'GET state',
    'GET overview',
    'GET targets',
    'POST targets/discover',
    'POST targets/validate',
    'GET threads',
    'GET threads/:key',
    'GET tasks',
    'GET tasks/:id',
    'POST tasks/:id/approve',
    'POST tasks/:id/reject',
    'POST tasks/:id/cancel',
    'POST tasks/:id/retry',
    'GET settings',
    'PUT settings/:block',
    'GET persona',
    'GET health',
    'POST monitor/pause',
    'GET audit',
  ]

  it('declares every endpoint exactly once', () => {
    expect(API_ROUTES.map((route) => route.key).sort()).toEqual([...expectedRoutes].sort())
    expect(new Set(API_ROUTES.map((route) => route.key)).size).toBe(API_ROUTES.length)
    expect(new Set(API_ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(API_ROUTES.length)
    expect(API_ROUTES).toHaveLength(19)
  })

  it('uses the frozen prefix and consistent HTTP methods', () => {
    expect(API_PREFIX).toBe('/whale-chan/api/')
    for (const route of API_ROUTES) {
      expect(route.method).toMatch(/^(?:GET|POST|PUT)$/)
      expect(route.path.startsWith('/')).toBe(false)
      expect(route.key.startsWith(`${route.method} `)).toBe(true)
    }
  })

  it('builds encoded URLs and leaves the frozen prefix intact', () => {
    expect(apiUrl('GET state')).toBe('/whale-chan/api/state')
    expect(apiUrl('GET threads/:key', { key: 'a b/c' })).toBe('/whale-chan/api/threads/a%20b%2Fc')
    expect(apiUrl('GET tasks/:id', { id: 'task-1' })).toBe('/whale-chan/api/tasks/task-1')
    expect(apiUrl('PUT settings/:block', { block: 'monitor' })).toBe('/whale-chan/api/settings/monitor')
    expect(() => apiUrl('GET threads/:key')).toThrow(/Missing API path parameter/)
    for (const route of API_ROUTES) {
      expect(apiUrl(route.key, { key: 'k', id: 'id', block: 'monitor' })).toMatch(/^\/whale-chan\/api\//)
    }
  })
})

describe('repository and layer invariants', () => {
  it('keeps core free of I/O and of every other project layer', () => {
    // WS0 could assert that `src/core/index.ts` had no imports at all. WS1 makes
    // core a real domain layer: files may import their own siblings and the pure
    // types of `src/shared`, but never a Node built-in, a DSH service, or an
    // app/channel/executor/client module, and never `require`.
    const files = sourceFiles('src/core')
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/\brequire\s*\(/)
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, file).not.toMatch(/^node:/)
        expect(specifier, file).not.toMatch(/^@deepseek-ai\//)
        expect(specifier, file).not.toMatch(/^\.\.\/(?:app|channel|executor|client)(?:\/|$)/)
        expect(specifier, file).toMatch(/^(?:\.\/|\.\.\/shared\/)/)
      }
    }
    for (const file of sourceFiles('src/shared')) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from\s+['"]node:/)
      expect(source, file).not.toMatch(/require\(['"]node:/)
    }
  })

  it('keeps the client away from host implementation layers', () => {
    const forbidden = ['../app/', '../channel/', '../sender/', '../executor/', '../core/']
    for (const file of sourceFiles('src/client')) {
      const source = readFileSync(file, 'utf8')
      for (const target of forbidden) expect(source, file).not.toContain(target)
      expect(source, file).not.toMatch(/from\s+['"]@deepseek-ai\/dsh-(?:agent|session|host-webserver|settings)['"]/)
      expect(source, file).not.toMatch(/from\s+['"]node:/)
      expect(source, file).not.toContain('/whale-chan/api/')
    }
    expect(readFileSync('src/client/index.tsx', 'utf8')).toContain("import { PANEL_ID } from '../shared/limits.ts'")
    expect(readFileSync('src/client/api.ts', 'utf8')).toContain("apiUrl('GET state')")
  })

  it('keeps package metadata and the frozen constants aligned', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>
    expect(manifest.name).toBe(PLUGIN_NAME)
    expect(manifest.version).toBe(PLUGIN_VERSION)
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.icon).toBe('assets/icon.svg')
    expect(manifest.engines).toEqual({ node: '^22.19.0 || >=24.0.0', dsh: '^0.2.1-rc.5' })
    const dsh = manifest.dsh as Record<string, unknown>
    expect(dsh.manifestVersion).toBe(1)
    expect(dsh.compatibility).toEqual({ dshReleases: { '0.2.1-rc.5': 'compatible' } })
    expect((dsh.client as Record<string, unknown>).platform).toBe('web')
    expect(manifest.files).toEqual(
      expect.arrayContaining(['lib', 'assets', 'prompts', 'locale/*.json', 'cordis.patch.yml', 'README.md', 'LICENSE']),
    )
    expect(PANEL_ID).toBe('whale-chan')
  })

  it('keeps every field in the generated settings document', () => {
    const doc = readFileSync('docs/011-settings-contract.md', 'utf8')
    for (const field of FIELDS) expect(doc).toContain(`\`${field.block}.${field.path}\``)
    expect(doc).toContain('tests/contract.spec.ts')
    expect(doc).toContain('tests/settings.spec.ts')
  })

  it('ships all 14 design documents', () => {
    const names = [
      '000-philosophy.md',
      '001-domain.md',
      '002-authorization.md',
      '003-execution.md',
      '004-prompts.md',
      '005-panel.md',
      '006-deployment.md',
      '007-architecture.md',
      '008-cookbook.md',
      '009-dws-protocol.md',
      '010-design.md',
      '011-settings-contract.md',
      '012-release.md',
      '013-security.md',
    ]
    for (const name of names) {
      const source = readFileSync(join('docs', name), 'utf8')
      expect(source.length, name).toBeGreaterThan(40)
    }
  })
})
