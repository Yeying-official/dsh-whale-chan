/**
 * T2 evidence: non-interactive sends need `--yes`, and the receipt fields are
 * `openMessageId` / `deliveryStatus` / `idempotencyKey`.
 *
 * These regressions live together so the fix commit (which also updates the
 * existing sender expectations) stays green on its own.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Outbound } from '../src/core/model.ts'
import { SettingsSchema, type Settings } from '../src/shared/settings.ts'
import { createRunner, runOnce } from '../src/channel/process.ts'
import { buildSendArgs, classifySendOutcome, sendDetailed } from '../src/channel/sender.ts'
import type { CommandRunner } from '../src/channel/types.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))

function settings(): Settings {
  return SettingsSchema.parse({})
}

function outbound(): Outbound {
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
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws2-confirm-'))
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

describe('non-interactive send confirmation', () => {
  it('maps a send without --yes to failed, not unknown, and writes no ledger row', async () => {
    const ledger = join(tempDir(), 'ledger.jsonl')
    const args = buildSendArgs(outbound(), settings()).filter((argument) => argument !== '--yes')
    const result = await runOnce({
      command: process.execPath,
      baseArgs: [fakeDws],
      args,
      env: { ...process.env, FAKE_DWS_LEDGER: ledger },
      timeoutMs: 5_000,
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('confirmation_required')
    expect(classifySendOutcome(result).result).toBe('failed')
    expect(ledgerEntries(ledger)).toEqual([])
  })

  it('treats a non-delivered delivery status as unknown', async () => {
    const { runner } = fakeRunner({ FAKE_DWS_DELIVERY_STATUS: 'unknown' })
    const detail = await sendDetailed(outbound(), settings(), { runner })
    expect(detail.result).toBe('unknown')
    expect(detail.error).toContain('deliveryStatus=unknown')
  })

  it('treats a duplicate idempotency key as unknown and keeps one ledger row', async () => {
    const { runner, ledger } = fakeRunner({ FAKE_DWS_SEND_RESULT: 'sent' })
    const first = await sendDetailed(outbound(), settings(), { runner })
    expect(first.result).toBe('sent')
    const second = await sendDetailed(outbound(), settings(), { runner })
    expect(second.result).toBe('unknown')
    expect(second.error).toContain('duplicate idempotency key')
    expect(ledgerEntries(ledger)).toHaveLength(1)
  })
})
