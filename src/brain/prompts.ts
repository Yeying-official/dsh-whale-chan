/**
 * Prompt templates: loading, caching and variable substitution.
 *
 * Templates ship in `<package>/prompts/*.md` and are read once per process.
 * A missing or empty file is a fatal configuration error: the brain must not
 * invent instructions for an assistant that speaks as its owner, so
 * `PromptStore.get` throws instead of falling back to a generic prompt.
 *
 * The packaged layout is `<package>/lib/index.js` next to `<package>/prompts`,
 * while tests run from `src/brain/*.ts` next to `<repo>/prompts`. Both are
 * tried, in that order, and the first existing directory wins; when neither
 * exists the store still points at the packaged location so the error names the
 * path an operator has to fix.
 */
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { stripComments } from './format.ts'
import type { PromptName, PromptSource, PromptVars } from './types.ts'
import { PROMPT_NAMES } from './types.ts'

/** Directories tried for the shipped templates, relative to the importing module. */
export const PROMPT_DIR_CANDIDATES = ['../prompts', '../../prompts'] as const

/** The directory templates are loaded from when the caller does not name one. */
export function defaultPromptDir(importerUrl: string | URL = import.meta.url): URL {
  const base = String(importerUrl)
  for (const candidate of PROMPT_DIR_CANDIDATES) {
    const url = new URL(candidate, base)
    if (existsSync(url)) return resolvePromptDir(url)
  }
  return resolvePromptDir(new URL(PROMPT_DIR_CANDIDATES[0], base))
}

/** Normalize a directory reference into a URL that ends with a slash. */
export function resolvePromptDir(dir: URL | string): URL {
  const url = typeof dir === 'string' ? pathToFileURL(dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}/`) : dir
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`)
}

export type PromptLoadFailure = 'missing' | 'empty' | 'unreadable'

/** A template could not be loaded; the brain refuses to run without it. */
export class PromptLoadError extends Error {
  readonly code = 'prompt_load_failed' as const

  constructor(
    readonly reason: PromptLoadFailure,
    readonly prompt: PromptName,
    readonly path: string,
    readonly cause?: unknown,
  ) {
    const suffix =
      reason === 'missing'
        ? 'is missing; run `pnpm build` from the package root, or ship prompts/ with the plugin'
        : reason === 'empty'
          ? 'is empty; every prompt template must carry instructions'
          : 'could not be read; check the file permissions'
    super(`Prompt template ${path} ${suffix}`)
    this.name = 'PromptLoadError'
  }
}

/** A `{{variable}}` was not supplied; a typo must fail loudly, not reach the model. */
export class PromptRenderError extends Error {
  readonly code = 'prompt_render_failed' as const

  constructor(readonly variables: readonly string[]) {
    super(`Unknown prompt variable(s): ${variables.join(', ')}`)
    this.name = 'PromptRenderError'
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu

function stringify(value: PromptVars[string]): string {
  if (Array.isArray(value)) return value.join('\n')
  return String(value)
}

/**
 * Replace `{{name}}` placeholders in one pass.
 *
 * Replacement text is never rescanned, so a value that itself contains braces
 * cannot inject a second substitution. An unknown placeholder throws: silently
 * leaving `{{task}}` in a system prompt would teach the model to emit template
 * syntax in a reply.
 */
export function render(template: string, vars: PromptVars): string {
  const unknown = new Set<string>()
  const rendered = template.replace(PLACEHOLDER, (match, name: string) => {
    if (!Object.hasOwn(vars, name)) {
      unknown.add(name)
      return match
    }
    return stringify(vars[name] as PromptVars[string])
  })
  if (unknown.size > 0) throw new PromptRenderError([...unknown].sort())
  return rendered
}

export interface PromptStoreOptions {
  /** Directory holding the five `.md` templates; defaults to the packaged `prompts/`. */
  readonly dir?: URL | string
}

/**
 * Loads and caches the five prompt templates.
 *
 * `get` is synchronous and cached, so a classifier call costs one map lookup
 * after the first message. HTML comments are stripped, which lets a template
 * document its variables without sending that documentation to the model.
 */
export class PromptStore implements PromptSource {
  private readonly directory: URL
  private readonly cache = new Map<PromptName, string>()

  constructor(options: PromptStoreOptions = {}) {
    this.directory = resolvePromptDir(options.dir ?? defaultPromptDir())
  }

  /** The directory this store reads from, for diagnostics. */
  dir(): string {
    return this.directory.href
  }

  get(name: PromptName): string {
    const cached = this.cache.get(name)
    if (cached !== undefined) return cached
    const path = new URL(`./${name}.md`, this.directory)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      const missing = typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
      throw new PromptLoadError(missing ? 'missing' : 'unreadable', name, path.pathname, error)
    }
    const text = stripComments(raw.replace(/^\uFEFF/u, '')).trim()
    if (text.length === 0) throw new PromptLoadError('empty', name, path.pathname)
    this.cache.set(name, text)
    return text
  }

  /** Read every template once, which surfaces a broken package before any message arrives. */
  preload(): Record<PromptName, string> {
    return Object.fromEntries(PROMPT_NAMES.map((name) => [name, this.get(name)])) as Record<PromptName, string>
  }

  /** Drop cached text, for a reload after an operator edits the templates. */
  reload(name?: PromptName): void {
    if (name === undefined) this.cache.clear()
    else this.cache.delete(name)
  }
}

let shared: PromptStore | undefined

/** The process-wide store, created on first use so importing the brain never touches the disk. */
export function defaultPromptStore(): PromptStore {
  shared ??= new PromptStore()
  return shared
}

/** Drop the process-wide store; tests use this after changing the working directory. */
export function resetDefaultPromptStore(): void {
  shared = undefined
}
