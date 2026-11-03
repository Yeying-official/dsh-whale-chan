/**
 * Pure helpers for per-conversation workspaces.
 *
 * One DingTalk conversation owns one directory, and the replier session and
 * every task session of that conversation share it. The directory name is
 * derived from a hash of the thread key rather than from the key itself:
 * conversation titles and ids are user data (they may contain separators, a
 * Windows reserved name, non-ASCII text or a very long string), while a hex
 * digest is always one safe path segment on every platform this bundle runs on.
 *
 * `WORKSPACE_LAYOUT_VERSION` is part of the replier session id, not of the
 * path. Bumping it starts a *new* replier session for a conversation while the
 * existing workspace directory and every earlier session stay exactly where
 * they are; a migration therefore never has to move files or delete history.
 *
 * This module is intentionally free of host services and settings: the app
 * layer resolves the root and owns the registry, and tests can verify the
 * naming rules without a state directory.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ExecutorError } from './errors.ts'

/**
 * Layout generation of the replier session identity.
 *
 * v2 moved replier sessions from one shared workspace to the per-conversation
 * workspace. The version is folded into the session digest so a deploy starts
 * a fresh session in the new directory; the old session and its history are
 * left behind untouched.
 */
export const WORKSPACE_LAYOUT_VERSION = 'v2'

/** Prefix of one conversation directory; the rest of the segment is a digest. */
export const CONVERSATION_DIRECTORY_PREFIX = 'conversation-'

/** Hex characters of the thread digest used in a directory name. */
export const WORKSPACE_DIGEST_LENGTH = 16

/** Hex characters of the thread digest appended to an ambiguous display title. */
export const WORKSPACE_TITLE_DIGEST_LENGTH = 8

/** Display prefix of a DSH workspace title, shared with the session title. */
export const WORKSPACE_TITLE_PREFIX = '钉钉 · '

/** Title used when a conversation reports no name at all. */
export const UNTITLED_CONVERSATION = '按会话'

/** Longest title kept from a conversation name, in code points. */
export const MAX_WORKSPACE_TITLE_CHARS = 80

/** Windows forbids these characters in a file name, in addition to separators. */
const WINDOWS_UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/u

/** Characters a derived path segment may contain (letters, digits, dot, dash, underscore). */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u

/** Whether `value` is one safe path segment on both POSIX and Windows. */
export function isSafeWorkspaceSegment(value: string): boolean {
  if (value.length === 0 || value === '.' || value === '..') return false
  if (value.endsWith('.') || value.endsWith(' ')) return false
  if (WINDOWS_UNSAFE.test(value)) return false
  return SAFE_SEGMENT.test(value)
}

/** Full SHA-256 hex digest of a thread key. */
function threadHash(threadKey: string): string {
  return createHash('sha256').update(threadKey, 'utf8').digest('hex')
}

/** Deterministic digest of one conversation, used in its directory name. */
export function conversationWorkspaceDigest(threadKey: string): string {
  return threadHash(threadKey).slice(0, WORKSPACE_DIGEST_LENGTH)
}

/**
 * The directory one conversation owns under `root`.
 *
 * The path is `<root>/conversation-<sha256(threadKey)[0..16]>`. The thread key
 * is never read as a path: a crafted key such as `../../etc/passwd` only
 * changes the digest, so it cannot traverse out of the root. An empty root or
 * a key that cannot produce a safe segment is refused instead of silently
 * falling back, because a wrong directory is harder to notice than an error.
 */
export function conversationWorkspace(root: string, threadKey: string): string {
  const trimmed = root.trim()
  if (trimmed.length === 0) throw new ExecutorError('unsafeWorkspacePath', 'the workspace root is empty')
  if (trimmed.includes('\u0000')) throw new ExecutorError('unsafeWorkspacePath', 'the workspace root contains a NUL')
  if (threadKey.trim().length === 0) throw new ExecutorError('unsafeWorkspacePath', 'the thread key is empty')
  const segment = `${CONVERSATION_DIRECTORY_PREFIX}${conversationWorkspaceDigest(threadKey)}`
  if (!isSafeWorkspaceSegment(segment)) throw new ExecutorError('unsafeWorkspacePath', segment)
  return join(trimmed, segment)
}

/** Collapse control characters and repeated whitespace into single spaces. */
export function sanitizeWorkspaceTitle(value: string): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  // Slice by code point so a title ending in an emoji is not cut mid-pair.
  return Array.from(clean).slice(0, MAX_WORKSPACE_TITLE_CHARS).join('')
}

/**
 * Display title of one conversation workspace.
 *
 * A named conversation keeps its own name (`钉钉 · <title>`). An unnamed or
 * generic `@我` conversation gets a short digest suffix: those titles are the
 * same for every conversation, so without it the DSH workspace list would show
 * several indistinguishable rows.
 */
export function conversationWorkspaceTitle(title: string, threadKey: string): string {
  const clean = sanitizeWorkspaceTitle(title)
  const suffix = threadHash(threadKey).slice(0, WORKSPACE_TITLE_DIGEST_LENGTH)
  if (clean.length === 0) return `${WORKSPACE_TITLE_PREFIX}${suffix}`
  if (clean.startsWith('@我')) return `${WORKSPACE_TITLE_PREFIX}${clean} · ${suffix}`
  return `${WORKSPACE_TITLE_PREFIX}${clean}`
}

/** Title of a target that owns one workspace per conversation instead of one now. */
export function perConversationWorkspaceTitle(title: string): string {
  const clean = sanitizeWorkspaceTitle(title)
  return `${WORKSPACE_TITLE_PREFIX}${clean.length === 0 ? UNTITLED_CONVERSATION : clean}`
}
