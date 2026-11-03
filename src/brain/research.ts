/**
 * Bounds one retrieval call and turns its output into something safe to prompt with.
 *
 * The brain does not search the web itself: `ResearchPort` owns the network, the
 * provider and its credentials. What this module adds is the policy the owner
 * set — how many results, how long to wait, how long to cache — plus the
 * clean-up a model prompt needs: deduplicated facts, a fact length cap, and
 * sources restricted to well-formed http(s) URLs so a reply cannot cite
 * something retrieval never saw.
 *
 * A disabled search, a timeout, a throwing port and an empty answer all produce
 * the same degraded result with `facts: []`. The caller then replies as if
 * nothing was found, which is the behaviour the design asks for.
 */
import { withDeadline } from './deadline.ts'
import { bulletList, clip, normalizeWhitespace } from './format.ts'
import { render } from './prompts.ts'
import type {
  ResearchHit,
  ResearchPort,
  ResearchResult,
  ResearchSource,
  ResearchFailureReason,
  PromptSource,
} from './types.ts'

/** Longest single fact kept in a prompt. */
export const MAX_FACT_CHARS = 400

/** Placeholder shown to the model when a list is empty. */
export const EMPTY_MARKER = '（无）'

/** A small LRU over successful lookups, bounded by entry count and by `cacheMinutes`. */
export class ResearchCache {
  private readonly entries = new Map<string, { hit: ResearchHit; storedAt: number }>()

  constructor(private readonly maxEntries = 100) {}

  get(key: string, at: number, ttlMs: number): ResearchHit | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (ttlMs <= 0 || at - entry.storedAt >= ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh insertion order so the least recently used key is evicted first.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.hit
  }

  set(key: string, hit: ResearchHit, at: number): void {
    if (this.maxEntries <= 0) return
    this.entries.delete(key)
    this.entries.set(key, { hit: structuredClone(hit), storedAt: at })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Keep at most `limit` non-empty, non-repeated facts, each bounded in length. */
export function dedupeFacts(facts: readonly string[], limit: number): string[] {
  if (limit <= 0) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const fact of facts) {
    if (typeof fact !== 'string') continue
    const text = clip(normalizeWhitespace(fact), MAX_FACT_CHARS)
    if (text.length === 0) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

/**
 * Keep only http(s) sources with a usable title, deduplicated by normalized URL.
 *
 * `new URL` normalization is deliberate: `https://example.com` and
 * `https://example.com/` are the same page, and a reply should cite it once.
 */
export function normalizeSources(sources: readonly { title: string; url: string }[], limit: number): ResearchSource[] {
  if (limit <= 0) return []
  const seen = new Set<string>()
  const result: ResearchSource[] = []
  for (const source of sources) {
    if (!source || typeof source.url !== 'string') continue
    let parsed: URL
    try {
      parsed = new URL(source.url.trim())
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    if (seen.has(parsed.href)) continue
    seen.add(parsed.href)
    result.push({ title: normalizeWhitespace(source.title ?? '') || parsed.hostname, url: parsed.href })
    if (result.length >= limit) break
  }
  return result
}

export interface ResearchOptions {
  /** Cache to consult; omitting it disables caching for this call. */
  readonly cache?: ResearchCache
  /** Injected clock in epoch milliseconds. */
  readonly now?: () => number
}

function degradedResult(
  query: string,
  reason: ResearchFailureReason,
  includeCitations: boolean,
  cached = false,
): ResearchResult {
  return { query, facts: [], sources: [], degraded: true, cached, includeCitations, reason }
}

function buildResult(query: string, hit: ResearchHit, includeCitations: boolean, cached: boolean): ResearchResult {
  const facts = hit.facts
  const sources = hit.sources
  const degraded = facts.length === 0 && sources.length === 0
  return {
    query,
    facts,
    sources,
    degraded,
    cached,
    includeCitations,
    ...(degraded ? { reason: 'empty' as const } : {}),
  }
}

/**
 * Research one question under the owner's budget.
 *
 * `settings.cacheMinutes = 0` disables the cache. Failures are not cached, so a
 * transient outage does not keep answering "no facts" for half an hour; an empty
 * success is cached, because the provider really did answer with nothing.
 */
export async function research(
  query: string,
  settings: {
    readonly enabled: boolean
    readonly maxResults: number
    readonly timeoutMs: number
    readonly includeCitations: boolean
    readonly cacheMinutes: number
  },
  port: ResearchPort,
  signal: AbortSignal,
  options: ResearchOptions = {},
): Promise<ResearchResult> {
  const normalizedQuery = normalizeWhitespace(query)
  const includeCitations = settings.includeCitations
  if (!settings.enabled) return degradedResult(normalizedQuery, 'disabled', includeCitations)
  if (normalizedQuery.length === 0) return degradedResult(normalizedQuery, 'empty', includeCitations)

  const at = options.now?.() ?? Date.now()
  const ttlMs = settings.cacheMinutes * 60_000
  const cache = options.cache
  const cacheKey = `${settings.maxResults}\u0000${normalizedQuery}`

  if (cache && ttlMs > 0) {
    const hit = cache.get(cacheKey, at, ttlMs)
    if (hit) return buildResult(normalizedQuery, hit, includeCitations, true)
  }

  const outcome = await withDeadline(
    (inner) => port.search(normalizedQuery, { limit: settings.maxResults, timeoutMs: settings.timeoutMs }, inner),
    signal,
    settings.timeoutMs,
  )
  if (!outcome.ok) {
    const reason: ResearchFailureReason =
      outcome.reason === 'aborted' ? 'aborted' : outcome.reason === 'timeout' ? 'timeout' : 'error'
    return degradedResult(normalizedQuery, reason, includeCitations)
  }

  const hit: ResearchHit = {
    facts: dedupeFacts(Array.isArray(outcome.value?.facts) ? outcome.value.facts : [], settings.maxResults),
    sources: normalizeSources(Array.isArray(outcome.value?.sources) ? outcome.value.sources : [], settings.maxResults),
  }
  if (cache && ttlMs > 0) cache.set(cacheKey, hit, at)
  return buildResult(normalizedQuery, hit, includeCitations, false)
}

/**
 * Render the retrieval block a reply prompt embeds.
 *
 * It is a usage guide, not a search instruction: retrieval has already happened
 * through the port, and what the model needs is the facts, the vouched URLs and
 * the rule that neither may be invented.
 */
export function renderResearchGuide(
  prompts: PromptSource,
  data: { facts: readonly string[]; sources: readonly ResearchSource[] },
): string {
  const facts = data.facts.length > 0 ? bulletList(data.facts) : EMPTY_MARKER
  const sources =
    data.sources.length > 0 ? bulletList(data.sources.map((source) => `${source.title}：${source.url}`)) : EMPTY_MARKER
  return render(prompts.get('research'), { facts, sources })
}
