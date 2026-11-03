import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SettingsSchema, type Settings } from '../src/shared/settings.ts'
import { probeAuth, parseVersion } from '../src/channel/auth.ts'
import { discoverGroups, discoverPeers } from '../src/channel/discover.ts'
import { createRunner } from '../src/channel/process.ts'
import { validateTarget } from '../src/channel/validate.ts'
import type { CommandResult, CommandRunner, DwsTarget } from '../src/channel/types.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))

function settings(): Settings {
  return SettingsSchema.parse({})
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws2-discover-'))
}

function writeJson(directory: string, name: string, value: unknown): string {
  const file = join(directory, name)
  writeFileSync(file, JSON.stringify(value), 'utf8')
  return file
}

/** A runner that records every argv before delegating to the fake executable. */
function captureRunner(extraEnv: Record<string, string> = {}): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = []
  const inner = createRunner({
    command: process.execPath,
    baseArgs: [fakeDws],
    env: { ...process.env, ...extraEnv },
  })
  return {
    calls,
    runner: {
      run: (args, options) => {
        calls.push([...args])
        return inner.run(args, options)
      },
    },
  }
}

const atMe: DwsTarget = { kind: 'at-me', id: 'at-me', mentionOnly: true, enabled: true }
const group: DwsTarget = { kind: 'group', id: 'cid-1', mentionOnly: true, enabled: true }

describe('discoverGroups', () => {
  it('returns explicit candidates and filters by the search query', async () => {
    const chats = writeJson(tempDir(), 'chats.json', {
      groups: [
        { name: 'AI工程师孵化中心', openConversationId: 'cid-1' },
        { name: '产品讨论', openConversationId: 'cid-2' },
        { name: 'AI 测试群', openConversationId: 'cid-3' },
      ],
    })
    const { runner, calls } = captureRunner({ FAKE_DWS_CHATS: chats })
    const candidates = await discoverGroups('AI', settings(), { runner })
    expect(candidates).toEqual([
      { kind: 'group', id: 'cid-1', label: 'AI工程师孵化中心', source: 'chat-search' },
      { kind: 'group', id: 'cid-3', label: 'AI 测试群', source: 'chat-search' },
    ])
    expect(calls[0]).toEqual(['chat', '+chat-search', '--query', 'AI', '--limit', '50', '--format', 'json'])
  })

  it('caps the result set and removes duplicate ids', async () => {
    const groups = Array.from({ length: 60 }, (_value, index) => ({
      name: `group-${index}`,
      openConversationId: `cid-${index}`,
    }))
    groups.push({ name: 'group-duplicate', openConversationId: 'cid-1' })
    const chats = writeJson(tempDir(), 'chats.json', { groups })
    const candidates = await discoverGroups('group', settings(), {
      runner: captureRunner({ FAKE_DWS_CHATS: chats }).runner,
    })
    expect(candidates).toHaveLength(50)
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(50)
  })

  it('rejects an empty query before spawning dws', async () => {
    const { runner, calls } = captureRunner()
    await expect(discoverGroups('  ', settings(), { runner })).rejects.toMatchObject({ code: 'invalid-target' })
    expect(calls).toEqual([])
  })

  it('reports non-JSON output as a typed channel error', async () => {
    const { runner } = captureRunner({ FAKE_DWS_CHATS_MODE: 'text' })
    await expect(discoverGroups('x', settings(), { runner })).rejects.toMatchObject({ code: 'dws-output' })
  })

  it('reports a failed command as dws-failed with redacted stderr', async () => {
    const { runner } = captureRunner({ FAKE_DWS_CHAT_EXIT: '3' })
    await expect(discoverGroups('x', settings(), { runner })).rejects.toMatchObject({ code: 'dws-failed' })
  })
})

describe('discoverPeers', () => {
  it('prefers a user id and prefixes peers known only by open id', async () => {
    const chats = writeJson(tempDir(), 'chats.json', {
      peers: [
        { userId: 'u-1', name: '张三', openDingTalkId: 'od-1' },
        { openDingTalkId: 'od-2', name: '李四' },
        { openConversationId: 'oc-1', name: '王五', userId: 'u-3' },
        { name: '没有 id' },
      ],
    })
    const { runner, calls } = captureRunner({ FAKE_DWS_CHATS: chats })
    const candidates = await discoverPeers(undefined, settings(), { runner })
    expect(candidates).toEqual([
      { kind: 'dm', id: 'u-1', label: '张三', source: 'chat-list' },
      { kind: 'dm', id: 'open:od-2', label: '李四', source: 'chat-list' },
      { kind: 'dm', id: 'u-3', label: '王五', source: 'chat-list' },
    ])
    expect(calls[0]).toEqual(['chat', '+chat-list', '--types', 'p2p', '--page-size', '50', '--format', 'json'])
  })

  it('filters peers locally because the command has no confirmed query flag', async () => {
    const chats = writeJson(tempDir(), 'chats.json', {
      peers: [
        { userId: 'u-1', name: '张三' },
        { userId: 'u-2', name: '李四' },
      ],
    })
    const candidates = await discoverPeers('李', settings(), {
      runner: captureRunner({ FAKE_DWS_CHATS: chats }).runner,
    })
    expect(candidates.map((candidate) => candidate.id)).toEqual(['u-2'])
  })
})

describe('validateTarget', () => {
  it('accepts a dry-run plan for an at-me target', async () => {
    const { runner, calls } = captureRunner()
    const result = await validateTarget(atMe, settings(), { runner })
    expect(result).toEqual({ valid: true })
    expect(calls[0]?.at(-1)).toBe('--dry-run')
    expect(calls[0]).toContain('event')
    expect(calls[0]).toContain('consume')
  })

  it('accepts a dry-run plan for a group target without creating a subscription', async () => {
    const { runner, calls } = captureRunner()
    await expect(validateTarget(group, settings(), { runner })).resolves.toEqual({ valid: true })
    expect(calls[0]).toContain('--dry-run')
    expect(calls[0]).toContain('--group')
  })

  it('rejects a plan dws refuses', async () => {
    const { runner } = captureRunner({ FAKE_DWS_DRY_RUN_EXIT: '3' })
    const result = await validateTarget(group, settings(), { runner })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('3')
  })

  it('rejects an empty target id without spawning dws', async () => {
    const { runner, calls } = captureRunner()
    const result = await validateTarget({ ...group, id: ' ' }, settings(), { runner })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('invalid-target')
    expect(calls).toEqual([])
  })
})

describe('probeAuth', () => {
  it('returns version, booleans and expiry but never the account payload', async () => {
    const { runner } = captureRunner()
    const state = await probeAuth(settings(), { runner })
    expect(state).toEqual({
      available: true,
      version: '1.0.66-fake',
      authenticated: true,
      tokenValid: true,
      expiresAt: '2099-12-31T00:00:00.000Z',
    })
    expect(Object.keys(state).sort()).toEqual(['authenticated', 'available', 'expiresAt', 'tokenValid', 'version'])
  })

  it('degrades an unparseable status payload to not authenticated', async () => {
    const { runner } = captureRunner({ FAKE_DWS_AUTH_RAW: 'not-json' })
    await expect(probeAuth(settings(), { runner })).resolves.toEqual({
      available: true,
      version: '1.0.66-fake',
      authenticated: false,
      tokenValid: false,
    })
  })

  it('degrades a missing binary to available=false instead of throwing', async () => {
    const state = await probeAuth(SettingsSchema.parse({ dws: { binaryPath: join(tempDir(), 'dws-does-not-exist') } }))
    expect(state).toEqual({ available: false, authenticated: false, tokenValid: false })
  })

  it('degrades a failing version command to available=false', async () => {
    const failing: CommandRunner = {
      run: async (): Promise<CommandResult> => ({
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'boom',
        timedOut: false,
      }),
    }
    await expect(probeAuth(settings(), { runner: failing })).resolves.toEqual({
      available: false,
      authenticated: false,
      tokenValid: false,
    })
  })

  it('parses a version out of a decorated banner and converts an epoch expiry', async () => {
    expect(parseVersion('dws version 1.0.66 (build abc)')).toBe('1.0.66')
    const { runner } = captureRunner({
      FAKE_DWS_AUTH_RAW: '{"authenticated":true,"token_valid":false,"expires_at":1760000000000}',
    })
    const state = await probeAuth(settings(), { runner })
    expect(state).toMatchObject({ authenticated: true, tokenValid: false, expiresAt: '2025-10-09T08:53:20.000Z' })
  })
})
