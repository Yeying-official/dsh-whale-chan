/**
 * Test doubles of the core ports.
 *
 * `MemoryRepositories` mirrors the store's uniqueness rules and implements
 * `atomic` with a full snapshot, so a rolled-back engine command is observable
 * in tests exactly as it is against SQLite. The clock and the id source are
 * deterministic, which lets a test assert `updatedAt` and minted ids.
 */
import {
  Engine,
  type Approval,
  type Assignment,
  type Clock,
  type Decision,
  type DomainEvent,
  type Ids,
  type InboundMessage,
  type Outbound,
  type Repositories,
  type Task,
  type Thread,
} from '../../src/core/index.ts'

export interface MutableClock extends Clock {
  set(iso: string): void
  advance(ms: number): void
}

export function createClock(start = '2026-11-02T09:00:00.000Z'): MutableClock {
  let current = new Date(start)
  return {
    now: () => new Date(current),
    set: (iso) => {
      current = new Date(iso)
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

export interface SequentialIds extends Ids {
  readonly issued: readonly string[]
}

export function createIds(): SequentialIds {
  const counters = new Map<string, number>()
  const issued: string[] = []
  return {
    next(prefix) {
      const next = (counters.get(prefix) ?? 0) + 1
      counters.set(prefix, next)
      const id = `${prefix}-${next}`
      issued.push(id)
      return id
    },
    issued,
  }
}

interface Snapshot {
  messages: Map<string, InboundMessage>
  threads: Map<string, Thread>
  decisions: Map<string, Decision>
  tasks: Map<string, Task>
  approvals: Map<string, Approval>
  assignments: Map<string, Assignment>
  outbound: Map<string, Outbound>
}

function cloneMap<T>(source: Map<string, T>): Map<string, T> {
  return new Map([...source].map(([name, value]) => [name, structuredClone(value)]))
}

export class MemoryRepositories implements Repositories {
  private readonly messageMap = new Map<string, InboundMessage>()
  private readonly threadMap = new Map<string, Thread>()
  private readonly decisionMap = new Map<string, Decision>()
  private readonly taskMap = new Map<string, Task>()
  private readonly approvalMap = new Map<string, Approval>()
  private readonly assignmentMap = new Map<string, Assignment>()
  private readonly outboundMap = new Map<string, Outbound>()
  private depth = 0

  readonly messages: Repositories['messages'] = {
    get: (id) => this.copy(this.messageMap.get(id)),
    save: (message) => {
      if (this.messageMap.has(message.id)) throw new Error(`Duplicate message id ${message.id}`)
      this.messageMap.set(message.id, structuredClone(message))
    },
  }

  readonly threads: Repositories['threads'] = {
    get: (key) => this.copy(this.threadMap.get(key)),
    save: (thread) => {
      this.threadMap.set(thread.key, structuredClone(thread))
    },
  }

  readonly decisions: Repositories['decisions'] = {
    get: (id) => this.copy(this.decisionMap.get(id)),
    byMessageId: (messageId) => {
      for (const decision of this.decisionMap.values()) {
        if (decision.messageId === messageId) return structuredClone(decision)
      }
      return undefined
    },
    save: (decision) => {
      for (const existing of this.decisionMap.values()) {
        if (existing.id !== decision.id && existing.messageId === decision.messageId) {
          throw new Error(`Duplicate decision for message ${decision.messageId}`)
        }
      }
      this.decisionMap.set(decision.id, structuredClone(decision))
    },
  }

  readonly tasks: Repositories['tasks'] = {
    get: (id) => this.copy(this.taskMap.get(id)),
    save: (task) => {
      this.taskMap.set(task.id, structuredClone(task))
    },
    open: () =>
      [...this.taskMap.values()]
        .filter((task) => ['captured', 'awaiting-approval', 'approved', 'running'].includes(task.status))
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
        .map((task) => structuredClone(task)),
  }

  readonly approvals: Repositories['approvals'] = {
    get: (id) => this.copy(this.approvalMap.get(id)),
    byTaskId: (taskId) => {
      for (const approval of this.approvalMap.values()) {
        if (approval.taskId === taskId) return structuredClone(approval)
      }
      return undefined
    },
    save: (approval) => {
      for (const existing of this.approvalMap.values()) {
        if (existing.id !== approval.id && existing.taskId === approval.taskId) {
          throw new Error(`Duplicate approval for task ${approval.taskId}`)
        }
      }
      this.approvalMap.set(approval.id, structuredClone(approval))
    },
    listPending: () =>
      [...this.approvalMap.values()]
        .filter((approval) => approval.status === 'pending')
        .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt) || left.id.localeCompare(right.id))
        .map((approval) => structuredClone(approval)),
  }

  readonly assignments: Repositories['assignments'] = {
    get: (id) => this.copy(this.assignmentMap.get(id)),
    save: (assignment) => {
      this.assignmentMap.set(assignment.id, structuredClone(assignment))
    },
  }

  readonly outbound: Repositories['outbound'] = {
    get: (id) => this.copy(this.outboundMap.get(id)),
    byIdempotencyKey: (key) => {
      for (const outbound of this.outboundMap.values()) {
        if (outbound.idempotencyKey === key) return structuredClone(outbound)
      }
      return undefined
    },
    save: (outbound) => {
      for (const existing of this.outboundMap.values()) {
        if (existing.id !== outbound.id && existing.idempotencyKey === outbound.idempotencyKey) {
          throw new Error(`Duplicate idempotency key ${outbound.idempotencyKey}`)
        }
      }
      this.outboundMap.set(outbound.id, structuredClone(outbound))
    },
    pending: () =>
      [...this.outboundMap.values()]
        .filter((outbound) => outbound.status === 'pending')
        .map((outbound) => structuredClone(outbound)),
  }

  atomic<T>(work: () => T): T {
    if (this.depth !== 0) throw new Error('Nested transactions are not supported; run one command per transaction')
    this.depth = 1
    const snapshot: Snapshot = {
      messages: cloneMap(this.messageMap),
      threads: cloneMap(this.threadMap),
      decisions: cloneMap(this.decisionMap),
      tasks: cloneMap(this.taskMap),
      approvals: cloneMap(this.approvalMap),
      assignments: cloneMap(this.assignmentMap),
      outbound: cloneMap(this.outboundMap),
    }
    try {
      return work()
    } catch (error) {
      this.restore(snapshot)
      throw error
    } finally {
      this.depth = 0
    }
  }

  // Read helpers for assertions.

  listDecisions(): readonly Decision[] {
    return [...this.decisionMap.values()].map((decision) => structuredClone(decision))
  }

  listTasks(): readonly Task[] {
    return [...this.taskMap.values()].map((task) => structuredClone(task))
  }

  listApprovals(): readonly Approval[] {
    return [...this.approvalMap.values()].map((approval) => structuredClone(approval))
  }

  listAssignments(): readonly Assignment[] {
    return [...this.assignmentMap.values()].map((assignment) => structuredClone(assignment))
  }

  listOutbound(): readonly Outbound[] {
    return [...this.outboundMap.values()].map((outbound) => structuredClone(outbound))
  }

  private copy<T>(value: T | undefined): T | undefined {
    return value === undefined ? undefined : structuredClone(value)
  }

  private restore(snapshot: Snapshot): void {
    this.replace(this.messageMap, snapshot.messages)
    this.replace(this.threadMap, snapshot.threads)
    this.replace(this.decisionMap, snapshot.decisions)
    this.replace(this.taskMap, snapshot.tasks)
    this.replace(this.approvalMap, snapshot.approvals)
    this.replace(this.assignmentMap, snapshot.assignments)
    this.replace(this.outboundMap, snapshot.outbound)
  }

  private replace<T>(target: Map<string, T>, source: Map<string, T>): void {
    target.clear()
    for (const [key, value] of source) target.set(key, value)
  }
}

export const THREAD_KEY = 'at-me:target-1:conv-1'

export function inboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'message-1',
    targetId: 'target-1',
    threadKey: THREAD_KEY,
    kind: 'at-me',
    conversationId: 'conv-1',
    conversationType: 'group',
    sender: { userId: 'user-1', nick: 'Alice' },
    text: '你好',
    addressed: true,
    at: '2026-11-02T08:59:00.000Z',
    receivedAt: '2026-11-02T09:00:00.000Z',
    mentions: ['bot'],
    ...overrides,
  }
}

export interface Harness {
  readonly engine: Engine
  readonly repos: MemoryRepositories
  readonly clock: MutableClock
  readonly ids: SequentialIds
  readonly events: DomainEvent[]
  receive(overrides?: Partial<InboundMessage>): ReturnType<Engine['receive']>
}

export function createHarness(): Harness {
  const clock = createClock()
  const ids = createIds()
  const repos = new MemoryRepositories()
  const events: DomainEvent[] = []
  const engine = new Engine({ repos, ids, clock, emit: (event) => events.push(event) })
  return {
    engine,
    repos,
    clock,
    ids,
    events,
    receive: (overrides = {}) => engine.receive(inboundMessage(overrides)),
  }
}

/** Drive one inbound message to a task awaiting approval. */
export function receiveTask(
  harness: Harness,
  overrides: Partial<InboundMessage> = {},
  task: { title?: string; brief?: string; requirements?: readonly string[] } = {},
  approvalTtlMs = 60_000,
): { decision: Decision; task: Task; approval: Approval } {
  const { decision } = harness.receive(overrides)
  const classified = harness.engine.classify(decision.id, {
    intent: 'task',
    task: { title: task.title ?? '整理发布说明', brief: task.brief, requirements: task.requirements },
    approvalTtlMs,
  })
  const taskId = classified.taskId
  if (!taskId) throw new Error('classification did not create a task')
  const created = harness.engine.task(taskId)
  if (!created) throw new Error('classification did not persist the task')
  const approval = harness.repos.approvals.byTaskId(taskId)
  if (!approval) throw new Error('classification did not persist the approval')
  return { decision: classified, task: created, approval }
}

/** Drive one decision through draft and queue, leaving the reply `sending`. */
export function receiveDraft(
  harness: Harness,
  overrides: Partial<InboundMessage> = {},
): { decision: Decision; outbound: Outbound } {
  const { decision } = harness.receive(overrides)
  harness.engine.classify(decision.id, { intent: 'chat' })
  harness.engine.draft(decision.id, { text: '收到，我来看看。', researched: false, sources: [] })
  const outbound = harness.engine.queueReply(decision.id, {
    outboundId: harness.ids.next('outbound'),
    idempotencyKey: `reply:${decision.id}`,
    text: '收到，我来看看。',
    target: { kind: 'at-me', conversationId: 'conv-1' },
  })
  const current = harness.engine.decision(decision.id)
  if (!current) throw new Error('decision disappeared')
  return { decision: current, outbound }
}
