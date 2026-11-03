import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Outbound } from '../src/core/model.ts'
import { SettingsSchema, type Settings } from '../src/shared/settings.ts'
import { createRunner } from '../src/channel/process.ts'
import { buildSendArgs, classifySendOutcome, send, sendDetailed } from '../src/channel/sender.ts'
import type { CommandResult, CommandRunner } from '../src/channel/types.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))

function settings(): Settings {
  return SettingsSchema.parse({})
}

function outbound(patch: Partial<Outbound> = {}): Outbound {
  return {
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
    ...patch,
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws2-send-'))
}

function ledgerEntries(file: string): Array<{ argv: string[] }> {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { argv: string[] })
}

function fakeRunner(extraEnv: Record<string, string>): { runner: CommandRunner; ledger: string } {
  const ledger = join(tempDir(), 'ledger.jsonl')
  const runner = createRunner({
    command: process.execPath,
    baseArgs: [fakeDws],
    env: { ...process.env, FAKE_DWS_LEDGER: ledger, ...extraEnv },
  })
  return { runner, ledger }
}

function result(patch: Partial<CommandResult>): CommandResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...patch }
}

describe('buildSendArgs', () => {
  it('builds the documented group send with the idempotency key and AI tag', () => {
    expect(buildSendArgs(outbound(), settings())).toEqual([
      'chat',
      '+messages-send',
      '--as',
      'user',
      '--ai-tag',
      '--idempotency-key',
      'key-1',
      '--wait-delivery',
      '-f',
      'json',
      '--yes',
      '--chat-id',
      'cid-1',
      '--markdown',
      'hello',
    ])
  })

  it('answers an at-me message inside its conversation', () => {
    const args = buildSendArgs(outbound({ target: { kind: 'at-me', conversationId: 'cid-9' } }), settings())
    expect(args[args.indexOf('--chat-id') + 1]).toBe('cid-9')
  })

  it('addresses a one-to-one peer by user id', () => {
    const args = buildSendArgs(
      outbound({ target: { kind: 'dm', conversationId: 'u-peer', peerUserId: 'u-peer' } }),
      settings(),
    )
    expect(args).toContain('--user')
    expect(args[args.indexOf('--user') + 1]).toBe('u-peer')
    expect(args).not.toContain('--chat-id')
  })

  it('uses the open id flag for a prefixed peer id and adds the profile last', () => {
    const args = buildSendArgs(
      outbound({ target: { kind: 'dm', conversationId: 'open:od-1' } }),
      SettingsSchema.parse({ dws: { profile: 'work' } }),
    )
    expect(args).toContain('--open-dingtalk-id')
    expect(args[args.indexOf('--open-dingtalk-id') + 1]).toBe('od-1')
    expect(args.slice(-2)).toEqual(['--profile', 'work'])
  })

  it('refuses a message without an idempotency key or without text', () => {
    expect(() => buildSendArgs(outbound({ idempotencyKey: '  ' }), settings())).toThrow(/idempotency/i)
    expect(() => buildSendArgs(outbound({ text: '   ' }), settings())).toThrow(/no text/i)
  })
})

describe('send with the fake dws', () => {
  it('returns sent with the open message id and records --yes in the ledger', async () => {
    const { runner, ledger } = fakeRunner({ FAKE_DWS_SEND_RESULT: 'sent' })
    const detail = await sendDetailed(outbound(), settings(), { runner })
    expect(detail.result).toBe('sent')
    expect(detail.receipt).toMatch(/^msg0\//)
    const entries = ledgerEntries(ledger)
    expect(entries).toHaveLength(1)
    const argv = entries[0]?.argv ?? []
    expect(argv).toContain('--yes')
    expect(argv[argv.indexOf('--idempotency-key') + 1]).toBe('key-1')
    expect(argv).not.toContain('--text')
    expect(argv[argv.indexOf('--markdown') + 1]).toBe('hello')
  })

  it('returns failed when dws rejects the message', async () => {
    const { runner, ledger } = fakeRunner({ FAKE_DWS_SEND_RESULT: 'failed' })
    const detail = await sendDetailed(outbound(), settings(), { runner })
    expect(detail.result).toBe('failed')
    expect(detail.error).toBeTruthy()
    expect(ledgerEntries(ledger)).toHaveLength(1)
  })

  it('returns gone when the target no longer exists', async () => {
    const { runner } = fakeRunner({ FAKE_DWS_SEND_RESULT: 'gone' })
    const detail = await sendDetailed(outbound(), settings(), { runner })
    expect(detail.result).toBe('gone')
  })

  it('returns unknown on a timeout, which forbids a retry', async () => {
    const { runner } = fakeRunner({ FAKE_DWS_SEND_RESULT: 'unknown', FAKE_DWS_SEND_SLEEP_MS: '60000' })
    const started = Date.now()
    const outcome = await send(outbound(), settings(), { runner, timeoutMs: 200 })
    expect(outcome).toBe('unknown')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('never spawns a send without an idempotency key', async () => {
    const { runner, ledger } = fakeRunner({})
    const detail = await sendDetailed(outbound({ idempotencyKey: '' }), settings(), { runner })
    expect(detail.result).toBe('failed')
    expect(detail.error).toMatch(/idempotency/i)
    expect(ledgerEntries(ledger)).toEqual([])
  })
})

describe('classifySendOutcome', () => {
  it('treats exit 0 without a receipt as unknown', () => {
    expect(classifySendOutcome(result({ stdout: '' })).result).toBe('unknown')
    expect(classifySendOutcome(result({ stdout: '{"unknownField":1}' })).result).toBe('unknown')
  })

  it('reads a confirming receipt', () => {
    expect(classifySendOutcome(result({ stdout: '{"success":true,"messageId":"m-9"}' }))).toMatchObject({
      result: 'sent',
      receipt: 'm-9',
    })
  })

  it('maps an unclassified non-zero exit to unknown, never failed', () => {
    expect(classifySendOutcome(result({ code: 1, stderr: 'unexpected explosion' })).result).toBe('unknown')
  })

  it('recognizes a missing target and a definite rejection', () => {
    expect(
      classifySendOutcome(result({ code: 1, stdout: '{"success":false,"errorCode":"chat_not_found"}' })).result,
    ).toBe('gone')
    expect(
      classifySendOutcome(result({ code: 1, stdout: '{"success":false,"message":"invalid request"}' })).result,
    ).toBe('failed')
  })

  it('maps a spawn failure to failed and a timeout to unknown', () => {
    expect(classifySendOutcome(result({ code: null, error: 'spawn dws ENOENT' })).result).toBe('failed')
    expect(classifySendOutcome(result({ code: null, timedOut: true })).result).toBe('unknown')
  })
})
