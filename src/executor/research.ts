/**
 * `DshResearch`: the brain's `ResearchPort` over DSH's `ctx.web` capability.
 *
 * The brain owns the *policy* (whether to search, how many results, how long to
 * wait, how long to cache). This adapter only performs one query and normalizes
 * the answer into the brain's `ResearchHit`, so a provider change never reaches
 * the reply logic.
 *
 * Three rules make it safe to call from a reply path:
 *
 * - **It never throws.** A missing provider, a provider error, an aborted
 *   signal and an empty answer all return `{ facts: [], sources: [] }`. The
 *   brain then replies as if nothing was found, which is the documented
 *   degradation.
 * - **It never invents a citation.** Only absolute `http(s)` URLs survive, and a
 *   source without a title is labelled with its hostname instead of the query.
 * - **It is bounded.** The limit and the timeout come from the caller, and the
 *   deadline helper observes a rejection that arrives after the budget, so a
 *   slow provider cannot leave an unhandled rejection behind.
 */
import { withDeadline } from '../brain/deadline.ts'
import type { ResearchHit, ResearchPort, ResearchSearchOptions } from '../brain/types.ts'
import type { ExecutorLogger } from './types.ts'

/** Longest single fact handed to a prompt; longer snippets are clipped. */
export const MAX_FACT_CHARS = 400

/** Upper bound on sources, independent of what a caller asks for. */
export const MAX_SOURCES = 8

/** One citeable source as the web capability reports it. */
export interface WebSearchSourceLike {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
}

/** One normalized search outcome. */
export interface WebSearchResultLike {
  readonly content?: string
  readonly sources: readonly WebSearchSourceLike[]
  readonly truncated?: boolean
}

/** The `ctx.web.search` surface this adapter needs. */
export interface WebSearchLike {
  search(
    request: { readonly query: string; readonly maxResults?: number },
    signal?: AbortSignal,
  ): Promise<WebSearchResultLike>
}

export interface DshResearchOptions {
  readonly web: WebSearchLike
  readonly logger?: ExecutorLogger
}

/** The empty result every failure path returns. */
export function emptyHit(): ResearchHit {
  return { facts: [], sources: [] }
}

/** Trim and clip one candidate fact, dropping anything that is not text. */
function cleanFact(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text.length === 0) return ''
  return [...text].length <= MAX_FACT_CHARS ? text : `${[...text].slice(0, MAX_FACT_CHARS - 1).join('')}…`
}

/** Parse one absolute http(s) URL; anything else is not citeable. */
function citeable(url: unknown): URL | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.hostname.length === 0) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Normalize one provider answer.
 *
 * `content` (a provider-written summary) is the first fact, then each source's
 * snippet in provider order. Facts and sources are deduplicated and both are
 * bounded by `limit`, so a chatty provider cannot crowd the prompt.
 */
export function normalizeSearch(result: WebSearchResultLike, limit: number): ResearchHit {
  const boundedLimit = Math.max(1, Math.min(MAX_SOURCES, Math.trunc(limit)))
  const facts: string[] = []
  const seenFacts = new Set<string>()
  const sources: { title: string; url: string }[] = []
  const seenUrls = new Set<string>()

  const addFact = (candidate: unknown): void => {
    const fact = cleanFact(candidate)
    if (fact.length === 0 || seenFacts.has(fact) || facts.length >= boundedLimit) return
    seenFacts.add(fact)
    facts.push(fact)
  }

  addFact(result.content)
  for (const source of result.sources ?? []) {
    const parsed = citeable(source.url)
    if (parsed === undefined) continue
    const url = parsed.toString()
    if (!seenUrls.has(url)) {
      if (sources.length < boundedLimit) {
        seenUrls.add(url)
        const title = cleanFact(source.title)
        sources.push({ title: title.length === 0 ? parsed.hostname : title, url })
      }
    }
    addFact(source.snippet)
  }
  return { facts, sources }
}

/** `ResearchPort` over one web capability. */
export class DshResearch implements ResearchPort {
  private readonly web: WebSearchLike
  private readonly logger: ExecutorLogger | undefined

  constructor(options: DshResearchOptions) {
    this.web = options.web
    this.logger = options.logger
  }

  async search(query: string, options: ResearchSearchOptions, signal: AbortSignal): Promise<ResearchHit> {
    const text = typeof query === 'string' ? query.trim() : ''
    if (text.length === 0) return emptyHit()
    const limit = Math.max(1, Math.min(MAX_SOURCES, Math.trunc(options.limit) || 1))
    try {
      const outcome = await withDeadline(
        async (lifetime) => await this.web.search({ query: text, maxResults: limit }, lifetime),
        signal,
        options.timeoutMs,
      )
      if (!outcome.ok) {
        // `aborted` is the caller's own cancellation and needs no warning; a
        // missing provider or a timeout is worth one line in the log.
        if (outcome.reason !== 'aborted') {
          this.logger?.warn?.(
            `dsh-whale-chan: retrieval ${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''}`,
          )
        }
        return emptyHit()
      }
      return normalizeSearch(outcome.value, limit)
    } catch (error) {
      // `withDeadline` contains port rejections, so this is a last resort for a
      // provider whose result object is malformed.
      this.logger?.warn?.(`dsh-whale-chan: retrieval failed: ${describe(error)}`)
      return emptyHit()
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200)
  return String(error).slice(0, 200)
}
