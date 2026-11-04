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
  it('reads the contact directory, prefers userId and prefixes open-only contacts', async () => {
    const contacts = writeJson(tempDir(), 'contacts.json', {
      result: [
        { name: '张三', nick: '张三测试', userId: '260111', openDingTalkId: 'DO2-1', title: '' },
        { name: '李四', nick: '李四测试', openDingTalkId: 'DO2-2', title: '' },
        { name: '王五', nick: '王五测试', userId: '260113', openDingTalkId: 'DO2-3', title: '' },
        { name: '赵六', nick: '赵六测试', title: '' },
      ],
    })
    const { runner, calls } = captureRunner({ FAKE_DWS_CONTACTS: contacts })
    const candidates = await discoverPeers('测试', settings(), { runner })
    expect(candidates).toEqual([
      {
        kind: 'dm',
        id: '260111',
        label: '张三测试',
        description: 'userId: 260111 · openDingTalkId: DO2-1',
        source: 'contact-search',
      },
      { kind: 'dm', id: 'open:DO2-2', label: '李四测试', source: 'contact-search' },
      {
        kind: 'dm',
        id: '260113',
        label: '王五测试',
        description: 'userId: 260113 · openDingTalkId: DO2-3',
        source: 'contact-search',
      },
    ])
    expect(calls[0]).toEqual(['contact', 'user', 'search', '--query', '测试', '--format', 'json'])
  })

  it('keeps a contact dws matched by name even when the nick does not contain the query', async () => {
    const contacts = writeJson(tempDir(), 'contacts.json', {
      result: [{ name: 'Alice', nick: 'YY', userId: '260111', openDingTalkId: 'DO2-name-match' }],
    })
    const candidates = await discoverPeers('Alice', settings(), {
      runner: captureRunner({ FAKE_DWS_CONTACTS: contacts }).runner,
    })
    expect(candidates).toEqual([
      {
        kind: 'dm',
        id: '260111',
        label: 'YY',
        description: 'userId: 260111 · openDingTalkId: DO2-name-match',
        source: 'contact-search',
      },
    ])
  })

  it('requires a contact name before spawning dws', async () => {
    const { runner, calls } = captureRunner()
    await expect(discoverPeers(undefined, settings(), { runner })).rejects.toMatchObject({ code: 'invalid-target' })
    await expect(discoverPeers('  ', settings(), { runner })).rejects.toThrow(/contact name/)
    expect(calls).toEqual([])
  })

  it('reports non-JSON contact output as a typed channel error', async () => {
    const { runner } = captureRunner({ FAKE_DWS_CONTACTS_MODE: 'text' })
    await expect(discoverPeers('张', settings(), { runner })).rejects.toMatchObject({ code: 'dws-output' })
  })

  it('reports a failed contact search as dws-failed', async () => {
    const { runner } = captureRunner({ FAKE_DWS_CONTACT_EXIT: '3' })
    await expect(discoverPeers('张', settings(), { runner })).rejects.toMatchObject({ code: 'dws-failed' })
  })

  it('caps the contact result set and removes duplicate identities', async () => {
    const result = Array.from({ length: 60 }, (_value, index) => ({
      name: `person-${index}`,
      nick: `person-${index}`,
      userId: `u-${index}`,
      openDingTalkId: `DO2-${index}`,
    }))
    result.push({ name: 'person-dup', nick: 'person-dup', userId: 'u-1', openDingTalkId: 'DO2-dup' })
    const contacts = writeJson(tempDir(), 'contacts.json', { result })
    const candidates = await discoverPeers('person', settings(), {
      runner: captureRunner({ FAKE_DWS_CONTACTS: contacts }).runner,
    })
    expect(candidates).toHaveLength(50)
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(50)
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

  it('reports a conversation id in a dm target as invalid without spawning dws', async () => {
    const { runner, calls } = captureRunner()
    const dm = { kind: 'dm', id: 'cid-abc=', mentionOnly: true, enabled: true } as const
    const result = await validateTarget(dm, settings(), { runner })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('conversation id')
    expect(calls).toEqual([])
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
