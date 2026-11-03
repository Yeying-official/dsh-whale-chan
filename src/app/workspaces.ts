/**
 * Per-conversation workspace service for the app layer.
 *
 * One DingTalk conversation gets one directory, shared by its replier session
 * and by every task session created from it. This module owns the two things
 * the pure naming rules cannot: the configured root and the DSH workspace
 * registry.
 *
 * - **Root.** `tasks.workspaceRoot` (with `~` expanded) when it is a usable
 *   absolute path, otherwise `<stateDir>/workspaces`. The same field was
 *   already the task root, so the setting keeps its name and becomes the one
 *   root for replies and tasks. A relative value is refused with a warning and
 *   the default root is used: DSH resolves relative workspace paths against the
 *   host's own working directory, which the owner cannot predict.
 * - **Provisioning.** Enabled `group` and plain `dm` targets get their
 *   directory and registry record at startup (and again after a settings
 *   change). `at-me` and `open:` dm targets are global *subscriptions* with no
 *   single conversation, so their workspaces are created lazily by the first
 *   message. Disabling or deleting a target never deletes a directory or its
 *   registry record: the conversation may still arrive through another target,
 *   and its history is the owner's data.
 *
 * Provisioning is best-effort by contract: one failing target is logged and
 * skipped, and the caller can continue starting the rest of the runtime.
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  conversationWorkspace,
  conversationWorkspaceTitle,
  perConversationWorkspaceTitle,
} from '../executor/workspace.ts'
import type { TargetKind } from '../shared/limits.ts'
import type { TargetWorkspace } from '../shared/models.ts'
import type { Settings } from '../shared/settings.ts'

/** Directory under the state directory that holds per-conversation workspaces. */
export const WORKSPACES_DIRECTORY = 'workspaces'

/** The minimum of a `Workspace` this service writes to. */
export interface WorkspaceRecord {
  readonly path: string
  readonly title: string
  setTitle(title: string): Promise<void>
}

/** The subset of `ctx.workspaceRegistry` this service depends on. */
export interface WorkspaceRegistryPort {
  create(path: string, title?: string): Promise<WorkspaceRecord>
  resolveByPath(path: string): Promise<WorkspaceRecord | undefined>
}

/** What one provisioning pass did, for tests and debug logging. */
export interface ProvisionSummary {
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  /** Targets without a concrete conversation, disabled rows or duplicate rows. */
  readonly skipped: number
  readonly failed: number
}

/** A target as the view/provisioning code sees it. */
export interface WorkspaceTarget {
  readonly kind: TargetKind
  readonly id: string
  readonly label: string
}

/** The resolved root, and the configured value that was ignored when there is one. */
export interface WorkspaceRoot {
  readonly root: string
  readonly ignored?: string
}

/** The logging seam this service uses; a missing method means no logging. */
export interface WorkspaceLogger {
  warn?(message: string): void
}

export interface WorkspaceServiceOptions {
  /** Current settings; the service never caches them, so a hot change applies on the next call. */
  readonly settings: () => Settings
  /** Absolute state directory, used for the default root. */
  readonly stateDir: string
  /** Home directory for `~` expansion; defaults to `os.homedir()`. */
  readonly homeDir?: string
  readonly logger?: WorkspaceLogger
  /** DSH registry. Absent when the runtime has no host (an API-only test). */
  readonly registry?: WorkspaceRegistryPort
  /** Creates one directory recursively; replaced by tests. */
  readonly makeDirectory?: (path: string) => Promise<void>
}

/** Expand one leading `~`; every other path is returned unchanged. */
export function expandWorkspaceHome(path: string, home: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return trimmed
}

/**
 * The root every conversation workspace lives under.
 *
 * A configured relative path is reported through `ignored` instead of being
 * resolved: the owner typed something that means a different directory per
 * process, and DSH would reject it when creating the workspace anyway.
 */
export function resolveWorkspaceRoot(input: {
  readonly settings: Settings
  readonly stateDir: string
  readonly home: string
}): WorkspaceRoot {
  const fallback = resolve(join(input.stateDir, WORKSPACES_DIRECTORY))
  const configured = input.settings.tasks.workspaceRoot.trim()
  if (configured.length === 0) return { root: fallback }
  const expanded = expandWorkspaceHome(configured, input.home)
  if (!isAbsolute(expanded)) return { root: fallback, ignored: configured }
  return { root: resolve(expanded) }
}

/**
 * The conversation key one target provisions, or undefined when the target has
 * no single conversation (`at-me`, `open:` dm, or an empty id).
 *
 * `open:` is the send-only identity for a direct message: the same person can
 * appear under a staff id later, so binding a directory to it now would split
 * one conversation across two workspaces.
 */
export function targetThreadKey(target: { readonly kind: TargetKind; readonly id: string }): string | undefined {
  const id = target.id.trim()
  if (id.length === 0 || target.kind === 'at-me') return undefined
  if (target.kind === 'dm') return id.startsWith('open:') ? undefined : `dm:${id}`
  return `group:${id}`
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300)
  return String(error).slice(0, 300)
}

/**
 * Conversation workspaces: root resolution, naming, target projection and the
 * best-effort provisioning pass.
 */
export class WorkspaceService {
  private readonly settings: () => Settings
  private readonly stateDir: string
  private readonly home: string
  private readonly logger: WorkspaceServiceOptions['logger']
  private readonly registry: WorkspaceRegistryPort | undefined
  private readonly makeDirectory: (path: string) => Promise<void>
  /** Root value already reported as ignored, so one bad setting logs once. */
  private warnedIgnored: string | undefined
  /** Serializes provisioning passes; a settings change cannot interleave with startup. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: WorkspaceServiceOptions) {
    this.settings = options.settings
    this.stateDir = options.stateDir
    this.home = options.homeDir ?? homedir()
    this.logger = options.logger
    this.registry = options.registry
    this.makeDirectory =
      options.makeDirectory ??
      (async (path: string): Promise<void> => {
        await mkdir(path, { recursive: true, mode: 0o700 })
      })
  }

  /**
   * Resolve the workspace one conversation uses.
   *
   * A single source for the replier model, the worker executor and the panel:
   * they must all agree, or a task and its reply would run in different
   * directories. The value is computed from the same settings and thread key,
   * so no call order or cache can make them diverge.
   */
  resolveThreadWorkspace(threadKey: string, title = ''): { path: string; title: string } {
    return this.resolveFor(this.settings(), threadKey, title)
  }

  /**
   * The panel's read-only projection of one target's workspace.
   *
   * A concrete target names one directory that already exists (or will after
   * provisioning). A global target cannot name one: its path is `null` and the
   * mode tells the panel the directory depends on the conversation.
   */
  targetWorkspace(target: WorkspaceTarget): TargetWorkspace {
    const threadKey = targetThreadKey(target)
    if (threadKey === undefined) {
      return {
        path: null,
        title: perConversationWorkspaceTitle(target.label),
        mode: 'per-conversation',
      }
    }
    const resolved = this.resolveThreadWorkspace(threadKey, target.label)
    return { path: resolved.path, title: resolved.title, mode: 'ready' }
  }

  /**
   * Create and register the workspace of every enabled target with one
   * conversation. Failures are logged and counted, never rethrown.
   */
  provisionTargets(settings: Settings): Promise<ProvisionSummary> {
    const work = async (): Promise<ProvisionSummary> => await this.provision(settings)
    const current = this.chain.then(work, work)
    this.chain = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }

  private resolveFor(settings: Settings, threadKey: string, title: string): { path: string; title: string } {
    const root = this.rootFor(settings)
    if (root.ignored !== undefined && this.warnedIgnored !== root.ignored) {
      this.warnedIgnored = root.ignored
      this.logger?.warn?.(
        `dsh-whale-chan: tasks.workspaceRoot is not absolute; using ${root.root} for conversation workspaces`,
      )
    }
    return {
      path: conversationWorkspace(root.root, threadKey),
      title: conversationWorkspaceTitle(title, threadKey),
    }
  }

  private rootFor(settings: Settings): WorkspaceRoot {
    return resolveWorkspaceRoot({ settings, stateDir: this.stateDir, home: this.home })
  }

  private async provision(settings: Settings): Promise<ProvisionSummary> {
    let created = 0
    let updated = 0
    let unchanged = 0
    let skipped = 0
    let failed = 0
    const rows = settings.targets.rows
    const registry = this.registry
    if (registry === undefined) return { created, updated, unchanged, skipped: rows.length, failed }

    const seen = new Set<string>()
    for (const row of rows) {
      const threadKey = targetThreadKey(row)
      if (threadKey === undefined || !row.enabled) {
        skipped += 1
        continue
      }
      if (seen.has(threadKey)) {
        skipped += 1
        continue
      }
      seen.add(threadKey)
      try {
        const workspace = this.resolveFor(settings, threadKey, row.label)
        await this.makeDirectory(workspace.path)
        const existing = await registry.resolveByPath(workspace.path)
        if (existing === undefined) {
          await registry.create(workspace.path, workspace.title)
          created += 1
          continue
        }
        if (existing.title !== workspace.title) {
          await existing.setTitle(workspace.title)
          updated += 1
          continue
        }
        unchanged += 1
      } catch (error) {
        failed += 1
        this.logger?.warn?.(`dsh-whale-chan: could not provision the workspace of ${threadKey}: ${describe(error)}`)
      }
    }
    return { created, updated, unchanged, skipped, failed }
  }
}
