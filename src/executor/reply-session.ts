/**
 * Pure identity rules of the replier session of one conversation.
 *
 * A replier session id is a hash, never a title: a DingTalk conversation id is
 * user data and must not become a path or a session id. The layout version is
 * folded into the hash so a deploy can start a new session without moving any
 * directory, and a rotation *generation* extends the same idea at runtime: the
 * owner archives a conversation's sessions, the next message must reach a
 * brand-new session, and the archived one must stay exactly where it is.
 *
 * Generation 0 is deliberately byte-for-byte the id this bundle has always
 * used, so a profile that never archived anything keeps its live session after
 * the upgrade. Only generation 1 and later append the generation field.
 *
 * Every field is joined with a NUL separator. The thread key is arbitrary user
 * data, so a printable separator could collide (`a:g1` as a key versus
 * generation 1 of `a`); NUL cannot appear in a DingTalk conversation id and
 * keeps the hash input unambiguous.
 *
 * This module is intentionally free of host services, settings and I/O: the app
 * layer persists the generation, and tests can verify the naming rules without
 * a state directory.
 */
import { createHash } from 'node:crypto'
import { replySessionId } from './types.ts'
import { WORKSPACE_LAYOUT_VERSION } from './workspace.ts'

/** Field separator of the hashed identity; never printable, never in a thread key. */
const FIELD_SEPARATOR = '\u0000'

/** Short stable id of a conversation, used in the DSH session id. */
export function threadDigest(threadKey: string): string {
  return createHash('sha1').update(threadKey, 'utf8').digest('hex').slice(0, 12)
}

/**
 * Session id of the replier of `threadKey` at one rotation generation.
 *
 * `generation === 0` is the historical identity (`<threadKey>NUL<layout>`).
 * A later generation appends `NUL g<n>`, which yields a different digest and
 * therefore a different session; the earlier session is left untouched.
 */
export function replySessionIdForGeneration(threadKey: string, generation: number): string {
  const safe = Number.isFinite(generation) ? Math.max(0, Math.trunc(generation)) : 0
  const base = `${threadKey}${FIELD_SEPARATOR}${WORKSPACE_LAYOUT_VERSION}`
  const input = safe === 0 ? base : `${base}${FIELD_SEPARATOR}g${safe}`
  return replySessionId(threadDigest(input))
}
