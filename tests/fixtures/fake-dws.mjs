#!/usr/bin/env node
/**
 * Fake `dws` executable for channel tests.
 *
 * It implements only the subcommands the channel uses, writes nothing outside
 * the temp directory named by its own environment variables, and never touches
 * a real DingTalk account:
 *
 * - `--version`
 * - `auth status --format json`
 * - `event consume <key> --flatten -f ndjson --ttl <h> [--group|--user|--open-dingtalk-id]`
 * - `chat +chat-search --query <q> --limit <n>`
 * - `chat +chat-list --types p2p --page-size <n>`
 * - `chat +messages-send ... --markdown <text>`
 *
 * Env knobs:
 * - FAKE_DWS_VERSION          version banner (default "dws 1.0.66-fake")
 * - FAKE_DWS_AUTH             auth status JSON text (or a path to a JSON file)
 * - FAKE_DWS_AUTH_EXIT        auth status exit code
 * - FAKE_DWS_AUTH_RAW         raw stdout for auth status (overrides FAKE_DWS_AUTH)
 * - FAKE_DWS_EVENTS           JSON file of event lines (array or {events: []})
 * - FAKE_DWS_SUBSCRIBE_ID     subscribe id printed on the ready line
 * - FAKE_DWS_EXIT             exit code after events (simulated crash)
 * - FAKE_DWS_SIGTERM_DELAY_MS delay before exiting after SIGTERM (orphan test)
 * - FAKE_DWS_TRACE            JSONL trace file: start/ready/signal/exit phases
 * - FAKE_DWS_CHATS            JSON file {groups: [], peers: []}
 * - FAKE_DWS_CHATS_MODE       "text" to print a non-JSON banner instead of JSON
 * - FAKE_DWS_LEDGER           JSONL file receiving every +messages-send argv
 * - FAKE_DWS_SEND_RESULT      sent | unknown | failed | gone (default sent)
 * - FAKE_DWS_SEND_SLEEP_MS    hang time for "unknown" (default 60000)
 * - FAKE_DWS_DRY_RUN_EXIT     exit code for `event consume --dry-run`
 *
 * The script stays dependency-free and exits 0 on stdin end or SIGTERM, which is
 * how the supervisor is expected to stop it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)

function trace(phase, extra = {}) {
  const file = process.env.FAKE_DWS_TRACE
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify({ phase, pid: process.pid, at: Date.now(), ...extra })}\n`)
}

function ledger() {
  const file = process.env.FAKE_DWS_LEDGER
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify({ argv, at: Date.now() })}\n`)
}

function readTextEnvOrFile(name) {
  const value = process.env[name]
  if (!value) return undefined
  if (value.trimStart().startsWith('{') || value.trimStart().startsWith('[')) return value
  return existsSync(value) ? readFileSync(value, 'utf8') : value
}

function readJsonEnv(name) {
  const text = readTextEnvOrFile(name)
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function flagValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function hasFlag(args, flag) {
  return args.includes(flag)
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
}

/** Consume `--profile <name>` wherever it appears; the fake does not model profiles. */
function withoutProfile(args) {
  const result = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--profile') {
      index += 1
      continue
    }
    result.push(args[index])
  }
  return result
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function exitAfterSignal(delayMs) {
  const finish = (signal) => {
    trace('signal', { signal })
    trace('exit', { reason: 'signal' })
    setTimeout(() => process.exit(0), delayMs)
  }
  process.once('SIGTERM', () => finish('SIGTERM'))
  process.once('SIGINT', () => finish('SIGINT'))
  if (process.env.FAKE_DWS_IGNORE_STDIN === '1') return
  process.stdin.resume()
  process.stdin.once('end', () => {
    trace('exit', { reason: 'stdin-end' })
    process.exit(0)
  })
  process.stdin.once('close', () => {
    trace('exit', { reason: 'stdin-close' })
    process.exit(0)
  })
}

/** Normalize one FAKE_DWS_EVENTS entry into `{delayMs, text}`. */
function eventEntry(entry) {
  if (typeof entry === 'string') return { delayMs: 0, text: entry }
  if (entry && typeof entry === 'object') {
    const delayMs = typeof entry.delayMs === 'number' && entry.delayMs > 0 ? entry.delayMs : 0
    if (typeof entry.line === 'string') return { delayMs, text: entry.line }
    if (entry.line !== undefined) return { delayMs, text: JSON.stringify(entry.line) }
    const { delayMs: _ignored, ...rest } = entry
    return { delayMs, text: JSON.stringify(rest) }
  }
  return { delayMs: 0, text: String(entry) }
}

async function runConsume(args) {
  const eventKey = args.find((item) => item.startsWith('user_im_')) ?? 'unknown_event'
  const dryRun = hasFlag(args, '--dry-run')

  if (dryRun) {
    const plan = {
      event_key: eventKey,
      group: flagValue(args, '--group') ?? null,
      user: flagValue(args, '--user') ?? null,
      openDingTalkId: flagValue(args, '--open-dingtalk-id') ?? null,
      ttl: flagValue(args, '--ttl') ?? null,
      flatten: hasFlag(args, '--flatten'),
      format: flagValue(args, '-f') ?? null,
      dryRun: true,
    }
    print(`[event] dry-run ${JSON.stringify(plan)}`)
    const code = Number(process.env.FAKE_DWS_DRY_RUN_EXIT ?? 0)
    process.exit(Number.isFinite(code) ? code : 0)
  }

  const subscribeId = process.env.FAKE_DWS_SUBSCRIBE_ID ?? `sub-${eventKey}-${process.pid}`
  process.stderr.write(`[event] ready event_key=${eventKey} bus_pid=${process.pid} subscribe_id=${subscribeId}\n`)
  trace('ready', { eventKey, subscribeId })

  const payload = readJsonEnv('FAKE_DWS_EVENTS')
  const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : []
  for (const entry of entries) {
    const { delayMs, text } = eventEntry(entry)
    if (delayMs > 0) await sleep(delayMs)
    process.stdout.write(`${text}\n`)
  }

  const forcedExit = process.env.FAKE_DWS_EXIT
  if (forcedExit !== undefined && forcedExit !== '') {
    const code = Number(forcedExit)
    trace('exit', { reason: 'forced', code })
    process.exit(Number.isFinite(code) ? code : 1)
  }

  const signalDelay = Number(process.env.FAKE_DWS_SIGTERM_DELAY_MS ?? 0)
  exitAfterSignal(Number.isFinite(signalDelay) && signalDelay > 0 ? signalDelay : 0)
}

async function runSend(args) {
  ledger()
  const mode = process.env.FAKE_DWS_SEND_RESULT ?? 'sent'
  if (mode === 'unknown') {
    // Simulate a send whose receipt never arrives; the caller must time out and
    // report `unknown`, never a retryable failure.
    const sleepMs = Number(process.env.FAKE_DWS_SEND_SLEEP_MS ?? 60_000)
    await sleep(Number.isFinite(sleepMs) ? sleepMs : 60_000)
    print({ success: true, messageId: 'fake-late' })
    process.exit(0)
  }
  if (mode === 'failed') {
    print({ success: false, errorCode: 'invalid_request', message: 'invalid request' })
    process.exit(1)
  }
  if (mode === 'gone') {
    print({ success: false, errorCode: 'chat_not_found', message: 'chat not found' })
    process.exit(1)
  }
  print({ success: true, messageId: `fake-msg-${process.pid}`, processQueryKey: `pq-${process.pid}` })
  process.exit(0)
}

function chatData() {
  const payload = readJsonEnv('FAKE_DWS_CHATS') ?? {}
  return {
    groups: Array.isArray(payload.groups) ? payload.groups : Array.isArray(payload.chats) ? payload.chats : [],
    peers: Array.isArray(payload.peers) ? payload.peers : [],
  }
}

function chatFailure() {
  const exitCode = Number(process.env.FAKE_DWS_CHAT_EXIT ?? 0)
  if (Number.isFinite(exitCode) && exitCode !== 0) {
    console.error('fake-dws: chat command failed')
    process.exit(exitCode)
  }
}

function runSearch(args) {
  chatFailure()
  if (process.env.FAKE_DWS_CHATS_MODE === 'text') {
    print('not a json document')
    process.exit(0)
  }
  const query = (flagValue(args, '--query') ?? '').toLowerCase()
  const limit = Number(flagValue(args, '--limit') ?? 50)
  const { groups } = chatData()
  const chats = groups
    .filter((item) => typeof item?.name === 'string' && item.name.toLowerCase().includes(query))
    .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50)
  print({ chats, hasMore: false })
  process.exit(0)
}

function runList(args) {
  chatFailure()
  if (process.env.FAKE_DWS_CHATS_MODE === 'text') {
    print('not a json document')
    process.exit(0)
  }
  const size = Number(flagValue(args, '--page-size') ?? 50)
  const { peers } = chatData()
  const types = flagValue(args, '--types')
  const chats = types && !types.includes('p2p') ? [] : peers.slice(0, Number.isFinite(size) && size > 0 ? size : 50)
  print({ chats, hasMore: false })
  process.exit(0)
}

function runAuthStatus() {
  const exitCode = Number(process.env.FAKE_DWS_AUTH_EXIT ?? 0)
  if (Number.isFinite(exitCode) && exitCode !== 0) process.exit(exitCode)
  const raw = readTextEnvOrFile('FAKE_DWS_AUTH_RAW')
  if (raw !== undefined) {
    process.stdout.write(`${raw}\n`)
    process.exit(0)
  }
  const auth = readTextEnvOrFile('FAKE_DWS_AUTH')
  print(
    auth ?? {
      authenticated: true,
      token_valid: true,
      refresh_token_valid: true,
      expires_at: '2099-12-31T00:00:00.000Z',
    },
  )
  process.exit(0)
}

async function main() {
  const args = withoutProfile(argv)
  trace('start', { argv: args })
  const first = args[0]

  if (first === '--version' || first === '-v') {
    print(process.env.FAKE_DWS_VERSION ?? 'dws 1.0.66-fake')
    process.exit(0)
  }
  if (first === 'auth' && args[1] === 'status') return runAuthStatus()
  if (first === 'event' && args[1] === 'consume') return runConsume(args)
  if (first === 'chat') {
    const command = args[1]
    if (command === '+chat-search') return runSearch(args)
    if (command === '+chat-list') return runList(args)
    if (command === '+messages-send') return runSend(args)
  }

  process.stderr.write(`fake-dws: unsupported command: ${args.join(' ')}\n`)
  process.exit(2)
}

main().catch((error) => {
  process.stderr.write(`fake-dws: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
