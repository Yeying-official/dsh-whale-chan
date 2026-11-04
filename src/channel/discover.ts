/**
 * Conversation discovery: turn a human-readable name into the explicit id that a
 * target must carry.
 *
 * Discovery is read-only and always returns candidates for a person to confirm.
 * A name is never turned into an id implicitly anywhere else in the channel, so
 * a wrong search result cannot silently subscribe or send.
 *
 * One-to-one targets are discovered through the contact directory
 * (`contact user search`), the only observed command that returns a peer's
 * `userId` and `openDingTalkId`. The p2p conversation list is deliberately not
 * used: it only carries an `openConversationId`, which addresses a conversation
 * rather than a person, and `event consume ... --open-dingtalk-id
 * <conversation id>` is rejected by the server. See `docs/009-dws-protocol.md`.
 */
import type { Settings } from '../shared/settings.ts'
import { ChannelError } from './errors.ts'
import { redact, truncate } from './log.ts'
import { createRunner, shortStderr } from './process.ts'
import { withProfile } from './targets.ts'
import type { CommandRunner, CommandResult, TargetCandidate } from './types.ts'

/** Hard cap for one discovery result; a panel cannot usefully page 500 chats. */
export const DISCOVERY_LIMIT = 50

/** Optional seams for tests; production builds the runner from settings. */
export interface DiscoverIo {
  readonly runner?: CommandRunner
  readonly timeoutMs?: number
}

const GROUP_ID_FIELDS = [
  'openConversationId',
  'conversationId',
  'openConversationID',
  'chatId',
  'openId',
  'id',
] as const
const GROUP_LABEL_FIELDS = ['name', 'title', 'conversationTitle', 'chatName', 'groupName'] as const
const PEER_USER_FIELDS = ['userId', 'staffId', 'user_id', 'staff_id'] as const
const PEER_OPEN_FIELDS = ['openDingTalkId', 'openDingTalkUserId', 'openDingtalkId', 'open_id'] as const
const PEER_NICK_FIELDS = ['nick', 'nickname', 'nickName', 'displayName'] as const
const PEER_NAME_FIELDS = ['name', 'userName'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickString(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = record[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

/** Find the first array under a known envelope key, without trusting one shape. */
function findItems(value: unknown, depth = 0): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (!isRecord(value) || depth > 3) return undefined
  for (const key of ['chats', 'result', 'results', 'items', 'list', 'data', 'conversations']) {
    const nested = value[key]
    if (Array.isArray(nested)) return nested
    if (isRecord(nested)) {
      const deeper = findItems(nested, depth + 1)
      if (deeper) return deeper
    }
  }
  return undefined
}

/** Parse the JSON document dws printed, tolerating a leading log line. */
function parseJsonOutput(result: CommandResult): unknown {
  const text = result.stdout.trim()
  if (text === '') throw new ChannelError('dws-output', 'dws returned no output')
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // fall through to the typed error
      }
    }
    throw new ChannelError('dws-output', 'dws returned output that is not JSON')
  }
}

async function runDiscovery(
  runner: CommandRunner,
  args: readonly string[],
  timeoutMs: number,
  command: string,
): Promise<unknown> {
  const result = await runner.run(args, { timeoutMs })
  if (result.error) throw new ChannelError('dws-missing', `dws could not start for ${command}: ${result.error}`)
  if (result.timedOut) throw new ChannelError('dws-timeout', `dws ${command} timed out`)
  if (result.code !== 0) {
    throw new ChannelError(
      'dws-failed',
      truncate(redact(`dws ${command} exited ${result.code ?? 'null'}: ${shortStderr(result.stderr)}`), 240),
    )
  }
  return parseJsonOutput(result)
}

function fromGroup(item: unknown): TargetCandidate | undefined {
  if (!isRecord(item)) return undefined
  const id = pickString(item, GROUP_ID_FIELDS)
  if (!id) return undefined
  const label = pickString(item, GROUP_LABEL_FIELDS) ?? ''
  return { kind: 'group', id, label, source: 'chat-search' }
}

function fromPeer(item: unknown): TargetCandidate | undefined {
  if (!isRecord(item)) return undefined
  const userId = pickString(item, PEER_USER_FIELDS)
  const openDingTalkId = pickString(item, PEER_OPEN_FIELDS)
  if (!userId && !openDingTalkId) return undefined
  const label = pickString(item, PEER_NICK_FIELDS) ?? pickString(item, PEER_NAME_FIELDS) ?? ''
  // A user id is the preferred identity (`--user`); the `open:` prefix is only
  // for contacts the directory exposes as an open id, and keeps the send and
  // subscribe commands honest about which flag they may use.
  const id = userId ?? `open:${openDingTalkId}`
  return {
    kind: 'dm',
    id,
    label,
    ...(userId && openDingTalkId ? { description: `userId: ${userId} · openDingTalkId: ${openDingTalkId}` } : {}),
    source: 'contact-search',
  }
}

function matchesQuery(candidate: TargetCandidate, query: string | undefined): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return candidate.label.toLowerCase().includes(needle) || candidate.id.toLowerCase().includes(needle)
}

function finalize(candidates: readonly (TargetCandidate | undefined)[], query?: string): TargetCandidate[] {
  const seen = new Set<string>()
  const result: TargetCandidate[] = []
  for (const candidate of candidates) {
    if (!candidate) continue
    if (!matchesQuery(candidate, query)) continue
    const key = `${candidate.kind}:${candidate.id}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
    if (result.length >= DISCOVERY_LIMIT) break
  }
  return result
}

function runnerFor(settings: Settings, io: DiscoverIo): CommandRunner {
  if (io.runner) return io.runner
  return createRunner({ command: settings.dws.binaryPath })
}

/** Search groups by name and return explicit candidates. */
export async function discoverGroups(
  query: string,
  settings: Settings,
  io: DiscoverIo = {},
): Promise<TargetCandidate[]> {
  const trimmed = query.trim()
  if (trimmed === '') throw new ChannelError('invalid-target', 'a search query is required')
  const args = withProfile(
    ['chat', '+chat-search', '--query', trimmed, '--limit', String(DISCOVERY_LIMIT), '--format', 'json'],
    settings,
  )
  const payload = await runDiscovery(runnerFor(settings, io), args, io.timeoutMs ?? 20_000, 'chat +chat-search')
  return finalize((findItems(payload) ?? []).map(fromGroup), trimmed)
}

/**
 * Search the contact directory by name and return explicit one-to-one
 * candidates.
 *
 * A query is required: the command has no "list every contact" contract, and a
 * candidate is only useful once a person confirms the right contact. Filtering
 * belongs to dws, which searches by contact name; matching locally on the
 * display label would drop contacts whose `nick` differs from the searched
 * `name`. `finalize` only de-duplicates and applies `DISCOVERY_LIMIT`.
 */
export async function discoverPeers(
  query: string | undefined,
  settings: Settings,
  io: DiscoverIo = {},
): Promise<TargetCandidate[]> {
  const trimmed = query?.trim() ?? ''
  if (trimmed === '') {
    throw new ChannelError(
      'invalid-target',
      "a one-to-one search needs a contact name; enter the person's name and search again",
    )
  }
  const args = withProfile(['contact', 'user', 'search', '--query', trimmed, '--format', 'json'], settings)
  const payload = await runDiscovery(runnerFor(settings, io), args, io.timeoutMs ?? 20_000, 'contact user search')
  return finalize((findItems(payload) ?? []).map(fromPeer))
}
