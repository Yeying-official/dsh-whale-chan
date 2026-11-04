/**
 * Replier session generations and workspace recovery.
 *
 * The generation formula is pure; the preflight that decides it is not. These
 * tests pin both: the historical generation-0 identity (an existing profile
 * must keep its live session), the durable generation record, the rotation that
 * follows an archived session, and the workspace-record recovery that keeps a
 * conversation working after the owner removes its workspace in DSH.
 *
 * The DSH registry is a fake, so every registry interaction (mkdir options,
 * `resolveByPath`, `create`, `attachSession`, the archive set) is asserted
 * exactly instead of being inferred from a live host.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kv } from '../src/app/kv.ts'
import { Store } from '../src/app/store.ts'
import {
  ConversationSessions,
  MAX_GENERATION_STEPS,
  REPLY_GENERATION_PREFIX,
  WORKER_GENERATION_PREFIX,
  WORKSPACE_DIRECTORY_MODE,
  workerSessionIdForGeneration,
  type ThreadWorkspaceResolver,
  type WorkspaceDirectoryOptions,
} from '../src/app/session-recovery.ts'
import { replySessionIdForGeneration, threadDigest } from '../src/executor/reply-session.ts'
import { replySessionId } from '../src/executor/types.ts'
import { WORKSPACE_LAYOUT_VERSION } from '../src/executor/workspace.ts'
import { RecordingLogger } from './fixtures/executor.ts'
import { FakeWorkspaceRegistry } from './fixtures/workspace-registry.ts'

let root = ''
let store: Store | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whale-chan-sessions-'))
})

afterEach(async () => {
  store?.close()
  store = undefined
  await rm(root, { recursive: true, force: true })
})

/** The id the generation formula must produce, computed independently. */
function expectedId(threadKey: string, generation: number): string {
  const base = `${threadKey}\u0000${WORKSPACE_LAYOUT_VERSION}`
  const input = generation === 0 ? base : `${base}\u0000g${generation}`
  return replySessionId(createHash('sha1').update(input, 'utf8').digest('hex').slice(0, 12))
}

/** A resolver shaped like the app layer's, so assertions name the contract. */
function resolver(): ThreadWorkspaceResolver {
  return {
    resolveThreadWorkspace(threadKey: string, title = ''): { path: string; title: string } {
      return { path: `/srv/workspaces/conversation-${threadKey}`, title: `钉钉 · ${title}` }
    },
  }
}

function openKv(): { store: Store; kv: Kv } {
  store = Store.open(root)
  return { store, kv: new Kv(store) }
}

function session(
  registry: FakeWorkspaceRegistry | undefined,
  kv: Kv,
  makeDirectory?: (path: string, options: WorkspaceDirectoryOptions) => Promise<unknown>,
  logger?: RecordingLogger,
): ConversationSessions {
  return new ConversationSessions({
    workspaces: resolver(),
    kv,
    ...(registry === undefined ? {} : { registry }),
    ...(makeDirectory === undefined ? {} : { makeDirectory }),
    ...(logger === undefined ? {} : { logger }),
  })
}

const KEY = 'group:cid-1'

describe('generation identity', () => {
  it('generation 0 is exactly the historical replier id', () => {
    expect(replySessionIdForGeneration(KEY, 0)).toBe(expectedId(KEY, 0))
    // The same identity the pre-rotation build used: layout version in the digest.
    expect(replySessionIdForGeneration(KEY, 0)).toBe(
      replySessionId(threadDigest(`${KEY}\u0000${WORKSPACE_LAYOUT_VERSION}`)),
    )
  })

  it('later generations are unique and follow the documented digest', () => {
    const ids = [0, 1, 2, 3].map((generation) => replySessionIdForGeneration(KEY, generation))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[1]).toBe(expectedId(KEY, 1))
    expect(ids[2]).toBe(expectedId(KEY, 2))
    expect(ids[1]).toMatch(/^whale-reply-[0-9a-f]{12}$/)
    // A printable separator could collide with a crafted thread key; NUL cannot.
    expect(replySessionIdForGeneration(`${KEY}:g1`, 0)).not.toBe(ids[1])
  })

  it('treats a negative or non-finite generation as zero', () => {
    expect(replySessionIdForGeneration(KEY, -3)).toBe(expectedId(KEY, 0))
    expect(replySessionIdForGeneration(KEY, Number.NaN)).toBe(expectedId(KEY, 0))
  })
})

describe('prepareReply', () => {
  it('creates the workspace directory and record when missing', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    const directories: Array<{ path: string; options: WorkspaceDirectoryOptions }> = []
    const sessions = session(registry, kv, async (path, options) => {
      directories.push({ path, options })
    })

    const prepared = await sessions.prepareReply(KEY, '项目群', undefined)

    expect(directories).toEqual([
      { path: `/srv/workspaces/conversation-${KEY}`, options: { recursive: true, mode: WORKSPACE_DIRECTORY_MODE } },
    ])
    expect(WORKSPACE_DIRECTORY_MODE).toBe(0o700)
    expect(registry.createCalls).toEqual([{ path: `/srv/workspaces/conversation-${KEY}`, title: `钉钉 · 项目群` }])
    expect(prepared.workspaceRecreated).toBe(true)
    expect(prepared.workspace).toEqual({
      path: `/srv/workspaces/conversation-${KEY}`,
      title: `钉钉 · 项目群`,
    })
    expect(prepared.sessionId).toBe(expectedId(KEY, 0))
    expect(prepared.generation).toBe(0)
    expect(prepared.rotated).toBe(false)
  })

  it('reuses an existing record exactly as it is and never renames it', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    const record = registry.seed(`/srv/workspaces/conversation-${KEY}`, '主人起的名字')
    const sessions = session(registry, kv, async () => undefined)

    const prepared = await sessions.prepareReply(KEY, '新的群名', undefined)

    expect(registry.createCalls).toHaveLength(0)
    expect(record.setTitleCalls).toBe(0)
    expect(record.title).toBe('主人起的名字')
    expect(prepared.workspaceRecreated).toBe(false)
  })

  it('keeps generation 0 and writes nothing when the session is not archived', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    const sessions = session(registry, kv, async () => undefined)

    const prepared = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(prepared.sessionId).toBe(expectedId(KEY, 0))
    expect(prepared.rotated).toBe(false)
    expect(kv.keys(REPLY_GENERATION_PREFIX)).toEqual([])
  })

  it('rotates past an archived session and persists the generation', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    registry.archived.add(expectedId(KEY, 0))
    const sessions = session(registry, kv, async () => undefined)

    const prepared = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(prepared.sessionId).toBe(expectedId(KEY, 1))
    expect(prepared.generation).toBe(1)
    expect(prepared.rotated).toBe(true)
    expect(kv.get(`${REPLY_GENERATION_PREFIX}${KEY}`)).toEqual({ generation: 1 })
  })

  it('skips every archived generation, up to the documented bound', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    registry.archived.add(expectedId(KEY, 0))
    registry.archived.add(expectedId(KEY, 1))
    const sessions = session(registry, kv, async () => undefined)

    const prepared = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(prepared.generation).toBe(2)
    expect(prepared.sessionId).toBe(expectedId(KEY, 2))
    expect(prepared.rotated).toBe(true)
    expect(MAX_GENERATION_STEPS).toBeGreaterThan(2)
  })

  it('attaches the cached session to a recreated workspace record', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    const sessions = session(registry, kv, async () => undefined)

    const prepared = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    const record = registry.records.get(`/srv/workspaces/conversation-${KEY}`)
    expect(record?.attached).toEqual([expectedId(KEY, 0)])
    expect(prepared.workspaceRecreated).toBe(true)
    expect(prepared.attached).toBe(true)
    // The old session is still valid, so the reply keeps its context.
    expect(prepared.sessionId).toBe(expectedId(KEY, 0))
    expect(prepared.rotated).toBe(false)
  })

  it('advances the generation when the recreated record refuses the old session', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.attachErrorForNew = new Error('the header cwd does not resolve')
    const sessions = session(registry, kv, async () => undefined)

    const created = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(created.workspaceRecreated).toBe(true)
    expect(created.attached).toBe(false)
    expect(created.generation).toBe(1)
    expect(created.sessionId).toBe(expectedId(KEY, 1))
    expect(created.rotated).toBe(true)
    expect(kv.get(`${REPLY_GENERATION_PREFIX}${KEY}`)).toEqual({ generation: 1 })
  })

  it('does not attempt an attach when the record already existed', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    const record = registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    record.attachError = new Error('the header cwd does not resolve')
    const sessions = session(registry, kv, async () => undefined)

    const reused = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(reused.workspaceRecreated).toBe(false)
    expect(reused.attached).toBe(false)
    expect(reused.sessionId).toBe(expectedId(KEY, 0))
    expect(record.attached).toEqual([])
  })

  it('degrades to generation 0 without a registry instead of throwing', async () => {
    const { kv } = openKv()
    const sessions = session(undefined, kv, async () => undefined)

    const prepared = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(prepared.sessionId).toBe(expectedId(KEY, 0))
    expect(prepared.generation).toBe(0)
    expect(prepared.workspaceRecreated).toBe(false)
    expect(prepared.attached).toBe(false)
    expect(kv.keys(REPLY_GENERATION_PREFIX)).toEqual([])
  })

  it('serializes concurrent preflights of one conversation', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    let active = 0
    let peak = 0
    const sessions = session(registry, kv, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })

    const [first, second] = await Promise.all([
      sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0)),
      sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0)),
    ])

    expect(peak).toBe(1)
    expect(first.sessionId).toBe(expectedId(KEY, 0))
    expect(second.sessionId).toBe(expectedId(KEY, 0))
    // The registry was consulted once per call, never concurrently.
    expect(registry.resolveCalls).toHaveLength(2)
  })

  it('degrades to the current generation when the directory cannot be created', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    const logger = new RecordingLogger()
    const sessions = session(
      registry,
      kv,
      async () => {
        throw new Error('EACCES: the state directory is read-only')
      },
      logger,
    )

    const prepared = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(prepared.sessionId).toBe(expectedId(KEY, 0))
    expect(prepared.workspaceRecreated).toBe(false)
    expect(prepared.attached).toBe(false)
    expect(prepared.rotated).toBe(false)
    expect(kv.keys(REPLY_GENERATION_PREFIX)).toEqual([])
    expect(logger.lines.some((line) => line.includes('workspace preflight'))).toBe(true)
  })

  it('degrades when the registry lookup fails', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.resolveErrors.set(`/srv/workspaces/conversation-${KEY}`, new Error('the registry is not started'))
    const sessions = session(registry, kv, async () => undefined)

    const prepared = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(prepared.sessionId).toBe(expectedId(KEY, 0))
    expect(prepared.workspaceRecreated).toBe(false)
    expect(registry.createCalls).toHaveLength(0)
  })

  it('still rotates an archived current session when the preflight degraded', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.archived.add(expectedId(KEY, 0))
    const sessions = session(registry, kv, async () => {
      throw new Error('EACCES')
    })

    const prepared = await sessions.prepareReply(KEY, '项目群', expectedId(KEY, 0))

    expect(prepared.sessionId).toBe(expectedId(KEY, 1))
    expect(prepared.rotated).toBe(true)
    expect(kv.get(`${REPLY_GENERATION_PREFIX}${KEY}`)).toEqual({ generation: 1 })
  })

  it('attaches the implicit current generation when the record is recreated', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    const sessions = session(registry, kv, async () => undefined)

    // A restart has no cached session, but the stored generation still names a
    // session; attaching it keeps the conversation's context when it exists.
    const prepared = await sessions.prepareReply(KEY, '项目群')

    const record = registry.records.get(`/srv/workspaces/conversation-${KEY}`)
    expect(record?.attached).toEqual([expectedId(KEY, 0)])
    expect(prepared.attached).toBe(true)
    expect(prepared.sessionId).toBe(expectedId(KEY, 0))
    expect(prepared.rotated).toBe(false)
  })

  it('does not rotate when the implicit candidate cannot be attached', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.attachErrorForNew = new Error('unknown session')
    const sessions = session(registry, kv, async () => undefined)

    const prepared = await sessions.prepareReply(KEY, '项目群')

    expect(prepared.attached).toBe(false)
    expect(prepared.generation).toBe(0)
    expect(prepared.sessionId).toBe(expectedId(KEY, 0))
    expect(prepared.rotated).toBe(false)
    expect(kv.keys(REPLY_GENERATION_PREFIX)).toEqual([])
  })
})

describe('worker sessions', () => {
  const BASE = 'whale-task-task-1-assign1'

  it('keeps the deterministic base id when it is not archived', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    const sessions = session(registry, kv, async () => undefined)

    expect(await sessions.ensureWorkerSessionId(BASE)).toBe(BASE)
    expect(kv.keys(WORKER_GENERATION_PREFIX)).toEqual([])
  })

  it('moves past an archived worker session and persists the generation', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.archived.add(BASE)
    const sessions = session(registry, kv, async () => undefined)

    const sessionId = await sessions.ensureWorkerSessionId(BASE)

    expect(sessionId).toBe(workerSessionIdForGeneration(BASE, 1))
    expect(sessionId).toBe(`${BASE}-g1`)
    expect(kv.get(`${WORKER_GENERATION_PREFIX}${BASE}`)).toEqual({ generation: 1 })
  })

  it('skips several archived generations', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.archived.add(BASE)
    registry.archived.add(workerSessionIdForGeneration(BASE, 1))
    const sessions = session(registry, kv, async () => undefined)

    expect(await sessions.ensureWorkerSessionId(BASE)).toBe(workerSessionIdForGeneration(BASE, 2))
  })

  it('reads the generation after a restart', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.archived.add(BASE)
    const sessions = session(registry, kv, async () => undefined)
    expect(await sessions.ensureWorkerSessionId(BASE)).toBe(`${BASE}-g1`)

    store?.close()
    store = undefined
    const reopened = openKv()
    const restarted = session(registry, reopened.kv, async () => undefined)
    // Generation 1 is not archived, so the restarted process keeps it.
    expect(await restarted.ensureWorkerSessionId(BASE)).toBe(`${BASE}-g1`)
  })

  it('degrades to the base id without a registry', async () => {
    const { kv } = openKv()
    const sessions = session(undefined, kv, async () => undefined)
    expect(await sessions.ensureWorkerSessionId(BASE)).toBe(BASE)
  })
})

describe('current and rotate', () => {
  it('rotates durably and reports the new identity', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    const sessions = session(registry, kv, async () => undefined)

    expect(sessions.currentReplySessionId(KEY)).toBe(expectedId(KEY, 0))
    expect(sessions.rotateReplySession(KEY)).toBe(expectedId(KEY, 1))
    expect(sessions.currentReplySessionId(KEY)).toBe(expectedId(KEY, 1))
    expect(sessions.rotateReplySession(KEY)).toBe(expectedId(KEY, 2))
    expect(kv.get(`${REPLY_GENERATION_PREFIX}${KEY}`)).toEqual({ generation: 2 })
  })

  it('keeps the generation across a reopened database', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    const sessions = session(registry, kv, async () => undefined)
    expect(sessions.rotateReplySession(KEY)).toBe(expectedId(KEY, 1))

    // Reopen the same state directory: the generation is a durable fact, not
    // process memory, so a restart cannot resume the archived session.
    store?.close()
    store = undefined
    const reopened = openKv()
    const restarted = session(registry, reopened.kv, async () => undefined)
    expect(restarted.currentReplySessionId(KEY)).toBe(expectedId(KEY, 1))
    const prepared = await restarted.prepareReply(KEY, '项目群', expectedId(KEY, 0))
    expect(prepared.sessionId).toBe(expectedId(KEY, 1))
    expect(prepared.rotated).toBe(false)
  })

  it('ignores a corrupted generation record instead of failing the reply', async () => {
    const { kv } = openKv()
    const registry = new FakeWorkspaceRegistry()
    registry.seed(`/srv/workspaces/conversation-${KEY}`, '钉钉 · 项目群')
    kv.set(`${REPLY_GENERATION_PREFIX}${KEY}`, { generation: 'not-a-number' })
    const sessions = session(registry, kv, async () => undefined)

    expect(sessions.currentReplySessionId(KEY)).toBe(expectedId(KEY, 0))
  })
})
