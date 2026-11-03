/**
 * `DshResearch` behaviour: the mapping from a web answer to the brain's
 * `ResearchHit`, and the degradation the reply policy relies on.
 */
import { describe, expect, it } from 'vitest'
import { DshResearch, MAX_SOURCES, emptyHit, normalizeSearch } from '../src/executor/index.ts'
import { FakeWeb, RecordingLogger } from './fixtures/executor.ts'

function research(): { web: FakeWeb; port: DshResearch; logger: RecordingLogger } {
  const web = new FakeWeb()
  const logger = new RecordingLogger()
  return { web, port: new DshResearch({ web, logger }), logger }
}

describe('mapping', () => {
  it('turns the provider answer and snippets into facts and sources', async () => {
    const { web, port } = research()
    web.result = {
      content: '  今天的会议改到三点。  ',
      sources: [
        { url: 'https://a.example/notes', title: '会议纪要', snippet: '三点开始' },
        { url: 'http://b.example/x', snippet: '地点在二号会议室' },
      ],
    }
    const hit = await port.search('会议几点', { limit: 5, timeoutMs: 1_000 }, new AbortController().signal)
    expect(hit.facts).toEqual(['今天的会议改到三点。', '三点开始', '地点在二号会议室'])
    expect(hit.sources).toEqual([
      { title: '会议纪要', url: 'https://a.example/notes' },
      // A source without a title is labelled with its hostname, never the query.
      { title: 'b.example', url: 'http://b.example/x' },
    ])
    expect(web.requests).toEqual([{ query: '会议几点', maxResults: 5 }])
  })

  it('keeps only citeable http(s) sources and de-duplicates them', () => {
    const hit = normalizeSearch(
      {
        sources: [
          { url: 'https://a.example/1', title: 'A', snippet: '一' },
          { url: 'https://a.example/1', title: 'A again', snippet: '一' },
          { url: 'file:///etc/passwd', title: 'bad' },
          { url: 'javascript:alert(1)', title: 'bad' },
          { url: 'not a url', title: 'bad' },
        ],
      },
      5,
    )
    expect(hit.sources).toEqual([{ title: 'A', url: 'https://a.example/1' }])
    expect(hit.facts).toEqual(['一'])
  })

  it('bounds facts and sources by the requested limit', async () => {
    const { web, port } = research()
    web.result = {
      sources: Array.from({ length: 12 }, (_value, index) => ({
        url: `https://e.example/${index}`,
        title: `标题 ${index}`,
        snippet: `事实 ${index}`,
      })),
    }
    const hit = await port.search('q', { limit: 3, timeoutMs: 1_000 }, new AbortController().signal)
    expect(hit.sources).toHaveLength(3)
    expect(hit.facts).toHaveLength(3)
    expect(MAX_SOURCES).toBeGreaterThanOrEqual(3)
  })

  it('clips an over-long fact instead of dropping it', async () => {
    const { web, port } = research()
    web.result = { sources: [{ url: 'https://a.example/1', title: 'T', snippet: 'z'.repeat(1_000) }] }
    const hit = await port.search('q', { limit: 1, timeoutMs: 1_000 }, new AbortController().signal)
    expect(hit.facts[0]?.length).toBeLessThanOrEqual(400)
    expect(hit.facts[0]?.endsWith('…')).toBe(true)
  })
})

describe('degradation', () => {
  it('returns an empty hit for an empty answer', async () => {
    const { web, port } = research()
    web.result = { sources: [] }
    await expect(port.search('q', { limit: 5, timeoutMs: 1_000 }, new AbortController().signal)).resolves.toEqual(
      emptyHit(),
    )
  })

  it('returns an empty hit when the provider throws', async () => {
    const { web, port, logger } = research()
    web.error = new Error('provider down')
    await expect(port.search('q', { limit: 5, timeoutMs: 1_000 }, new AbortController().signal)).resolves.toEqual(
      emptyHit(),
    )
    expect(logger.lines.some((line) => line.includes('provider down'))).toBe(true)
  })

  it('returns an empty hit when the caller aborts', async () => {
    const { web, port } = research()
    web.hang = true
    const controller = new AbortController()
    controller.abort()
    await expect(port.search('q', { limit: 5, timeoutMs: 1_000 }, controller.signal)).resolves.toEqual(emptyHit())
  })

  it('returns an empty hit when the budget expires, without an unhandled rejection', async () => {
    const { web, port } = research()
    web.hang = true
    const hit = await port.search('q', { limit: 5, timeoutMs: 20 }, new AbortController().signal)
    expect(hit).toEqual(emptyHit())
  })

  it('does not call the provider for a blank query', async () => {
    const { web, port } = research()
    await expect(port.search('   ', { limit: 5, timeoutMs: 1_000 }, new AbortController().signal)).resolves.toEqual(
      emptyHit(),
    )
    expect(web.requests).toHaveLength(0)
  })

  it('survives a malformed result object', async () => {
    const { web, port } = research()
    web.result = { sources: undefined as unknown as [] }
    await expect(port.search('q', { limit: 5, timeoutMs: 1_000 }, new AbortController().signal)).resolves.toEqual(
      emptyHit(),
    )
  })
})
