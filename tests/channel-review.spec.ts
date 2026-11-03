/**
 * Review round 1 additions.
 *
 * The owner-identity precondition, dry-run `skipped` semantics, media-only
 * skip and the quoted-JSON redaction are cross-cutting behaviours: this file
 * keeps their regression tests together so the fix commit stays self-contained.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { probeAuth } from '../src/channel/auth.ts'
import { DingTalkChannel } from '../src/channel/index.ts'
import { redact } from '../src/channel/log.ts'
import { normalizeEvent } from '../src/channel/normalize.ts'
import { createRunner } from '../src/channel/process.ts'
import { ChannelSupervisor } from '../src/channel/supervisor.ts'
import type { ChannelLogger, CommandRunner, DwsTarget } from '../src/channel/types.ts'
import { SettingsSchema, type Settings } from '../src/shared/settings.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))

function settings(overrides: Record<string, unknown> = {}): Settings {
  return SettingsSchema.parse(overrides)
}

function logger(): ChannelLogger {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws2-review-'))
}

function authRunner(payload: string): CommandRunner {
  return createRunner({
    command: process.execPath,
    baseArgs: [fakeDws],
    env: { ...process.env, FAKE_DWS_AUTH_RAW: payload },
  })
}

const atMe: DwsTarget = { kind: 'at-me', id: 'at-me', mentionOnly: true, enabled: true }

const atEvent = {
  eventType: 'user_im_message_receive_at',
  msgId: 'msg-1',
  conversationId: 'cid-1',
  conversationType: 'group',
  senderStaffId: 'u-alice',
  senderNick: 'Alice',
  text: '@鲸鱼酱 hi',
  createAt: 1_760_000_000_000,
  atUsers: ['u-owner'],
}

describe('owner identity from auth status', () => {
  it('returns the authorized user id to the host', async () => {
    const state = await probeAuth(settings(), {
      runner: authRunner('{"authenticated":true,"token_valid":true,"user_id":"u-secret-1"}'),
    })
    expect(state.userId).toBe('u-secret-1')
  })

  it('accepts the documented alias spellings', async () => {
    for (const [payload, expected] of [
      ['{"authenticated":true,"token_valid":true,"userId":"u-camel"}', 'u-camel'],
      ['{"authenticated":true,"token_valid":true,"staff_id":"staff-1"}', 'staff-1'],
      ['{"authenticated":true,"token_valid":true,"open_dingtalk_id":"od-1"}', 'od-1'],
    ] as const) {
      await expect(probeAuth(settings(), { runner: authRunner(payload) })).resolves.toMatchObject({
        userId: expected,
      })
    }
  })

  it('keeps the user id out of any log line built from the probe state', async () => {
    const state = await probeAuth(settings(), {
      runner: authRunner('{"authenticated":true,"token_valid":true,"user_id":"u-secret-9"}'),
    })
    // `redact` is the only supported way to log state; it must mask the account
    // id even though the field is returned to the host.
    expect(redact(`auth ${JSON.stringify(state)}`)).not.toContain('u-secret-9')
  })
})

describe('owner-unknown is fail-closed', () => {
  it('refuses to start a facade subscription without an owner identity', async () => {
    const instance = new DingTalkChannel({
      settingsProvider: () => settings(),
      logger: logger(),
      command: process.execPath,
      baseArgs: [fakeDws],
    })
    await expect(instance.start([atMe], () => undefined)).rejects.toMatchObject({ code: 'owner-unknown' })
    expect(instance.health()).toEqual({ state: 'stopped', running: false, targets: [] })
    await instance.stop()
  })

  it('refuses to start a supervisor subscription without spawning anything', async () => {
    const spawns: string[][] = []
    const supervisor = new ChannelSupervisor({
      settings: settings(),
      logger: logger(),
      command: 'unused',
      spawn: (_command, args) => {
        spawns.push([...args])
        throw new Error('spawn must not be reached without an owner identity')
      },
    })
    expect(() => supervisor.start([atMe], () => undefined)).toThrowError(/owner identity is required/)
    expect(spawns).toEqual([])
    expect(supervisor.health()).toEqual({ state: 'stopped', running: false, targets: [] })
    await supervisor.stop()
  })
})

describe('dry-run sends are skipped', () => {
  it('reports skipped with no receipt and never spawns dws', async () => {
    const ledger = join(tempDir(), 'ledger.jsonl')
    const instance = new DingTalkChannel({
      settingsProvider: () => settings({ advanced: { dryRun: true } }),
      logger: logger(),
      ownerUserId: 'u-owner',
      command: process.execPath,
      baseArgs: [fakeDws],
      env: { ...process.env, FAKE_DWS_LEDGER: ledger },
    })
    const detail = await instance.sendWithReceipt({
      id: 'out-2',
      idempotencyKey: 'key-2',
      kind: 'reply',
      target: { kind: 'group', conversationId: 'cid-1' },
      text: 'hello',
      status: 'pending',
      attempts: 0,
      lastError: null,
      sentAt: null,
      receipt: null,
    })
    expect(detail).toEqual({ result: 'skipped' })
    expect(existsSync(ledger)).toBe(false)
  })
})

describe('media-only events', () => {
  it('skips a media-only message but keeps a captioned one', () => {
    const mediaOnly = normalizeEvent(
      { ...atEvent, msgtype: 'picture', text: undefined },
      { ownerUserId: 'u-owner', target: atMe },
    )
    expect(mediaOnly).toMatchObject({ skip: 'unsupported', detail: 'media-only' })

    const captioned = normalizeEvent(
      { ...atEvent, msgtype: 'picture', text: '看这张截图' },
      { ownerUserId: 'u-owner', target: atMe },
    )
    expect('skip' in captioned).toBe(false)
    if (!('skip' in captioned)) expect(captioned.text).toBe('看这张截图')
  })
})

describe('redaction of quoted JSON', () => {
  it('masks a quoted JSON credential pair', () => {
    const text = redact('{"clientSecret":"s3cr3t","chatId":"cid-1","safe":"ok"}')
    expect(text).not.toContain('s3cr3t')
    expect(text).not.toContain('cid-1')
    expect(text).toContain('"safe":"ok"')
  })
})
