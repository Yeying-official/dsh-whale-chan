import { describe, expect, it } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { createHarness, THREAD_KEY } from './fixtures/domain.ts'

const TARGET = { kind: 'at-me' as const, conversationId: 'conv-1' }

function followup(harness: ReturnType<typeof createHarness>, overrides: Record<string, unknown> = {}) {
  return harness.engine.queueFollowup({
    threadKey: THREAD_KEY,
    target: TARGET,
    text: '任务完成了。',
    idempotencyKey: 'task-finish:task-1:assignment-1',
    kind: 'reply',
    outboundId: 'outbound-1',
    ...overrides,
  })
}

describe('queueing a follow-up', () => {
  it('stages one pending outbound and reports it as queued', () => {
    const harness = createHarness()
    harness.receive()
    const outbound = followup(harness)

    expect(outbound).toMatchObject({
      id: 'outbound-1',
      idempotencyKey: 'task-finish:task-1:assignment-1',
      kind: 'reply',
      target: TARGET,
      text: '任务完成了。',
      status: 'pending',
      attempts: 0,
      lastError: null,
      sentAt: null,
      receipt: null,
    })
    expect(harness.repos.outbound.get('outbound-1')).toEqual(outbound)
    expect(harness.engine.pendingOutbounds()).toEqual([outbound])
    expect(harness.events.at(-1)).toMatchObject({
      type: 'outbound.queued',
      data: { outboundId: 'outbound-1', threadKey: THREAD_KEY, outboundKind: 'reply' },
    })
  })

  it('stamps the event with the caller-supplied instant', () => {
    const harness = createHarness()
    harness.receive()
    harness.engine.queueFollowup(
      {
        threadKey: THREAD_KEY,
        target: TARGET,
        text: '任务完成了。',
        idempotencyKey: 'task-finish:task-1:assignment-1',
        kind: 'reply',
        outboundId: 'outbound-1',
      },
      { at: '2026-11-02T10:00:00.000Z' },
    )
    expect(harness.events.at(-1)).toMatchObject({ at: '2026-11-02T10:00:00.000Z' })
  })

  it('returns the outbound already staged under the same idempotency key', () => {
    const harness = createHarness()
    harness.receive()
    const first = followup(harness)
    const events = harness.events.length

    const second = followup(harness, {
      outboundId: 'outbound-2',
      text: '另一份文本',
      kind: 'notice',
    })

    expect(second).toEqual(first)
    expect(harness.repos.listOutbound()).toHaveLength(1)
    expect(harness.events).toHaveLength(events)
  })

  it('refuses a target of another conversation kind', () => {
    const harness = createHarness()
    harness.receive()
    expect(() =>
      followup(harness, { target: { kind: 'dm', conversationId: 'conv-1', peerUserId: 'user-1' } }),
    ).toThrowError(UserError)
    expect(harness.repos.listOutbound()).toHaveLength(0)
  })

  it('refuses blank text, a blank key and an unknown thread', () => {
    const harness = createHarness()
    harness.receive()
    expect(() => followup(harness, { text: '   ' })).toThrowError(/non-empty text/)
    expect(() => followup(harness, { idempotencyKey: '  ' })).toThrowError(/non-empty idempotency key/)
    expect(() => followup(harness, { threadKey: 'thread-missing' })).toThrowError(/Unknown thread/)
    expect(harness.repos.listOutbound()).toHaveLength(0)
  })
})

describe('reporting a follow-up result', () => {
  it('records a sent follow-up with its receipt', () => {
    const harness = createHarness()
    harness.receive()
    followup(harness)
    harness.clock.advance(1_000)

    const sent = harness.engine.outboundSent('outbound-1', 'msg-9')
    expect(sent).toMatchObject({
      status: 'sent',
      sentAt: '2026-11-02T09:00:01.000Z',
      receipt: 'msg-9',
      lastError: null,
    })
    expect(harness.engine.pendingOutbounds()).toEqual([])
    expect(harness.events.at(-1)).toMatchObject({ type: 'outbound.sent', data: { outboundId: 'outbound-1' } })
  })

  it('keeps the first terminal result when a duplicate report arrives', () => {
    const harness = createHarness()
    harness.receive()
    followup(harness)
    const sent = harness.engine.outboundSent('outbound-1', 'msg-9')
    const events = harness.events.length

    expect(harness.engine.outboundSent('outbound-1', 'other')).toEqual(sent)
    expect(harness.engine.outboundUnknown('outbound-1', 'late')).toEqual(sent)
    expect(harness.engine.outboundFailed('outbound-1', 'late')).toEqual(sent)
    expect(harness.engine.outboundDropped('outbound-1', 'late')).toEqual(sent)
    expect(harness.events).toHaveLength(events)
  })

  it('keeps an unknown outcome terminal and counts the attempt once', () => {
    const harness = createHarness()
    harness.receive()
    followup(harness)
    const unknown = harness.engine.outboundUnknown('outbound-1', 'timed out')
    expect(unknown).toMatchObject({ status: 'unknown', attempts: 1, lastError: 'timed out' })

    expect(harness.engine.outboundFailed('outbound-1', 'late')).toEqual(unknown)
    expect(harness.engine.outboundSent('outbound-1')).toEqual(unknown)
    expect(harness.engine.pendingOutbounds()).toEqual([])
  })

  it('records a failed outcome and a drop independently of any decision', () => {
    const harness = createHarness()
    harness.receive()
    followup(harness)
    const failed = harness.engine.outboundFailed('outbound-1', 'dws rejected the send')
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: 'dws rejected the send' })

    followup(harness, { outboundId: 'outbound-2', idempotencyKey: 'notice-1', kind: 'notice' })
    const dropped = harness.engine.outboundDropped('outbound-2', 'thread is gone')
    expect(dropped).toMatchObject({ status: 'dropped', lastError: 'thread is gone' })
    expect(harness.engine.pendingOutbounds()).toEqual([])
  })

  it('refuses to report an unknown outbound', () => {
    const harness = createHarness()
    expect(() => harness.engine.outboundSent('outbound-missing')).toThrowError(/Unknown outbound/)
  })
})
