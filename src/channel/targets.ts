/**
 * Subscription specs: which `dws event` command one target needs.
 *
 * Targets are explicit — a kind plus the id the dws contract names for it. Names
 * are never resolved to ids here; discovery (`discover.ts`) produces candidates
 * for a person to confirm, and only the confirmed id is subscribed.
 */
import type { Settings } from '../shared/settings.ts'
import { ChannelError } from './errors.ts'
import type { DwsTarget } from './types.ts'

/**
 * The three event keys confirmed against dws 1.0.66 help output.
 *
 * See `docs/009-dws-protocol.md`; changing a key is a protocol change, not a
 * configuration change.
 */
export const EVENT_KEYS = {
  'at-me': 'user_im_message_receive_at',
  group: 'user_im_message_receive_group',
  dm: 'user_im_message_receive_o2o',
} as const

/**
 * Format one TTL for the `--ttl` flag.
 *
 * dws parses `--ttl` as a Go duration, not as a number: a bare `1` is rejected
 * with `time: missing unit in duration "1"` (confirmed on a real host during
 * T1). Settings store whole hours, so v1 always appends `h`.
 */
export function ttlDuration(hours: number): string {
  return `${hours}h`
}

/** One `event consume` invocation, without the binary and its base args. */
export interface ConsumeSpec {
  readonly eventKey: string
  readonly args: readonly string[]
}

/** Stable key of one target; the supervisor's identity for a subscription. */
export function targetKey(target: DwsTarget): string {
  return `${target.kind}:${target.id.trim()}`
}

/** Append `--profile` when the deployment configures one. */
export function withProfile(args: readonly string[], settings: Settings): string[] {
  const profile = settings.dws.profile.trim()
  return profile ? [...args, '--profile', profile] : [...args]
}

/** One-to-one addressing flag, shared by subscribe and send. */
export interface PeerAddress {
  readonly flag: '--user' | '--open-dingtalk-id'
  readonly value: string
}

/**
 * A conversation id (`cid...=`) addresses a chat, not a person.
 *
 * `event consume ... --open-dingtalk-id <conversation id>` is rejected by the
 * server (`subscribeUser failed`), so a dm target carrying one is refused here
 * with an actionable message instead of failing at subscribe time. A
 * one-to-one target must use the peer's `userId` or `openDingTalkId` instead.
 */
const CONVERSATION_ID = /^cid[^:]*=*$/i

const CONVERSATION_ID_ERROR =
  'a conversation id cannot address a one-to-one target; use the peer userId or open:<openDingtalkId>'

/**
 * Interpret a dm target id.
 *
 * A plain id is a `userId` (the contract's `--user`); the `open:` prefix marks an
 * `openDingTalkId` for `--open-dingtalk-id`, because a bare open id and a bare
 * user id cannot be told apart and guessing would send to the wrong person.
 * Conversation ids are refused up front: they name a chat, not a person.
 */
export function parsePeerAddress(id: string): PeerAddress {
  const trimmed = id.trim()
  if (trimmed === '') throw new ChannelError('invalid-target', 'target id is empty')
  if (trimmed.startsWith('open:')) {
    const value = trimmed.slice('open:'.length).trim()
    if (value === '') throw new ChannelError('invalid-target', 'open target id is empty')
    if (CONVERSATION_ID.test(value)) throw new ChannelError('invalid-target', CONVERSATION_ID_ERROR)
    return { flag: '--open-dingtalk-id', value }
  }
  if (CONVERSATION_ID.test(trimmed)) throw new ChannelError('invalid-target', CONVERSATION_ID_ERROR)
  return { flag: '--user', value: trimmed }
}

/**
 * Build the `event consume` spec for one target.
 *
 * The command is always flattened NDJSON with a TTL, so a reconnect recovers a
 * bounded window instead of replaying an unbounded history.
 */
export function consumeSpec(target: DwsTarget, settings: Settings): ConsumeSpec {
  const id = target.id.trim()
  if (id === '') throw new ChannelError('invalid-target', 'target id is empty')
  const eventKey = EVENT_KEYS[target.kind]
  const args = [
    'event',
    'consume',
    eventKey,
    '--flatten',
    '-f',
    'ndjson',
    '--ttl',
    ttlDuration(settings.dws.eventTtlHours),
  ]
  if (target.kind === 'group') {
    args.push('--group', id)
  } else if (target.kind === 'dm') {
    const address = parsePeerAddress(id)
    args.push(address.flag, address.value)
  }
  return { eventKey, args: withProfile(args, settings) }
}

/**
 * Enabled targets in settings order, without duplicates.
 *
 * The at-me subscription is global: a second at-me row would subscribe the same
 * stream twice, so only the first is kept.
 */
export function dedupeTargets(targets: readonly DwsTarget[]): DwsTarget[] {
  const seen = new Set<string>()
  const result: DwsTarget[] = []
  let atMe = false
  for (const target of targets) {
    if (!target.enabled) continue
    if (target.id.trim() === '') continue
    if (target.kind === 'at-me') {
      if (atMe) continue
      atMe = true
    }
    const key = targetKey(target)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(target)
  }
  return result
}

/** Map the persisted target rows onto channel targets. */
export function targetsFromSettings(settings: Settings): DwsTarget[] {
  return dedupeTargets(
    settings.targets.rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      ...(row.label === '' ? {} : { label: row.label }),
      mentionOnly: row.mentionOnly,
      enabled: row.enabled,
    })),
  )
}

/**
 * The owner identity used for self-detection and mention matching.
 *
 * Settings carry no account id on purpose: the host resolves it once from
 * `probeAuth().userId` and passes it in. There is deliberately **no fallback** —
 * guessing the owner from a target id would disable the self-message filter and
 * could make the assistant answer its own messages.
 */
export function resolveOwnerUserId(supplied?: string): string {
  return supplied?.trim() ?? ''
}
