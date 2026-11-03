/**
 * `--ttl` must be a Go duration.
 *
 * T1 on a real host showed that `--ttl 1` is rejected with
 * `time: missing unit in duration "1"`; these tests pin the duration format at
 * every layer: the spec builder, the fake executable and the validate path.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRunner, runOnce } from '../src/channel/process.ts'
import { consumeSpec, ttlDuration } from '../src/channel/targets.ts'
import type { DwsTarget } from '../src/channel/types.ts'
import { validateTarget } from '../src/channel/validate.ts'
import { SettingsSchema, type Settings } from '../src/shared/settings.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))

function settings(hours = 24): Settings {
  return SettingsSchema.parse({ dws: { eventTtlHours: hours } })
}

const atMe: DwsTarget = { kind: 'at-me', id: 'at-me', mentionOnly: true, enabled: true }
const group: DwsTarget = { kind: 'group', id: 'cid-1', mentionOnly: true, enabled: true }

function traceArgv(file: string): string[] {
  if (!existsSync(file)) return []
  const entries = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { phase: string; argv?: string[] })
  return entries.find((entry) => entry.phase === 'start')?.argv ?? []
}

describe('ttl duration', () => {
  it('formats whole hours as a Go duration', () => {
    expect(ttlDuration(1)).toBe('1h')
    expect(ttlDuration(24)).toBe('24h')
  })

  it('writes the duration into the consume spec, not a bare number', () => {
    expect(consumeSpec(atMe, settings(1)).args.slice(-2)).toEqual(['--ttl', '1h'])
    expect(consumeSpec(atMe, settings(24)).args).toContain('24h')
    expect(consumeSpec(atMe, settings(24)).args).not.toContain('24')
  })

  it('surfaces the duration validation that real dws applies', async () => {
    const result = await runOnce({
      command: process.execPath,
      baseArgs: [fakeDws],
      args: ['event', 'consume', 'user_im_message_receive_at', '--flatten', '-f', 'ndjson', '--ttl', '1', '--dry-run'],
      timeoutMs: 5_000,
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('time: missing unit in duration')
  })

  it('passes the duration unit through the validate dry-run argv', async () => {
    const trace = join(mkdtempSync(join(tmpdir(), 'ws2-ttl-')), 'trace.jsonl')
    const runner = createRunner({
      command: process.execPath,
      baseArgs: [fakeDws],
      env: { ...process.env, FAKE_DWS_TRACE: trace },
    })
    await expect(validateTarget(group, settings(24), { runner })).resolves.toEqual({ valid: true })
    const argv = traceArgv(trace)
    expect(argv[argv.indexOf('--ttl') + 1]).toBe('24h')
  })
})
