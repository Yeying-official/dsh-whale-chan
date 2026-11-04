/**
 * Test doubles for the brain layer.
 *
 * The brain tests never reach a real model, a real search provider or the wall
 * clock: `stubModel` records the request it was given and returns a queued
 * answer, `stubResearch` does the same for retrieval, and every date is built
 * from local parts so a quiet-hours assertion is timezone-independent.
 */
import {
  PersonaSchema,
  SettingsSchema,
  TargetRowSchema,
  type PersonaSettings,
  type Settings,
  type TargetRow,
} from '../../src/shared/settings.ts'
import { PromptStore } from '../../src/brain/prompts.ts'
import type {
  BrainMessage,
  GateCounters,
  GateInput,
  GateMessage,
  GateThread,
  LoopState,
  ModelPort,
  ModelRequest,
  ResearchHit,
  ResearchPort,
  ResearchSearchOptions,
} from '../../src/brain/types.ts'

/** The shipped templates, resolved from `tests/fixtures` up to the repository root. */
export const SHIPPED_PROMPTS = new URL('../../prompts/', import.meta.url)

/** A store over the real `prompts/*.md`, so tests exercise the shipped text. */
export function shippedPromptStore(): PromptStore {
  return new PromptStore({ dir: SHIPPED_PROMPTS })
}

/** Parse a partial settings overlay into complete settings, applying every default. */
export function makeSettings(overrides: Record<string, unknown> = {}): Settings {
  return SettingsSchema.parse(overrides)
}

export function makeTarget(overrides: Partial<TargetRow> = {}): TargetRow {
  return TargetRowSchema.parse({ kind: 'dm', id: 'target-1', label: '测试私聊', ...overrides })
}

/** Settings with one enabled direct-message target, the shape most gate tests need. */
export function settingsWithTarget(overrides: Record<string, unknown> = {}, target: Partial<TargetRow> = {}): Settings {
  return makeSettings({ targets: { rows: [makeTarget(target)] }, ...overrides })
}

export function makePersona(overrides: Partial<PersonaSettings> = {}): PersonaSettings {
  return PersonaSchema.parse({ ...overrides })
}

export function makeMessage(overrides: Partial<BrainMessage> = {}): BrainMessage {
  return {
    id: 'msg-1',
    text: '在吗？',
    senderId: 'user-1',
    senderName: '小明',
    kind: 'dm',
    conversationType: 'direct',
    addressed: false,
    broadcast: false,
    at: '2026-11-03T02:00:00.000Z',
    ...overrides,
  }
}

/** A local-time instant, so `getHours()` assertions do not depend on the test machine's zone. */
export function localTime(hour: number, minute = 0): Date {
  return new Date(2026, 10, 3, hour, minute, 0, 0)
}

export interface GateInputOverrides {
  readonly settings?: Settings
  readonly message?: Partial<GateMessage>
  readonly thread?: Partial<GateThread>
  readonly now?: Date
  readonly counters?: Partial<GateCounters>
  readonly loop?: Partial<LoopState>
}

export function makeGateInput(overrides: GateInputOverrides = {}): GateInput {
  return {
    settings: overrides.settings ?? settingsWithTarget(),
    message: {
      senderId: 'user-1',
      senderName: '小明',
      text: '在吗？',
      kind: 'dm',
      conversationType: 'direct',
      addressed: false,
      broadcast: false,
      ...overrides.message,
    },
    thread: { key: 'thread-1', targetId: 'target-1', kind: 'dm', ...overrides.thread },
    now: overrides.now ?? localTime(10),
    counters: { hour: 0, gapMs: Number.POSITIVE_INFINITY, ...overrides.counters },
    loop: { consecutiveAiReplies: 0, ...overrides.loop },
  }
}

export interface StubModel extends ModelPort {
  readonly requests: ModelRequest[]
}

/** A model double that answers every call with the same text, or with a function of the request. */
export function stubModel(answer: string | ((request: ModelRequest) => string | Promise<string>)): StubModel {
  const requests: ModelRequest[] = []
  return {
    requests,
    async complete(request, signal) {
      requests.push(request)
      if (signal.aborted) throw new Error('aborted')
      return typeof answer === 'string' ? answer : await answer(request)
    },
  }
}

/** A port that never settles, for deadline tests: it also ignores its abort signal. */
export function hangingModel(): ModelPort {
  return {
    complete: () => new Promise<string>(() => {}),
  }
}

export interface StubResearch extends ResearchPort {
  readonly calls: { query: string; options: ResearchSearchOptions }[]
}

export function stubResearch(answer: ResearchHit | ((query: string) => Promise<ResearchHit>)): StubResearch {
  const calls: { query: string; options: ResearchSearchOptions }[] = []
  return {
    calls,
    async search(query, options, signal) {
      calls.push({ query, options })
      if (signal.aborted) throw new Error('aborted')
      return typeof answer === 'function' ? await answer(query) : answer
    },
  }
}

/** A retrieval port that never settles, for deadline tests. */
export function hangingResearch(): ResearchPort {
  return { search: () => new Promise<ResearchHit>(() => {}) }
}
