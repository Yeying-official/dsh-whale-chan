import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createLineSplitter,
  DwsProcess,
  parseReadyLine,
  runOnce,
  type DwsExitInfo,
  type ReadyInfo,
  type SpawnFn,
} from '../src/channel/process.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws2-process-'))
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra }
}

function writeJson(directory: string, name: string, value: unknown): string {
  const file = join(directory, name)
  writeFileSync(file, JSON.stringify(value), 'utf8')
  return file
}

interface TraceEntry {
  phase: string
  signal?: string
  reason?: string
}

function readTrace(file: string): TraceEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TraceEntry)
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
}

interface StubChild {
  readonly child: ChildProcess
  readonly kills: readonly string[]
  readonly stdinEnded: () => boolean
  emitClose(code?: number | null, signal?: string | null): void
}

/** A child that never exits on its own; it records stop attempts deterministically. */
function stubChild(): StubChild {
  const kills: string[] = []
  let stdinEnded = false
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  const stdin = Object.assign(new EventEmitter(), {
    end: () => {
      stdinEnded = true
    },
  })
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout,
    stderr,
    stdin,
    kill: (signal: string) => {
      kills.push(signal)
      return true
    },
  })
  return {
    child: child as unknown as ChildProcess,
    kills,
    stdinEnded: () => stdinEnded,
    emitClose: (code = 0, signal = null) => child.emit('close', code, signal),
  }
}

function noopSpawn(child: ChildProcess): SpawnFn {
  return (_command: string, _args: readonly string[], _options: SpawnOptions) => child
}

describe('ready line parsing', () => {
  it('reads event key, bus pid and subscribe id', () => {
    expect(parseReadyLine('[event] ready event_key=user_im_message_receive_at bus_pid=42 subscribe_id=sub-1')).toEqual({
      eventKey: 'user_im_message_receive_at',
      subscribeId: 'sub-1',
      busPid: '42',
    })
  })

  it('rejects a ready line without a subscribe id or any other line', () => {
    expect(parseReadyLine('[event] ready event_key=k bus_pid=42')).toBeUndefined()
    expect(parseReadyLine('some unrelated stderr')).toBeUndefined()
  })
})

describe('line splitting', () => {
  it('keeps partial chunks, strips CRLF and flushes the last line', () => {
    const lines: string[] = []
    const splitter = createLineSplitter((line) => lines.push(line))
    splitter.push('one\ntw')
    splitter.push('o\r\n\r\nthree')
    splitter.flush()
    expect(lines).toEqual(['one', 'two', 'three'])
  })
})

describe('DwsProcess with the fake executable', () => {
  it('reports ready, forwards NDJSON lines and stops through stdin', async () => {
    const directory = tempDir()
    const traceFile = join(directory, 'trace.jsonl')
    const eventsFile = writeJson(directory, 'events.json', [
      { type: 'user_im_message_receive_at', event_id: 'e-1', message_id: 'm-1', content: 'one' },
      { type: 'user_im_message_receive_at', event_id: 'e-2', message_id: 'm-2', content: 'two' },
    ])
    const lines: string[] = []
    const ready: ReadyInfo[] = []
    const exits: DwsExitInfo[] = []
    const subscription = new DwsProcess({
      command: process.execPath,
      baseArgs: [fakeDws],
      args: ['event', 'consume', 'user_im_message_receive_at', '--flatten', '-f', 'ndjson', '--ttl', '1h'],
      env: env({ FAKE_DWS_EVENTS: eventsFile, FAKE_DWS_TRACE: traceFile }),
      graceMs: 2_000,
      onLine: (line) => lines.push(line),
      onStderrLine: () => undefined,
      onExit: (exit) => exits.push(exit),
      onReady: (info) => ready.push(info),
    })
    subscription.start()
    await waitFor(() => ready.length === 1)
    await waitFor(() => lines.length === 2)

    expect(ready[0]?.eventKey).toBe('user_im_message_receive_at')
    expect(ready[0]?.subscribeId).toMatch(/^sub-/)
    expect(lines.map((line) => JSON.parse(line).message_id)).toEqual(['m-1', 'm-2'])

    await expect(subscription.stop()).resolves.toBe('stopped')
    expect(exits).toHaveLength(1)
    expect(exits[0]?.expected).toBe(true)
    const trace = readTrace(traceFile)
    expect(trace.some((entry) => entry.phase === 'exit' && entry.reason === 'stdin-end')).toBe(true)
    // stdin end was enough; no signal was needed and certainly no SIGKILL.
    expect(trace.some((entry) => entry.phase === 'signal')).toBe(false)
  })

  it('reports an unexpected exit with expected=false', async () => {
    const directory = tempDir()
    const traceFile = join(directory, 'trace.jsonl')
    const exits: DwsExitInfo[] = []
    const subscription = new DwsProcess({
      command: process.execPath,
      baseArgs: [fakeDws],
      args: ['event', 'consume', 'user_im_message_receive_at', '--flatten', '-f', 'ndjson', '--ttl', '1h'],
      env: env({ FAKE_DWS_EXIT: '7', FAKE_DWS_TRACE: traceFile }),
      onLine: () => undefined,
      onStderrLine: () => undefined,
      onExit: (exit) => exits.push(exit),
    })
    subscription.start()
    await waitFor(() => exits.length === 1)
    expect(exits[0]).toMatchObject({ code: 7, expected: false })
  })

  it('runs the same command with --dry-run and collects a failing exit code', async () => {
    const subscription = new DwsProcess({
      command: process.execPath,
      baseArgs: [fakeDws],
      args: ['event', 'consume', 'user_im_message_receive_at', '--flatten', '-f', 'ndjson', '--ttl', '1h'],
      env: env({ FAKE_DWS_DRY_RUN_EXIT: '3' }),
      onLine: () => undefined,
      onStderrLine: () => undefined,
      onExit: () => undefined,
    })
    const result = await subscription.dryRun(2_000)
    expect(result.code).toBe(3)
    expect(result.timedOut).toBe(false)
  })
})

describe('DwsProcess stop semantics', () => {
  it('ends stdin, then sends SIGTERM, and never SIGKILL when the child ignores both', async () => {
    const stub = stubChild()
    const exits: DwsExitInfo[] = []
    const subscription = new DwsProcess({
      command: 'unused',
      args: [],
      spawn: noopSpawn(stub.child),
      graceMs: 30,
      termMs: 30,
      onLine: () => undefined,
      onStderrLine: () => undefined,
      onExit: (exit) => exits.push(exit),
    })
    subscription.start()
    const outcome = await subscription.stop()
    expect(outcome).toBe('orphaned')
    expect(stub.stdinEnded()).toBe(true)
    expect(stub.kills).toEqual(['SIGTERM'])
    expect(stub.kills).not.toContain('SIGKILL')
    expect(subscription.orphaned).toBe(true)
    // The child is still considered live; no exit was fabricated.
    expect(exits).toHaveLength(0)
  })

  it('settles as stopped when the child exits during the grace window', async () => {
    const stub = stubChild()
    const exits: DwsExitInfo[] = []
    const subscription = new DwsProcess({
      command: 'unused',
      args: [],
      spawn: noopSpawn(stub.child),
      graceMs: 1_000,
      termMs: 1_000,
      onLine: () => undefined,
      onStderrLine: () => undefined,
      onExit: (exit) => exits.push(exit),
    })
    subscription.start()
    const stopping = subscription.stop()
    stub.emitClose(0, null)
    await expect(stopping).resolves.toBe('stopped')
    expect(stub.kills).toEqual([])
    expect(exits[0]?.expected).toBe(true)
  })

  it('is idempotent and resolves stopped before start', async () => {
    const subscription = new DwsProcess({
      command: 'unused',
      args: [],
      spawn: noopSpawn(stubChild().child),
      graceMs: 10,
      termMs: 10,
      onLine: () => undefined,
      onStderrLine: () => undefined,
      onExit: () => undefined,
    })
    await expect(subscription.stop()).resolves.toBe('stopped')

    const stub = stubChild()
    const started = new DwsProcess({
      command: 'unused',
      args: [],
      spawn: noopSpawn(stub.child),
      graceMs: 10,
      termMs: 10,
      onLine: () => undefined,
      onStderrLine: () => undefined,
      onExit: () => undefined,
    })
    started.start()
    const first = started.stop()
    const second = started.stop()
    expect(first).toBe(second)
    stub.emitClose(0, null)
    await expect(first).resolves.toBe('stopped')
  })
})

describe('runOnce', () => {
  it('times out a hanging command, sends SIGTERM and reports timedOut without SIGKILL', async () => {
    const stub = stubChild()
    const result = await runOnce({
      command: 'unused',
      args: [],
      spawn: noopSpawn(stub.child),
      timeoutMs: 40,
      graceMs: 40,
    })
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
    expect(result.signal).toBe('SIGTERM')
    expect(stub.kills).toEqual(['SIGTERM'])
    expect(stub.kills).not.toContain('SIGKILL')
  })

  it('reports a spawn failure as a typed error instead of throwing', async () => {
    const result = await runOnce({
      command: join(tempDir(), 'definitely-not-a-binary'),
      args: ['--version'],
      timeoutMs: 2_000,
    })
    expect(result.code).toBeNull()
    expect(result.error).toBeTruthy()
  })
})
