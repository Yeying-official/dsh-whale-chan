import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inboundMessage } from './fixtures/domain.ts'
import { classifyAnswer, startPipeline, type PipelineHarness, type PipelineOptions } from './fixtures/pipeline.ts'

let root = ''
let harness: PipelineHarness | undefined

async function start(options: Omit<PipelineOptions, 'stateDir'> = {}): Promise<PipelineHarness> {
  harness = await startPipeline({ stateDir: join(root, 'state'), ...options })
  return harness
}

/** Emit one inbound message and let every due effect run. */
async function deliver(h: PipelineHarness, overrides: Record<string, unknown> = {}): Promise<void> {
  h.channel.emit(inboundMessage(overrides))
  await h.runtime.effects.idle()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-chat-'))
})

afterEach(async () => {
  await harness?.runtime.stop()
  harness = undefined
  await rm(root, { recursive: true, force: true })
})

describe('automatic replies', () => {
  it('classifies, drafts, queues and sends one reply', async () => {
    const h = await start()
    await deliver(h)

    expect(h.channel.sends).toHaveLength(1)
    expect(h.channel.sends[0]).toMatchObject({ kind: 'reply', text: '收到，我来看看。' })
    const outbound = h.runtime.store.outbound.pending()
    expect(outbound).toEqual([])
    const decisions = h.runtime.store.read.audit({ limit: 50 }).items.map((item) => item.type)
    expect(decisions).toEqual(expect.arrayContaining(['reply.drafted', 'reply.queued', 'reply.sent']))
    expect(h.runtime.engine.thread('at-me:target-1:conv-1')?.counts.replied).toBe(1)
  })

  it('does not answer twice when the channel redelivers the same message', async () => {
    const h = await start()
    await deliver(h)
    h.channel.emit(inboundMessage())
    await h.runtime.effects.idle()
    expect(h.channel.sends).toHaveLength(1)
    expect(h.runtime.store.read.listThreads().items[0]?.lastMessageAt).toBeDefined()
  })

  it('defers a message with no configured target', async () => {
    const h = await start({ settings: { targets: { rows: [] } } })
    await deliver(h)
    const decision = h.runtime.store.read.audit({ limit: 20 }).items
    expect(decision.length).toBeGreaterThan(0)
    expect(h.channel.sends).toEqual([])
    const id = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(id['id']))).toMatchObject({
      status: 'deferred',
      reason: 'target_missing',
    })
  })
})

describe('the reply gate downgrades or refuses', () => {
  it('drafts without sending when the target asks for review', async () => {
    const h = await start({
      settings: {
        targets: {
          rows: [{ kind: 'at-me', id: 'target-1', label: '', mentionOnly: true, replyMode: 'review', enabled: true }],
        },
      },
    })
    await deliver(h)
    expect(h.channel.sends).toEqual([])
    const decision = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(decision['id']))).toMatchObject({ status: 'drafted' })
  })

  it('drafts without sending when automatic replies are off', async () => {
    const h = await start({ settings: { reply: { autoReply: false } } })
    await deliver(h)
    expect(h.channel.sends).toEqual([])
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))).toMatchObject({ status: 'drafted' })
  })

  it('drafts without sending during quiet hours', async () => {
    const h = await start()
    h.clock.set(new Date(2026, 10, 2, 23, 30, 0).toISOString())
    await deliver(h)
    expect(h.channel.sends).toEqual([])
  })

  it('downgrades a second reply that would exceed the hourly limit', async () => {
    const h = await start({ settings: { reply: { maxPerConversationPerHour: 1 } } })
    await deliver(h)
    expect(h.channel.sends).toHaveLength(1)
    await deliver(h, { id: 'message-2', text: '第二个问题' })
    expect(h.channel.sends).toHaveLength(1)
    const rows = h.runtime.store.db.prepare('SELECT id, status FROM decisions ORDER BY rowid').all() as readonly Record<
      string,
      unknown
    >[]
    expect(rows.map((row) => row['status'])).toEqual(['sent', 'drafted'])
  })

  it('downgrades a reply that arrives before the minimum gap', async () => {
    const h = await start()
    await deliver(h)
    expect(h.channel.sends).toHaveLength(1)
    await deliver(h, { id: 'message-2', text: '再问一句' })
    expect(h.channel.sends).toHaveLength(1)
  })

  it('refuses a group message that does not address the assistant', async () => {
    const h = await start({
      settings: {
        targets: {
          rows: [{ kind: 'group', id: 'target-g', label: '群', mentionOnly: true, replyMode: 'auto', enabled: true }],
        },
      },
    })
    await deliver(h, {
      id: 'message-group',
      targetId: 'target-g',
      threadKey: 'group:cid-1',
      kind: 'group',
      conversationId: 'cid-1',
      addressed: false,
    })
    expect(h.channel.sends).toEqual([])
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))).toMatchObject({ status: 'deferred', reason: 'not_addressed' })
  })

  it('refuses a broadcast message', async () => {
    const h = await start()
    await deliver(h, { id: 'message-all', text: '通知', mentions: ['@all'] })
    expect(h.channel.sends).toEqual([])
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))).toMatchObject({ status: 'deferred', reason: 'broadcast' })
  })

  it('recognises its own reply coming back as an echo', async () => {
    const h = await start()
    await deliver(h)
    const sent = h.channel.sends[0]?.text ?? ''
    expect(sent.length).toBeGreaterThan(0)
    await deliver(h, { id: 'message-echo', text: sent })
    expect(h.channel.sends).toHaveLength(1)
    const rows = h.runtime.store.db
      .prepare('SELECT id, status, reason FROM decisions ORDER BY rowid')
      .all() as readonly Record<string, unknown>[]
    expect(rows.at(-1)).toMatchObject({ status: 'deferred', reason: 'echo' })
  })
})

describe('classification and composition failures', () => {
  it('defers when the classifier is not confident enough', async () => {
    const h = await start()
    h.model.current.classifyAnswer = classifyAnswer('chat', { confidence: 0.2 })
    await deliver(h)
    expect(h.channel.sends).toEqual([])
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))).toMatchObject({
      status: 'deferred',
      reason: 'classify:low_confidence',
    })
  })

  it('defers when the model produces an empty reply', async () => {
    const h = await start()
    h.model.current.replyAnswer = ''
    await deliver(h)
    expect(h.channel.sends).toEqual([])
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))).toMatchObject({ status: 'deferred', reason: 'compose:empty' })
  })
})

describe('research before composing', () => {
  it('hands retrieved sources to the draft', async () => {
    const h = await start()
    h.model.current.classifyAnswer = classifyAnswer('question', { need_search: true })
    h.model.current.replyAnswer = '参考：https://example.com/doc 这里有答案。'
    await deliver(h, { text: '这个怎么配置？' })

    expect(h.research.calls).toHaveLength(1)
    expect(h.research.calls[0]).toMatchObject({ query: '这个怎么配置？', limit: 5 })
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    const decision = h.runtime.engine.decision(String(row['id']))
    expect(decision?.draft).toMatchObject({ researched: true, sources: ['https://example.com/doc'] })
    expect(h.channel.sends).toHaveLength(1)
  })

  it('still composes when retrieval fails, without citations', async () => {
    const h = await start()
    h.research.error = new Error('provider down')
    h.model.current.classifyAnswer = classifyAnswer('question', { need_search: true })
    h.model.current.replyAnswer = '没有查到公开资料，我按经验说：先打开设置页。'
    await deliver(h, { text: '这个怎么配置？' })

    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))?.draft).toMatchObject({
      researched: false,
      sources: [],
    })
    expect(h.channel.sends).toHaveLength(1)
  })
})

describe('delivery outcomes', () => {
  it('records an unknown delivery and never sends it again', async () => {
    const h = await start()
    h.channel.sendResults = [{ result: 'unknown', error: 'dws timed out' }]
    await deliver(h, { text: '在吗' })

    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))).toMatchObject({ status: 'send_unknown' })
    const outbound = h.runtime.store.db.prepare('SELECT status FROM outbound LIMIT 1').get() as Record<string, unknown>
    expect(outbound['status']).toBe('unknown')
    const notices = h.runtime.store.read
      .audit({ limit: 50 })
      .items.filter((item) => item.type === 'notice')
      .map((item) => item.data)
    expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'send_unknown' })]))

    await h.runtime.effects.idle()
    expect(h.channel.sends).toHaveLength(1)
  })

  it('records a definite failure', async () => {
    const h = await start()
    h.channel.sendResults = [{ result: 'failed', error: 'dws rejected the send' }]
    await deliver(h, { text: '在吗' })
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))).toMatchObject({ status: 'send_failed' })
    const outbound = h.runtime.store.db.prepare('SELECT status, last_error FROM outbound LIMIT 1').get() as Record<
      string,
      unknown
    >
    expect(outbound).toMatchObject({ status: 'failed', last_error: 'dws rejected the send' })
  })

  it('leaves the outbox pending in dry-run mode', async () => {
    const h = await start()
    h.channel.sendResults = [{ result: 'skipped' }]
    await deliver(h, { text: '在吗' })
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    expect(h.runtime.engine.decision(String(row['id']))).toMatchObject({ status: 'sending' })
    const outbound = h.runtime.store.db.prepare('SELECT status FROM outbound LIMIT 1').get() as Record<string, unknown>
    expect(outbound['status']).toBe('pending')
  })
})

describe('compose retries', () => {
  /** Reply calls only: the classifier is the one request bounded at 800 chars. */
  function replyCalls(h: PipelineHarness): number {
    return h.model.current.requests.filter((request) => request.maxChars !== 800).length
  }

  function onlyDecision(h: PipelineHarness) {
    const row = h.runtime.store.db.prepare('SELECT id FROM decisions LIMIT 1').get() as Record<string, unknown>
    return h.runtime.engine.decision(String(row['id']))
  }

  it('retries one empty draft and sends the second answer', async () => {
    const h = await start()
    h.model.current.replies = ['', '收到，我来看看。']
    await deliver(h)

    expect(h.channel.sends).toHaveLength(1)
    expect(h.channel.sends[0]).toMatchObject({ text: '收到，我来看看。' })
    // The retry keeps the classification reason: only the log may name the failure.
    expect(onlyDecision(h)).toMatchObject({ status: 'sent', attempts: 1, reason: 'test' })
    expect(replyCalls(h)).toBe(2)
  })

  it('retries a draft that cleaning emptied and sends the second answer', async () => {
    const h = await start()
    h.model.current.replies = ['我是人类', '收到，我来看看。']
    await deliver(h)

    expect(h.channel.sends).toHaveLength(1)
    expect(h.channel.sends[0]).toMatchObject({ text: '收到，我来看看。' })
    expect(onlyDecision(h)).toMatchObject({ status: 'sent', attempts: 1, reason: 'test' })
    expect(replyCalls(h)).toBe(2)
  })

  it('defers after the one retry also comes back empty', async () => {
    const h = await start()
    h.model.current.replies = ['', '']
    await deliver(h)

    expect(h.channel.sends).toEqual([])
    expect(onlyDecision(h)).toMatchObject({ status: 'deferred', reason: 'compose:empty', attempts: 1 })
    expect(replyCalls(h)).toBe(2)
  })

  it('does not retry when the owner turned autoRetry off', async () => {
    const h = await start({ settings: { reply: { autoRetry: false } } })
    h.model.current.replies = ['', '收到，我来看看。']
    await deliver(h)

    expect(h.channel.sends).toEqual([])
    expect(onlyDecision(h)).toMatchObject({ status: 'deferred', reason: 'compose:empty', attempts: 0 })
    expect(replyCalls(h)).toBe(1)
  })

  it('sends the body when research returns citations longer than the body budget', async () => {
    const h = await start()
    h.model.current.classifyAnswer = classifyAnswer('question', { need_search: true })
    h.model.current.replyAnswer = '明天十点开始，我先确认一下日程。'
    h.research.hit = {
      facts: ['会议在 10:00 开始'],
      sources: [
        '关于 DeepSeek V4.1 Pro 发布与订阅价格的官方说明',
        '关于 DSH 鲸鱼酱插件 v0.6.0 升级说明与已知问题',
        '钉钉个人授权与 dws 订阅的常见问题汇总',
      ].map((title, index) => ({ title, url: `https://example.com/docs/${'a'.repeat(90)}${index}` })),
    }
    await deliver(h, { text: '这个怎么配置？' })

    expect(h.channel.sends).toHaveLength(1)
    const text = h.channel.sends[0]?.text ?? ''
    expect(text.startsWith('明天十点开始，我先确认一下日程。')).toBe(true)
    expect(text).toContain('参考：')
    expect([...text].length).toBeGreaterThan(300)
    expect(onlyDecision(h)).toMatchObject({ status: 'sent', attempts: 0 })
  })
})
