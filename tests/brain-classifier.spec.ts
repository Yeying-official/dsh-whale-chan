import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  DEFAULT_MIN_CONFIDENCE,
  classify,
  extractJsonObject,
  parseClassification,
} from '../src/brain/classifier.ts'
import type { ClassifySuccess } from '../src/brain/types.ts'
import { makeMessage, makePersona, shippedPromptStore, stubModel, hangingModel } from './fixtures/brain.ts'

const persona = makePersona({ name: '鲸鱼酱', tone: '简短' })
const prompts = shippedPromptStore()
const message = makeMessage({
  text: '@鲸鱼酱 明天几点的会？',
  kind: 'at-me',
  conversationType: 'group',
  addressed: true,
})
const threadWindow = [
  { author: '小明', text: '早', self: false },
  { author: '鲸鱼酱', text: '早呀', self: true },
]

function json(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

async function run(answer: string, options: { minConfidence?: number; timeoutMs?: number } = {}) {
  const model = stubModel(answer)
  const result = await classify(
    { message, threadWindow, persona, model, options: { prompts, ...options } },
    new AbortController().signal,
  )
  return { model, result }
}

describe('extractJsonObject', () => {
  it('reads a bare object, a fenced object and an object inside prose', () => {
    expect(extractJsonObject('{"intent":"chat"}')).toEqual({ intent: 'chat' })
    expect(extractJsonObject('好的：\n```json\n{"intent":"chat"}\n```\n完毕')).toEqual({ intent: 'chat' })
    expect(extractJsonObject('判断如下 {"intent":"chat","confidence":0.8} 以上')).toEqual({
      intent: 'chat',
      confidence: 0.8,
    })
  })

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonObject('我觉得是 chat')).toBeNull()
    expect(extractJsonObject('{not json}')).toBeNull()
  })
})

describe('parseClassification', () => {
  it('normalizes a task with a title', () => {
    const parsed = parseClassification(
      json({
        intent: 'task',
        confidence: 0.9,
        reason: '要主人做事',
        need_search: false,
        task: { title: '  订会议室 ', requirements: [' 10 点开始 ', ''] },
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.task).toEqual({ title: '订会议室', brief: '', requirements: ['10 点开始'] })
  })

  it('refuses a task without a title', () => {
    const parsed = parseClassification(
      json({ intent: 'task', confidence: 0.9, reason: '做事', need_search: false, task: { title: '   ' } }),
    )
    expect(parsed).toMatchObject({ ok: false, detail: expect.stringContaining('title') })
  })

  it('refuses a task without the task object', () => {
    const parsed = parseClassification(json({ intent: 'task', confidence: 0.9, reason: '做事', need_search: false }))
    expect(parsed.ok).toBe(false)
  })

  it('forces need_search to false outside question', () => {
    for (const intent of ['chat', 'task', 'ignore']) {
      const extra = intent === 'task' ? { task: { title: '订会议室' } } : {}
      const parsed = parseClassification(json({ intent, confidence: 0.8, reason: 'x', need_search: true, ...extra }))
      expect(parsed.ok, intent).toBe(true)
      if (parsed.ok) expect(parsed.value.needSearch, intent).toBe(false)
    }
  })

  it('keeps need_search for a question', () => {
    const parsed = parseClassification(
      json({ intent: 'question', confidence: 0.8, reason: '问事实', need_search: true }),
    )
    expect(parsed.ok && parsed.value.needSearch).toBe(true)
  })

  it('drops a task field that belongs to a non-task intent', () => {
    const parsed = parseClassification(
      json({ intent: 'chat', confidence: 0.8, reason: '闲聊', need_search: false, task: { title: '多写的' } }),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.task).toBeNull()
  })

  it('refuses unknown fields and out-of-range confidence', () => {
    expect(
      parseClassification(json({ intent: 'chat', confidence: 0.8, reason: '', need_search: false, extra: 1 })).ok,
    ).toBe(false)
    expect(parseClassification(json({ intent: 'chat', confidence: 1.4, reason: '', need_search: false })).ok).toBe(
      false,
    )
    expect(parseClassification(json({ intent: 'unknown', confidence: 0.8, reason: '', need_search: false })).ok).toBe(
      false,
    )
  })
})

describe('classify', () => {
  it('returns a validated classification from fenced JSON with noise', async () => {
    const { result } = await run(
      '我先看看。\n```json\n{"intent":"question","confidence":0.82,"reason":"问会议时间","need_search":true}\n```',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result).toMatchObject({ intent: 'question', confidence: 0.82, needSearch: true, task: null })
  })

  it('returns invalid for an answer that is not JSON', async () => {
    const { result } = await run('这应该算是个问题吧')
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('returns invalid when the model throws', async () => {
    const model = stubModel(() => {
      throw new Error('provider exploded')
    })
    const result = await classify(
      { message, threadWindow, persona, model, options: { prompts } },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, reason: 'invalid', detail: 'provider exploded' })
  })

  it('returns timeout when the call outlives its budget', async () => {
    const result = await classify(
      { message, threadWindow, persona, model: hangingModel(), options: { prompts, timeoutMs: 5 } },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('defaults to a 60s budget and accepts a slow answer inside it', async () => {
    // A real first call takes 15–40s; the deadline must not cut a working call.
    expect(DEFAULT_CLASSIFY_TIMEOUT_MS).toBe(60_000)
    const slow = stubModel(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      return json({ intent: 'chat', confidence: 0.9, reason: '慢但成功', need_search: false })
    })
    const result = await classify(
      { message, threadWindow, persona, model: slow, options: { prompts, timeoutMs: 1_000 } },
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.reason).toBe('慢但成功')
  })

  it('treats a confident-looking but low-confidence answer as undecided', async () => {
    const { result } = await run(
      json({ intent: 'task', confidence: 0.4, reason: '拿不准', need_search: false, task: { title: '订会议室' } }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'low_confidence' })
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.55)
  })

  it('accepts a low-confidence answer when the caller lowers the floor', async () => {
    const answer = json({ intent: 'chat', confidence: 0.4, reason: '大概', need_search: false })
    const { result } = await run(answer, { minConfidence: 0.3 })
    expect(result.ok).toBe(true)
  })

  it('sends the safety block, the persona summary and a bounded window', async () => {
    const { model } = await run(json({ intent: 'chat', confidence: 0.9, reason: '寒暄', need_search: false }))
    const request = model.requests[0]
    expect(request?.system).toContain('安全规则')
    expect(request?.system).toContain('「鲸鱼酱」，主人 的钉钉回复助理')
    expect(request?.system).toContain('当前时间：')
    expect(request?.messages[0]?.content).toContain('小明：早')
    expect(request?.messages[0]?.content).toContain('@鲸鱼酱 明天几点的会？')
    expect(request?.maxChars).toBeLessThanOrEqual(800)
  })

  it('reports the answer through the typed result shape', async () => {
    const { result } = await run(json({ intent: 'chat', confidence: 1, reason: '寒暄', need_search: false }))
    expect(result.ok).toBe(true)
    const success = result as ClassifySuccess
    expect(success.task).toBeNull()
    expect(success.reason).toBe('寒暄')
  })
})
