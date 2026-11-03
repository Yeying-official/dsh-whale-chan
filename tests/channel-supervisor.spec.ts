import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { InboundMessage } from '../src/core/model.ts'
import { SettingsSchema, type Settings } from '../src/shared/settings.ts'
import { ChannelSupervisor } from '../src/channel/supervisor.ts'
import type { SpawnFn } from '../src/channel/process.ts'
import type { ChannelLogger, DwsTarget } from '../src/channel/types.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws2-supervisor-'))
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra }
}

function settings(): Settings {
  return SettingsSchema.parse({ monitor: { intervalSeconds: 15 } })
}

function writeJson(directory: string, name: string, value: unknown): string {
  const file = join(directory, name)
  writeFileSync(file, JSON.stringify(value), 'utf8')
  return file
}

function readTrace(file: string): Array<{ phase: string; reason?: string }> {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { phase: string; reason?: string })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
}

function captureLogger(): { logger: ChannelLogger; lines: string[] } {
  const lines: string[] = []
  const push = (level: string) => (message: string) => lines.push(`${level}:${message}`)
  return { lines, logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') } }
}

const atMe: DwsTarget = { kind: 'at-me', id: 'at-me', mentionOnly: true, enabled: true }
const group: DwsTarget = { kind: 'group', id: 'cid-1', label: '测试群', mentionOnly: true, enabled: true }
const ownerUserId = 'u-owner'

const atEvent = {
  eventType: 'user_im_message_receive_at',
  msgId: 'm-at',
  conversationId: 'cid-1',
  conversationType: 'group',
  senderStaffId: 'u-alice',
  senderNick: 'Alice',
  text: '@鲸鱼酱 hi',
  atUsers: ['u-owner'],
}
function groupLine(msgId: string, text: string) {
  return {
    msgId,
    conversationId: 'cid-1',
    conversationType: 'group',
    senderStaffId: 'u-bob',
    senderNick: 'Bob',
    text,
    atUsers: ['u-owner'],
  }
}

const groupEvent = {
  msgId: 'm-group',
  conversationId: 'cid-1',
  conversationType: 'group',
  senderStaffId: 'u-bob',
  senderNick: 'Bob',
  text: '@我 在吗',
  atUsers: ['u-owner'],
}

function createSupervisor(
  targets: readonly DwsTarget[],
  sink: (message: InboundMessage) => void | Promise<void>,
  extraEnv: Record<string, string>,
  options: { backoff?: { baseMs?: number; maxMs?: number } } = {},
) {
  const directory = tempDir()
  const traceFile = join(directory, 'trace.jsonl')
  const { logger, lines } = captureLogger()
  const supervisor = new ChannelSupervisor({
    settings: settings(),
    logger,
    ownerUserId,
    command: process.execPath,
    baseArgs: [fakeDws],
    env: env({ ...extraEnv, FAKE_DWS_TRACE: traceFile }),
    graceMs: 2_000,
    termMs: 500,
    ...options,
  })
  supervisor.start(targets, sink)
  return { supervisor, lines, traceFile, directory }
}

describe('ChannelSupervisor lifecycle', () => {
  it('subscribes each enabled target and tags events with its target id', async () => {
    const received: InboundMessage[] = []
    const directory = tempDir()
    const eventsFile = writeJson(directory, 'events.json', [atEvent, groupEvent])
    const { supervisor } = createSupervisor(
      [atMe, group],
      (message) => {
        received.push(message)
      },
      {
        FAKE_DWS_EVENTS: eventsFile,
      },
    )
    expect(await supervisor.whenReady(3_000)).toBe(true)
    expect(supervisor.health().state).toBe('ready')
    expect(supervisor.health().targets.map((target) => target.state)).toEqual(['ready', 'ready'])
    expect(supervisor.health().targets[0]?.subscribeId).toMatch(/^sub-/)

    await waitFor(() => received.some((message) => message.targetId === 'at-me'))
    await waitFor(() => received.some((message) => message.targetId === 'cid-1'))
    const targetIds = new Set(received.map((message) => message.targetId))
    expect(targetIds).toEqual(new Set(['at-me', 'cid-1']))
    await supervisor.stop()
    expect(supervisor.health()).toEqual({ state: 'stopped', running: false, targets: [] })
  })

  it('delivers events to a slow sink in arrival order', async () => {
    const directory = tempDir()
    const eventsFile = writeJson(directory, 'events.json', [
      groupLine('m-1', 'one'),
      groupLine('m-2', 'two'),
      groupLine('m-3', 'three'),
      groupLine('m-4', 'four'),
    ])
    const received: string[] = []
    const { supervisor } = createSupervisor(
      [atMe],
      async (message) => {
        // The first delivery is slow; later events must still queue behind it.
        if (message.id === 'm-1') await new Promise<void>((resolve) => setTimeout(resolve, 40))
        received.push(message.id)
      },
      { FAKE_DWS_EVENTS: eventsFile },
    )
    expect(await supervisor.whenReady(3_000)).toBe(true)
    await waitFor(() => received.length === 4)
    expect(received).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
    await supervisor.stop()
  })

  it('isolates a throwing sink and keeps delivering', async () => {
    const directory = tempDir()
    const eventsFile = writeJson(directory, 'events.json', [groupLine('m-1', 'one'), groupLine('m-2', 'two')])
    const received: string[] = []
    const { supervisor, lines } = createSupervisor(
      [atMe],
      (message) => {
        if (message.id === 'm-1') throw new Error('sink failed')
        received.push(message.id)
      },
      { FAKE_DWS_EVENTS: eventsFile },
    )
    expect(await supervisor.whenReady(3_000)).toBe(true)
    await waitFor(() => received.includes('m-2'))
    expect(lines.some((line) => line.startsWith('warn:') && line.includes('sink failed'))).toBe(true)
    await supervisor.stop()
  })

  it('counts malformed lines and forwards duplicates (the domain deduplicates by id)', async () => {
    const directory = tempDir()
    const eventsFile = writeJson(directory, 'events.json', [atEvent, 'this is not json', atEvent])
    const received: InboundMessage[] = []
    const { supervisor } = createSupervisor(
      [atMe],
      (message) => {
        received.push(message)
      },
      {
        FAKE_DWS_EVENTS: eventsFile,
      },
    )
    expect(await supervisor.whenReady(3_000)).toBe(true)
    await waitFor(() => received.length === 2)
    expect(received.map((message) => message.id)).toEqual(['m-at', 'm-at'])
    await waitFor(() => (supervisor.health().targets[0]?.malformed ?? 0) === 1)
    await supervisor.stop()
  })

  it('stops one target without disturbing the other', async () => {
    const { supervisor } = createSupervisor([atMe, group], () => undefined, {})
    expect(await supervisor.whenReady(3_000)).toBe(true)
    await supervisor.stopTarget('cid-1')
    const health = supervisor.health()
    expect(health.targets.find((target) => target.targetId === 'cid-1')?.state).toBe('stopped')
    expect(health.targets.find((target) => target.targetId === 'at-me')?.state).toBe('ready')
    expect(health.state).toBe('degraded')
    await supervisor.stop()
  })
})

/** A child that reports ready and never exits; the `event stop` call closes cleanly. */
function readyStubSpawn(spawns: string[][]): SpawnFn {
  return (_command, args) => {
    spawns.push([...args])
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
    const stdin = Object.assign(new EventEmitter(), { end: () => undefined, write: () => undefined })
    const child = Object.assign(new EventEmitter(), {
      pid: 777,
      stdout,
      stderr,
      stdin,
      kill: () => true,
    }) as unknown as ChildProcess
    if (args.includes('stop')) {
      setImmediate(() => (child as unknown as EventEmitter).emit('close', 0, null))
    } else {
      setImmediate(() =>
        stderr.emit(
          'data',
          `[event] ready event_key=user_im_message_receive_at bus_pid=777 subscribe_id=sub-cleanup${String.fromCharCode(10)}`,
        ),
      )
    }
    return child
  }
}

describe('ChannelSupervisor recovery', () => {
  it('restarts a crashing subscription with bounded exponential backoff and never overlaps', async () => {
    const { supervisor, traceFile, lines } = createSupervisor(
      [atMe],
      () => undefined,
      { FAKE_DWS_EXIT: '2' },
      {
        backoff: { baseMs: 20, maxMs: 60 },
      },
    )
    await waitFor(() => readTrace(traceFile).filter((entry) => entry.phase === 'start').length >= 4, 6_000)
    expect(supervisor.health().targets[0]?.restarts).toBeGreaterThanOrEqual(3)
    expect(lines.some((line) => line.startsWith('warn:') && line.includes('exit code=2'))).toBe(true)
    await supervisor.stop()

    let open = false
    let starts = 0
    for (const entry of readTrace(traceFile)) {
      if (entry.phase === 'start') {
        expect(open, 'a new process started while the previous one was still open').toBe(false)
        open = true
        starts += 1
      } else if (entry.phase === 'exit') {
        expect(open, 'an exit was recorded without a matching start').toBe(true)
        open = false
      }
    }
    expect(starts).toBeGreaterThanOrEqual(4)
  })

  it('marks an invalid target failed without scheduling a restart', async () => {
    const invalid: DwsTarget = { kind: 'dm', id: 'open:', mentionOnly: true, enabled: true }
    const { supervisor } = createSupervisor([invalid], () => undefined, {})
    await waitFor(() => supervisor.health().targets[0]?.state === 'failed')
    const health = supervisor.health().targets[0]
    expect(health?.restarts).toBe(0)
    expect(health?.lastError).toContain('invalid-target')
    expect(supervisor.health().state).toBe('degraded')
    expect(await supervisor.whenReady(100)).toBe(false)
    await supervisor.stop()
  })

  it('converges every child on stop without SIGKILL', async () => {
    const { supervisor, traceFile } = createSupervisor([atMe, group], () => undefined, {})
    expect(await supervisor.whenReady(3_000)).toBe(true)
    await supervisor.stop()
    expect(supervisor.running).toBe(false)
    expect(supervisor.health().targets).toEqual([])
    const trace = readTrace(traceFile)
    const exits = trace.filter((entry) => entry.phase === 'exit')
    expect(exits.length).toBeGreaterThanOrEqual(2)
    expect(exits.every((entry) => entry.reason === 'stdin-end')).toBe(true)
    expect(trace.some((entry) => entry.phase === 'signal')).toBe(false)
  })

  it('requests best-effort subscription cleanup when a process is orphaned', async () => {
    const spawns: string[][] = []
    const { logger } = captureLogger()
    const supervisor = new ChannelSupervisor({
      settings: settings(),
      logger,
      ownerUserId,
      command: 'unused',
      spawn: readyStubSpawn(spawns),
      graceMs: 20,
      termMs: 20,
    })
    supervisor.start([atMe], () => undefined)
    await waitFor(() => supervisor.health().targets[0]?.state === 'ready')
    await supervisor.stopTarget('at-me')
    expect(supervisor.health().targets[0]?.state).toBe('orphaned')
    await waitFor(() => spawns.some((args) => args.includes('stop')))
    const cleanup = spawns.find((args) => args.includes('stop'))
    expect(cleanup).toEqual(['event', 'stop', 'sub-cleanup', '--yes'])
    await supervisor.stop()
  })
})
