/**
 * `LlmModel`: the reply path is one direct model call.
 *
 * The property that matters is what the request does *not* contain: no session,
 * no tools, no workspace. A fake `ctx.llm` records the exact `GenerateOptions`,
 * and one test drives the production factory with a proxy context so any other
 * service access fails the test instead of silently creeping back in.
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import {
  ExecutorError,
  LlmModel,
  MAX_OUTPUT_TOKENS,
  ModelAbortedError,
  ModelFailedError,
  defaultModelOf,
  outputTokensFor,
  replyModelFor,
  type DefaultModelLike,
  type LlmLike,
} from '../src/executor/index.ts'
import { RecordingLogger, makeSettings } from './fixtures/executor.ts'

const request = (
  text = '你好',
  maxChars?: number,
): { system: string; messages: Array<{ role: 'user'; content: string }>; maxChars?: number } => ({
  system: '你是鲸鱼酱。',
  messages: [{ role: 'user', content: text }],
  ...(maxChars === undefined ? {} : { maxChars }),
})

/** Records the request and yields scripted chunks. */
class FakeLlm implements LlmLike {
  readonly options: GenerateOptions[] = []
  readonly resolved: unknown[] = []
  chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: '好的。' }]
  failure: Error | undefined
  resolveError: Error | undefined
  /** Invoked while streaming, so a test can abort mid-call. */
  onStream: (() => void) | undefined

  async resolveCallConfig(config: { provider: string; model: string; reasoningEffort?: unknown }) {
    this.resolved.push(config)
    if (this.resolveError !== undefined) throw this.resolveError
    return config as { provider: string; model: string; reasoningEffort?: never }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.options.push(options)
    const chunks = this.chunks
    const failure = this.failure
    const onStream = this.onStream
    return (async function* () {
      for (const chunk of chunks) yield chunk
      onStream?.()
      if (failure !== undefined) throw failure
    })()
  }
}

function model(
  overrides: { route?: { provider: string; model: string; effort: string }; defaultModel?: DefaultModelLike } = {},
) {
  const llm = new FakeLlm()
  const instance = new LlmModel({
    llm,
    ...(overrides.route === undefined ? {} : { route: overrides.route }),
    ...(overrides.defaultModel === undefined ? {} : { defaultModel: overrides.defaultModel }),
  })
  return { llm, instance }
}

describe('request shape', () => {
  it('sends the system text and one user message, with no tools', async () => {
    const { llm, instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    const signal = new AbortController().signal
    await instance.complete(request('第一句'), signal)
    const options = llm.options[0]
    expect(options?.provider).toBe('p')
    expect(options?.model).toBe('m')
    expect(options?.system).toBe('你是鲸鱼酱。')
    expect(options?.messages).toHaveLength(1)
    expect(options?.messages[0]?.role).toBe('user')
    expect(JSON.stringify(options?.messages[0])).toContain('第一句')
    expect(options?.signal).toBe(signal)
    expect(options?.tools).toBeUndefined()
  })

  it('keeps the conversation separated from the system text', async () => {
    const { llm, instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    await instance.complete(
      {
        system: '系统指令',
        messages: [
          { role: 'user', content: '问' },
          { role: 'assistant', content: '答' },
        ],
      },
      new AbortController().signal,
    )
    const sent = JSON.stringify(llm.options[0]?.messages[0])
    expect(sent).toContain('【用户 1】')
    expect(sent).toContain('【助手 2】')
    expect(sent).not.toContain('系统指令')
  })

  it('derives maxTokens from the brain character hint and caps it', async () => {
    const { llm, instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    await instance.complete(request('x', 400), new AbortController().signal)
    expect(llm.options[0]?.maxTokens).toBe(100)
    await instance.complete(request('x', 100_000), new AbortController().signal)
    expect(llm.options[1]?.maxTokens).toBe(MAX_OUTPUT_TOKENS)
    await instance.complete(request('x'), new AbortController().signal)
    expect(llm.options[2]?.maxTokens).toBeUndefined()
  })

  it('bounds the assembled user message', async () => {
    const { llm, instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    await instance.complete(
      { system: 's', messages: [{ role: 'user', content: 'z'.repeat(20_000) }] },
      new AbortController().signal,
    )
    const first = llm.options[0]?.messages[0] as unknown as { content: readonly { text?: string }[] }
    const content = first.content[0]?.text ?? ''
    expect(content.length).toBeLessThanOrEqual(12_000)
    expect(content.endsWith('…')).toBe(true)
  })
})

describe('routing', () => {
  it('prefers the settings route', async () => {
    const { llm, instance } = model({
      route: { provider: 'settings-provider', model: 'settings-model', effort: 'high' },
      defaultModel: { currentSelection: () => ({ provider: 'host', model: 'host-model' }) },
    })
    await instance.complete(request(), new AbortController().signal)
    expect(llm.resolved).toEqual([{ provider: 'settings-provider', model: 'settings-model', reasoningEffort: 'high' }])
    expect(llm.options[0]?.provider).toBe('settings-provider')
  })

  it('falls back to the host default when settings name no route', async () => {
    const { llm, instance } = model({
      defaultModel: { currentSelection: () => ({ provider: 'host', model: 'host-model' }) },
    })
    await instance.complete(request(), new AbortController().signal)
    expect(llm.resolved).toEqual([{ provider: 'host', model: 'host-model' }])
    expect(llm.options[0]?.provider).toBe('host')
  })

  it('reports a missing route instead of guessing one', async () => {
    const { llm, instance } = model()
    await expect(instance.complete(request(), new AbortController().signal)).rejects.toMatchObject({
      code: 'modelUnavailable',
    })
    expect(llm.options).toHaveLength(0)
  })

  it('resolves the route once for repeated calls', async () => {
    const { llm, instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    const signal = new AbortController().signal
    await instance.complete(request(), signal)
    await instance.complete(request(), signal)
    expect(llm.resolved).toHaveLength(1)
    expect(llm.options).toHaveLength(2)
  })
})

describe('output', () => {
  it('concatenates text deltas and ignores reasoning deltas', async () => {
    const { llm, instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    llm.chunks = [
      { type: 'reasoning-delta', index: 0, text: '先想一想' },
      { type: 'text-delta', index: 0, text: '好' },
      { type: 'text-delta', index: 0, text: '的。' },
    ]
    await expect(instance.complete(request(), new AbortController().signal)).resolves.toBe('好的。')
  })

  it('reports a stream failure as a model failure', async () => {
    const { llm, instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    llm.failure = new Error('provider exploded')
    await expect(instance.complete(request(), new AbortController().signal)).rejects.toBeInstanceOf(ModelFailedError)
  })

  it('reports an aborted caller as an abort, not a failure', async () => {
    const { instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    const controller = new AbortController()
    controller.abort()
    await expect(instance.complete(request(), controller.signal)).rejects.toBeInstanceOf(ModelAbortedError)
  })

  it('reports a mid-stream abort as an abort', async () => {
    const { llm, instance } = model({ route: { provider: 'p', model: 'm', effort: '' } })
    const controller = new AbortController()
    llm.onStream = () => controller.abort()
    llm.failure = new Error('aborted by caller')
    await expect(instance.complete(request(), controller.signal)).rejects.toBeInstanceOf(ModelAbortedError)
  })
})

describe('composition', () => {
  it('touches only llm and agentDefaultModel on the context', async () => {
    const llm = new FakeLlm()
    const accessed: string[] = []
    const base = {
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'host', model: 'host-model' }) },
    }
    const ctx = new Proxy(base, {
      get(target, property) {
        accessed.push(String(property))
        return (target as Record<PropertyKey, unknown>)[property]
      },
    }) as unknown as Context
    const port = replyModelFor(ctx, makeSettings().models.reply)
    await expect(port.complete(request(), new AbortController().signal)).resolves.toBe('好的。')
    expect(accessed).toContain('llm')
    expect(accessed).toContain('agentDefaultModel')
    // No session, no agent, no persistence, no permission preset.
    for (const forbidden of [
      'sessionController',
      'agents',
      'sessionPersistence',
      'workspaceRegistry',
      'permissionPresets',
    ]) {
      expect(accessed).not.toContain(forbidden)
    }
  })

  it('reports an absent default model as a missing route', async () => {
    const llm = new FakeLlm()
    const ctx = new Proxy(
      { llm },
      {
        get(target, property) {
          return (target as Record<PropertyKey, unknown>)[property]
        },
      },
    ) as unknown as Context
    expect(defaultModelOf(ctx)).toBeUndefined()
    const port = replyModelFor(ctx, undefined)
    await expect(port.complete(request(), new AbortController().signal)).rejects.toBeInstanceOf(ExecutorError)
  })

  it('logs the resolved route once', async () => {
    const logger = new RecordingLogger()
    const llm = new FakeLlm()
    const port = new LlmModel({
      llm,
      route: { provider: 'p', model: 'm', effort: '' },
      logger,
    })
    await port.complete(request(), new AbortController().signal)
    expect(logger.lines.some((line) => line.includes('p/m'))).toBe(true)
  })
})

describe('outputTokensFor', () => {
  it('maps characters to tokens with a floor and a ceiling', () => {
    expect(outputTokensFor(undefined)).toBeUndefined()
    expect(outputTokensFor(0)).toBeUndefined()
    expect(outputTokensFor(8)).toBe(2)
    expect(outputTokensFor(4)).toBe(1)
    expect(outputTokensFor(1_000_000)).toBe(MAX_OUTPUT_TOKENS)
  })
})
