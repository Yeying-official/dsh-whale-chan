import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESEARCH_TIMEOUT_MS,
  EMPTY_MARKER,
  MAX_FACT_CHARS,
  ResearchCache,
  dedupeFacts,
  normalizeSources,
  renderResearchGuide,
  research,
  researchTimeoutMs,
} from '../src/brain/research.ts'
import type { ResearchSettings } from '../src/shared/settings.ts'
import { hangingResearch, makeSettings, shippedPromptStore, stubResearch } from './fixtures/brain.ts'

const signal = () => new AbortController().signal

function settings(overrides: Partial<ResearchSettings> = {}): ResearchSettings {
  return makeSettings({ research: overrides }).research
}

describe('research budgeting', () => {
  it('passes the owner budget to the port and returns its result', async () => {
    const port = stubResearch({
      facts: ['会议在 10:00 开始'],
      sources: [{ title: '日程页', url: 'https://example.com/schedule' }],
    })
    // 2000ms is floored to the retrieval minimum: a cold provider round trip is
    // slower than that, and cutting it short only yields deferrals.
    const result = await research('明天几点的会', settings({ maxResults: 3, timeoutMs: 2000 }), port, signal())
    expect(port.calls).toEqual([{ query: '明天几点的会', options: { limit: 3, timeoutMs: 30_000 } }])
    expect(result).toMatchObject({ degraded: false, cached: false, includeCitations: true })
    expect(result.facts).toEqual(['会议在 10:00 开始'])
    expect(result.sources).toEqual([{ title: '日程页', url: 'https://example.com/schedule' }])
  })

  it('floors the retrieval budget at 30s and lets an explicit override win', () => {
    expect(DEFAULT_RESEARCH_TIMEOUT_MS).toBe(30_000)
    expect(researchTimeoutMs({ timeoutMs: 1_000 })).toBe(30_000)
    expect(researchTimeoutMs({ timeoutMs: 8_000 })).toBe(30_000)
    expect(researchTimeoutMs({ timeoutMs: 45_000 })).toBe(45_000)
    expect(researchTimeoutMs({ timeoutMs: 8_000 }, 250)).toBe(250)
  })

  it('keeps at most maxResults facts and clips each one', async () => {
    const facts = Array.from({ length: 10 }, (_, index) => `事实 ${index + 1} ${'很长的内容'.repeat(100)}`)
    const port = stubResearch({ facts, sources: [] })
    const result = await research('问题', settings({ maxResults: 3 }), port, signal())
    expect(result.facts).toHaveLength(3)
    for (const fact of result.facts) expect([...fact].length).toBeLessThanOrEqual(MAX_FACT_CHARS)
  })

  it('deduplicates facts that differ only in spacing or case', async () => {
    const port = stubResearch({ facts: ['Meeting at 10', ' meeting   at 10 ', '另一个事实'], sources: [] })
    const result = await research('问题', settings(), port, signal())
    expect(result.facts).toEqual(['Meeting at 10', '另一个事实'])
  })

  it('keeps only http(s) sources, deduplicated and with a usable title', async () => {
    const port = stubResearch({
      facts: ['事实'],
      sources: [
        { title: 'A', url: 'https://example.com' },
        { title: 'A again', url: 'https://example.com/' },
        { title: '脚本', url: 'javascript:alert(1)' },
        { title: '本地', url: 'file:///etc/passwd' },
        { title: '', url: 'https://docs.example.com/page' },
      ],
    })
    const result = await research('问题', settings(), port, signal())
    expect(result.sources).toEqual([
      { title: 'A', url: 'https://example.com/' },
      { title: 'docs.example.com', url: 'https://docs.example.com/page' },
    ])
  })

  it('reports an empty answer as degraded', async () => {
    const port = stubResearch({ facts: [], sources: [] })
    const result = await research('问题', settings(), port, signal())
    expect(result).toMatchObject({ degraded: true, reason: 'empty', facts: [], sources: [] })
  })

  it('does not call the port when research is disabled', async () => {
    const port = stubResearch({ facts: ['x'], sources: [] })
    const result = await research('问题', settings({ enabled: false }), port, signal())
    expect(port.calls).toHaveLength(0)
    expect(result).toMatchObject({ degraded: true, reason: 'disabled' })
  })

  it('treats a blank query as degraded without a search', async () => {
    const port = stubResearch({ facts: ['x'], sources: [] })
    const result = await research('   ', settings(), port, signal())
    expect(port.calls).toHaveLength(0)
    expect(result).toMatchObject({ degraded: true, reason: 'empty' })
  })

  it('reports a timeout and a failing port as degraded', async () => {
    const timedOut = await research('问题', settings(), hangingResearch(), signal(), { timeoutMs: 20 })
    expect(timedOut).toMatchObject({ degraded: true, reason: 'timeout' })

    const failed = await research(
      '问题',
      settings(),
      stubResearch(async () => {
        throw new Error('provider down')
      }),
      signal(),
    )
    expect(failed).toMatchObject({ degraded: true, reason: 'error' })
  })

  it('stops the port at the configured timeout even if the port ignores its signal', async () => {
    let closed = false
    const port = {
      async search() {
        return await new Promise<never>((_, reject) => {
          setTimeout(() => {
            closed = true
            reject(new Error('late failure'))
          }, 50)
        })
      },
    }
    const result = await research('问题', settings(), port, signal(), { timeoutMs: 10 })
    expect(result).toMatchObject({ degraded: true, reason: 'timeout' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(closed).toBe(true)
  })
})

describe('research cache', () => {
  it('reuses a hit inside cacheMinutes and labels it cached', async () => {
    const cache = new ResearchCache()
    const port = stubResearch({ facts: ['事实'], sources: [] })
    let now = 1_000
    const first = await research('问题', settings({ cacheMinutes: 30 }), port, signal(), { cache, now: () => now })
    now += 60_000
    const second = await research('问题', settings({ cacheMinutes: 30 }), port, signal(), { cache, now: () => now })
    expect(port.calls).toHaveLength(1)
    expect(first.cached).toBe(false)
    expect(second).toMatchObject({ cached: true, degraded: false })
    expect(second.facts).toEqual(['事实'])
  })

  it('misses once the entry is older than cacheMinutes', async () => {
    const cache = new ResearchCache()
    const port = stubResearch({ facts: ['事实'], sources: [] })
    let now = 0
    await research('问题', settings({ cacheMinutes: 1 }), port, signal(), { cache, now: () => now })
    now += 61_000
    const second = await research('问题', settings({ cacheMinutes: 1 }), port, signal(), { cache, now: () => now })
    expect(port.calls).toHaveLength(2)
    expect(second.cached).toBe(false)
  })

  it('does not cache when cacheMinutes is 0', async () => {
    const cache = new ResearchCache()
    const port = stubResearch({ facts: ['事实'], sources: [] })
    await research('问题', settings({ cacheMinutes: 0 }), port, signal(), { cache, now: () => 0 })
    await research('问题', settings({ cacheMinutes: 0 }), port, signal(), { cache, now: () => 0 })
    expect(port.calls).toHaveLength(2)
    expect(cache.size()).toBe(0)
  })

  it('does not cache a degraded call, so an outage is not remembered', async () => {
    const cache = new ResearchCache()
    const port = stubResearch(async () => {
      throw new Error('down')
    })
    await research('问题', settings(), port, signal(), { cache, now: () => 0 })
    await research('问题', settings(), port, signal(), { cache, now: () => 0 })
    expect(port.calls).toHaveLength(2)
  })
})

describe('research helpers', () => {
  it('bounds the fact list and deduplicates sources before prompting', () => {
    expect(dedupeFacts([' a ', 'A', '', 'b'], 5)).toEqual(['a', 'b'])
    expect(normalizeSources([{ title: 'A', url: 'https://a.example' }], 1)).toHaveLength(1)
    expect(dedupeFacts(['x'], 0)).toEqual([])
  })

  it('renders the retrieval guide with the data it was given', () => {
    const guide = renderResearchGuide(shippedPromptStore(), {
      facts: ['会议在 10:00 开始'],
      sources: [{ title: '日程页', url: 'https://example.com/schedule' }],
    })
    expect(guide).toContain('- 会议在 10:00 开始')
    expect(guide).toContain('- 日程页：https://example.com/schedule')
    expect(guide).toContain('不要自己拼造 URL')
  })

  it('marks an empty retrieval explicitly instead of leaving a blank prompt', () => {
    const guide = renderResearchGuide(shippedPromptStore(), { facts: [], sources: [] })
    expect(guide).toContain(EMPTY_MARKER)
    expect(guide).not.toContain('{{facts}}')
  })
})
