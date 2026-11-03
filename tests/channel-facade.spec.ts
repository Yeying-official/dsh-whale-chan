import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { InboundMessage } from '../src/core/model.ts'
import type { Outbound } from '../src/core/model.ts'
import { SettingsSchema, type Settings } from '../src/shared/settings.ts'
import { DingTalkChannel } from '../src/channel/index.ts'
import type { ChannelLogger, DwsTarget } from '../src/channel/types.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws2-facade-'))
}

function settings(overrides: Record<string, unknown> = {}): Settings {
  return SettingsSchema.parse(overrides)
}

function logger(): ChannelLogger {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
}

function writeJson(directory: string, name: string, value: unknown): string {
  const file = join(directory, name)
  writeFileSync(file, JSON.stringify(value), 'utf8')
  return file
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
}

const atMe: DwsTarget = { kind: 'at-me', id: 'at-me', mentionOnly: true, enabled: true }

const eventLine = {
  type: 'user_im_message_receive_group',
  event_id: 'evt-m-1',
  message_id: 'm-1',
  conversation_id: 'cid-1',
  sender: 'Alice',
  sender_open_dingtalk_id: 'od-alice',
  content: '@鲸鱼酱 hi',
  create_time: '2026-11-03 14:04:17',
  event_time: 1793685857502,
}

function channel(provider: () => Settings | Promise<Settings>, extraEnv: Record<string, string> = {}): DingTalkChannel {
  return new DingTalkChannel({
    settingsProvider: provider,
    logger: logger(),
    ownerUserId: 'u-owner',
    command: process.execPath,
    baseArgs: [fakeDws],
    env: { ...process.env, ...extraEnv },
  })
}

describe('DingTalkChannel startup rules', () => {
  it('starts nothing while monitoring is paused', async () => {
    const events: InboundMessage[] = []
    const instance = channel(() => settings({ monitor: { paused: true } }))
    const health = await instance.start([atMe], (message) => {
      events.push(message)
    })
    expect(health).toEqual({ state: 'stopped', running: false, targets: [] })
    expect(events).toEqual([])
    await instance.stop()
  })

  it('starts nothing when monitoring is disabled', async () => {
    const instance = channel(() => settings({ monitor: { enabled: false } }))
    await expect(instance.start([atMe], () => undefined)).resolves.toMatchObject({ state: 'stopped' })
    await instance.stop()
  })

  it('stays idle with an empty target list', async () => {
    const instance = channel(() => settings())
    await expect(instance.start([], () => undefined)).resolves.toMatchObject({ state: 'stopped' })
    await instance.stop()
  })

  it('refuses a second start and a missing sink', async () => {
    const directory = tempDir()
    const eventsFile = writeJson(directory, 'events.json', [eventLine])
    const instance = channel(() => settings(), { FAKE_DWS_EVENTS: eventsFile })
    await expect(instance.start([atMe])).rejects.toMatchObject({ code: 'invalid-state' })
    await instance.start([atMe], () => undefined)
    await expect(instance.start([atMe], () => undefined)).rejects.toMatchObject({ code: 'invalid-state' })
    await instance.stop()
  })
})

describe('DingTalkChannel lifecycle and operations', () => {
  it('delivers events through the facade and stops cleanly', async () => {
    const directory = tempDir()
    const eventsFile = writeJson(directory, 'events.json', [eventLine])
    const received: InboundMessage[] = []
    const instance = channel(() => settings(), { FAKE_DWS_EVENTS: eventsFile })
    await instance.start([atMe], (message) => {
      received.push(message)
    })
    await waitFor(() => instance.health().state === 'ready')
    await waitFor(() => received.length === 1)
    expect(received[0]?.targetId).toBe('at-me')
    expect(received[0]?.addressed).toBe(true)
    await instance.stop()
    expect(instance.health()).toEqual({ state: 'stopped', running: false, targets: [] })
  })

  it('refuses to send while dry run is enabled and never spawns dws', async () => {
    const ledger = join(tempDir(), 'ledger.jsonl')
    const instance = channel(() => settings({ advanced: { dryRun: true } }), { FAKE_DWS_LEDGER: ledger })
    const outbound: Outbound = {
      id: 'out-1',
      idempotencyKey: 'key-1',
      kind: 'reply',
      target: { kind: 'group', conversationId: 'cid-1' },
      text: 'hello',
      status: 'pending',
      attempts: 0,
      lastError: null,
      sentAt: null,
      receipt: null,
    }
    await expect(instance.send(outbound)).resolves.toBe('skipped')
    expect(existsSync(ledger)).toBe(false)
  })

  it('sends through the same settings source', async () => {
    const ledger = join(tempDir(), 'ledger.jsonl')
    const instance = channel(() => settings(), { FAKE_DWS_LEDGER: ledger })
    const result = await instance.send({
      id: 'out-1',
      idempotencyKey: 'key-1',
      kind: 'reply',
      target: { kind: 'dm', conversationId: 'u-peer', peerUserId: 'u-peer' },
      text: 'hello',
      status: 'pending',
      attempts: 0,
      lastError: null,
      sentAt: null,
      receipt: null,
    })
    expect(result).toBe('sent')
    expect(existsSync(ledger)).toBe(true)
  })

  it('exposes discovery, validation and auth through the facade', async () => {
    const chats = writeJson(tempDir(), 'chats.json', {
      groups: [{ name: 'AI工程师孵化中心', openConversationId: 'cid-1' }],
      peers: [{ userId: 'u-1', name: '张三' }],
    })
    const instance = channel(() => settings(), { FAKE_DWS_CHATS: chats })
    await expect(instance.discoverGroups('AI')).resolves.toEqual([
      { kind: 'group', id: 'cid-1', label: 'AI工程师孵化中心', source: 'chat-search' },
    ])
    await expect(instance.discoverPeers('张')).resolves.toEqual([
      { kind: 'dm', id: 'u-1', label: '张三', source: 'chat-list' },
    ])
    await expect(instance.validateTarget(atMe)).resolves.toEqual({ valid: true })
    await expect(instance.probeAuth()).resolves.toMatchObject({ available: true, authenticated: true })
    expect(instance.ownerUserId()).toBe('u-owner')
  })
})
