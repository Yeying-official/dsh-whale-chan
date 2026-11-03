/**
 * `SessionModel` behaviour: the prompt it assembles, the one-turn-at-a-time
 * guarantee, its session reuse and rotation, and the errors the brain maps.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  DROPPED_MARKER,
  ExecutorError,
  MAX_PROMPT_CHARS,
  MODEL_TURN_TIMEOUT_MS,
  REPLY_TIMEOUT_MS,
  ModelAbortedError,
  ModelFailedError,
  ModelTimeoutError,
  REPLIER_PRESET,
  SessionModel,
  assemblePrompt,
  threadDigest,
} from '../src/executor/index.ts'
import { FakeSessionHost, RecordingLogger } from './fixtures/executor.ts'

function learning(): { host: FakeSessionHost; model: SessionModel; logger: RecordingLogger } {
  const host = new FakeSessionHost()
  const logger = new RecordingLogger()
  const model = new SessionModel({
    host,
    logger,
    threadKey: 'dm:u1',
    title: '小明',
    homeDir: '/home/owner',
    now: () => Date.now(),
  })
  return { host, model, logger }
}

const request = (
  text = '你好',
): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } => ({
  system: '你是鲸鱼酱。',
  messages: [{ role: 'user', content: text }],
})

describe('assemblePrompt', () => {
  it('separates the system text from a role-labelled conversation', () => {
    const assembly = assemblePrompt('你是鲸鱼酱。', [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ])
    expect(assembly.text).toContain('## 系统指示\n你是鲸鱼酱。')
    expect(assembly.text).toContain('## 对话')
    expect(assembly.text).toContain('【用户 1】\n第一问')
    expect(assembly.text).toContain('【助手 2】\n第一答')
    expect(assembly.text).toContain('【用户 3】\n第二问')
    expect(assembly.dropped).toBe(0)
    expect(assembly.clipped).toBe(false)
  })

  it('keeps the newest messages and drops the oldest when over budget', () => {
    const assembly = assemblePrompt(
      'sys',
      [
        { role: 'user', content: 'a'.repeat(50) },
        { role: 'assistant', content: 'b'.repeat(50) },
        { role: 'user', content: 'c'.repeat(50) },
      ],
      120,
    )
    expect(assembly.dropped).toBeGreaterThan(0)
    expect(assembly.text).toContain('c'.repeat(50))
    expect(assembly.text).not.toContain('a'.repeat(50))
    expect(assembly.text.length).toBeLessThanOrEqual(120)
    expect(assembly.text).toContain(DROPPED_MARKER.replace('{n}', String(assembly.dropped)))
  })

  it('clips one oversized newest message instead of dropping everything', () => {
    const assembly = assemblePrompt('sys', [{ role: 'user', content: 'x'.repeat(500) }], 100)
    expect(assembly.clipped).toBe(true)
    expect(assembly.dropped).toBe(0)
    expect(assembly.text.length).toBeLessThanOrEqual(100)
    expect(assembly.text).toContain('…')
  })

  it('always keeps the system text, even when the messages must go', () => {
    const assembly = assemblePrompt('规则很重要', [{ role: 'user', content: 'y'.repeat(400) }], 60)
    expect(assembly.text).toContain('规则很重要')
    expect(assembly.text.length).toBeLessThanOrEqual(60)
  })

  it('defaults to the documented budget', () => {
    const assembly = assemblePrompt('s', [])
    expect(assembly.text).toBe('## 系统指示\ns')
    expect(MAX_PROMPT_CHARS).toBe(12_000)
  })
})

describe('session identity', () => {
  it('uses the replier preset, a hashed session id and the shared workspace', async () => {
    const { host, model } = learning()
    const text = await model.complete(request(), new AbortController().signal)
    expect(text).toBe('已完成，改了 a.txt。')
    const ensured = host.ensured[0]
    expect(ensured?.preset).toBe(REPLIER_PRESET)
    expect(ensured?.permission).toBe('workspace-write')
    expect(ensured?.sessionId).toBe(`whale-reply-${threadDigest('dm:u1')}`)
    expect(ensured?.sessionId).toMatch(/^whale-reply-[0-9a-f]{12}$/)
    expect(ensured?.title).toBe('钉钉 · 小明')
    expect(ensured?.workspace).toBe(join('/home/owner', '.dsh-whale-chan', 'workspace'))
  })

  it('reuses the session for later calls and delivers the assembled prompt once', async () => {
    const { host, model } = learning()
    const signal = new AbortController().signal
    await model.complete(request('第一句'), signal)
    await model.complete(request('第二句'), signal)
    expect(host.ensured).toHaveLength(1)
    expect(host.deliveries).toHaveLength(2)
    expect(host.deliveries[0]?.text).toContain('第一句')
    expect(host.deliveries[1]?.text).toContain('第二句')
    expect(host.deliveries[0]?.requestId).not.toBe(host.deliveries[1]?.requestId)
  })

  it('gives each thread its own session through forThread', async () => {
    const { host, model } = learning()
    const signal = new AbortController().signal
    await model.forThread('group:g1', '项目群').complete(request(), signal)
    await model.forThread('group:g2', '另一个群').complete(request(), signal)
    expect(host.ensured).toHaveLength(2)
    expect(host.ensured[0]?.sessionId).not.toBe(host.ensured[1]?.sessionId)
    expect(host.ensured[0]?.title).toBe('钉钉 · 项目群')
    expect(host.deliveries.map((delivery) => delivery.sessionId)).toEqual([
      host.ensured[0]?.sessionId,
      host.ensured[1]?.sessionId,
    ])
  })
})

describe('turn budget', () => {
  it('gives one replier turn 90 seconds, so a slow first token is not a timeout', async () => {
    const { host, model } = learning()
    await model.complete(request(), new AbortController().signal)
    expect(REPLY_TIMEOUT_MS).toBe(90_000)
    expect(MODEL_TURN_TIMEOUT_MS).toBe(REPLY_TIMEOUT_MS)
    expect(host.awaited[0]?.options.timeoutMs).toBe(90_000)
  })

  it('still honours an explicit budget from the caller', async () => {
    const host = new FakeSessionHost()
    const model = new SessionModel({
      host,
      threadKey: 'dm:u1',
      title: '小明',
      homeDir: '/home/owner',
      timeoutMs: 5_000,
    })
    await model.complete(request(), new AbortController().signal)
    expect(host.awaited[0]?.options.timeoutMs).toBe(5_000)
  })
})

describe('model route', () => {
  it('passes the configured reply route to the session', async () => {
    const host = new FakeSessionHost()
    const model = new SessionModel({
      host,
      threadKey: 'dm:u1',
      title: '小明',
      homeDir: '/home/owner',
      model: { provider: 'deepseek', model: 'deepseek-chat', effort: 'high' },
    })
    await model.complete(request(), new AbortController().signal)
    expect(host.ensured[0]?.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat', effort: 'high' })
  })

  it('passes nothing when the route is left at its defaults', async () => {
    const { host, model } = learning()
    await model.complete(request(), new AbortController().signal)
    expect(host.ensured[0]?.model).toBeUndefined()
  })
})

describe('serialization', () => {
  it('runs one turn at a time per thread', async () => {
    const { host, model } = learning()
    host.holdTurns()
    const signal = new AbortController().signal
    const first = model.complete(request('第一'), signal)
    await host.waitForTurns(1)
    const second = model.complete(request('第二'), signal)
    // The second call must not have entered the session yet.
    await Promise.resolve()
    expect(host.deliveries).toHaveLength(1)

    host.releaseTurn()
    await host.waitForTurns(2)
    expect(host.deliveries).toHaveLength(2)
    host.releaseTurn()
    await Promise.all([first, second])
  })

  it('serializes two different threads independently', async () => {
    const { host, model } = learning()
    host.holdTurns()
    const signal = new AbortController().signal
    const one = model.forThread('dm:a', 'A').complete(request(), signal)
    const two = model.forThread('dm:b', 'B').complete(request(), signal)
    await host.waitForTurns(2)
    expect(host.deliveries).toHaveLength(2)
    host.releaseTurn()
    await Promise.all([one, two])
  })
})

describe('reuse limits', () => {
  it('rebuilds the session after the turn budget and asks for a fresh one', async () => {
    const host = new FakeSessionHost()
    host.rebuiltSessionId = 'whale-reply-fresh000001'
    const model = new SessionModel({ host, threadKey: 'dm:u1', title: '小明', maxTurns: 2, homeDir: '/home/owner' })
    const signal = new AbortController().signal
    await model.complete(request(), signal)
    await model.complete(request(), signal)
    await model.complete(request(), signal)
    expect(host.ensured).toHaveLength(2)
    expect(host.ensured[0]?.fresh).toBe(false)
    expect(host.ensured[1]?.fresh).toBe(true)
    // The rotated session is closed before the rebuild.
    expect(host.cancellations[0]?.sessionId).toBe(`whale-reply-${threadDigest('dm:u1')}`)
    // Deliveries after the rebuild use the id the host returned.
    expect(host.deliveries.at(-1)?.sessionId).toBe('whale-reply-fresh000001')
  })

  it('rebuilds the session after the idle budget', async () => {
    const host = new FakeSessionHost()
    let clock = 1_000
    const model = new SessionModel({
      host,
      threadKey: 'dm:u1',
      title: '小明',
      idleResetMs: 1_000,
      homeDir: '/home/owner',
      now: () => clock,
    })
    const signal = new AbortController().signal
    await model.complete(request(), signal)
    clock += 500
    await model.complete(request(), signal)
    expect(host.ensured).toHaveLength(1)
    clock += 1_000
    await model.complete(request(), signal)
    expect(host.ensured).toHaveLength(2)
    expect(host.ensured[1]?.fresh).toBe(true)
  })
})

describe('failures', () => {
  it('raises ModelTimeoutError with a brain-facing reason', async () => {
    const { host, model } = learning()
    host.turnOutcome = { status: 'timeout' }
    await expect(model.complete(request(), new AbortController().signal)).rejects.toBeInstanceOf(ModelTimeoutError)
    await expect(model.complete(request(), new AbortController().signal)).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('raises ModelFailedError with the DSH detail', async () => {
    const { host, model } = learning()
    host.turnOutcome = { status: 'failed', detail: 'provider overloaded' }
    await expect(model.complete(request(), new AbortController().signal)).rejects.toBeInstanceOf(ModelFailedError)
    await expect(model.complete(request(), new AbortController().signal)).rejects.toThrow(/provider overloaded/)
  })

  it('raises ModelAbortedError when the caller already aborted', async () => {
    const { host, model } = learning()
    const controller = new AbortController()
    controller.abort()
    await expect(model.complete(request(), controller.signal)).rejects.toBeInstanceOf(ModelAbortedError)
    expect(host.ensured).toHaveLength(0)
  })

  it('returns the final text without inventing one when the session has none', async () => {
    const { host, model, logger } = learning()
    host.finalText = { text: '', found: false }
    await expect(model.complete(request(), new AbortController().signal)).resolves.toBe('')
    expect(logger.lines.some((line) => line.startsWith('warn:'))).toBe(true)
  })
})

describe('dispose', () => {
  it('cancels the open sessions and refuses further work', async () => {
    const { host, model } = learning()
    const signal = new AbortController().signal
    await model.complete(request(), signal)
    await model.dispose()
    expect(host.cancellations).toHaveLength(1)
    await expect(model.complete(request(), signal)).rejects.toBeInstanceOf(ExecutorError)
    await model.dispose()
  })
})
