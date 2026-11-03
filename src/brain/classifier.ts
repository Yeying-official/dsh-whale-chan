/**
 * Classifies one message into chat / question / task / ignore.
 *
 * The model is asked for one JSON object. The answer is extracted from a bare
 * object, a fenced block or a noisy reply, validated strictly with zod, and
 * normalized so downstream code never has to guess:
 *
 * - `task` is kept only for `intent: 'task'`, and then must have a non-empty title.
 * - `need_search` is kept only for `intent: 'question'`; every other intent is false.
 *
 * A failure is a normal outcome, not an exception: an invalid answer, a deadline
 * and a low confidence all return `{ ok: false }` so the caller can defer the
 * message instead of sending something unverified.
 */
import { z } from 'zod'
import type { PersonaSettings } from '../shared/settings.ts'
import { withDeadline } from './deadline.ts'
import { formatLocalTime, renderThreadWindow } from './format.ts'
import { renderPersonaSummary } from './persona.ts'
import { defaultPromptStore, render } from './prompts.ts'
import type {
  BrainMessage,
  ClassifiedTask,
  ClassifyResult,
  ClassifySuccess,
  Intent,
  ModelPort,
  PromptSource,
  ThreadWindow,
} from './types.ts'

/** Below this confidence the classifier is treated as undecided. */
export const DEFAULT_MIN_CONFIDENCE = 0.55

/** Wall-clock budget for one classification call; a real first call can take 15–40s. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 60_000

/** Response budget hint: the contract fits well inside this. */
export const CLASSIFY_MAX_RESPONSE_CHARS = 800

const TaskSchema = z
  .object({
    title: z.string().max(160),
    brief: z.string().max(2000).optional(),
    requirements: z.array(z.string().max(300)).max(20).optional(),
  })
  .strict()

/** The exact shape the classifier prompt asks for; unknown keys are refused. */
const RawClassificationSchema = z
  .object({
    intent: z.enum(['chat', 'question', 'task', 'ignore']),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(300).default(''),
    need_search: z.boolean().default(false),
    task: TaskSchema.optional(),
  })
  .strict()

/** A validated and normalized classification, before the confidence threshold. */
export type ParsedClassification = Omit<ClassifySuccess, 'ok'>

export type ParseOutcome =
  | { readonly ok: true; readonly value: ParsedClassification }
  | { readonly ok: false; readonly detail: string }

/**
 * Take the first parseable JSON value out of a model reply.
 *
 * Fenced blocks are tried first (a model that adds a fence usually also adds
 * prose), then the whole text, then the span from the first `{` to the last
 * `}`. Anything else returns `null`, which the caller reports as invalid.
 */
export function extractJsonObject(text: string): unknown | null {
  const candidates: string[] = []
  const fenced = /```[ \t]*(?:json|JSON)?[ \t]*\n([\s\S]*?)```/gu
  for (const match of text.matchAll(fenced)) candidates.push((match[1] ?? '').trim())
  for (const match of text.matchAll(fenced)) {
    const body = (match[1] ?? '').trim()
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) candidates.push(body.slice(start, end + 1))
  }
  candidates.push(text.trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))

  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Try the next candidate; a noisy prefix is expected, not exceptional.
    }
  }
  return null
}

/**
 * Validate a raw model answer and normalize the two fields that carry meaning
 * beyond their literal value. Every failure names the field, never the text.
 */
export function parseClassification(response: string): ParseOutcome {
  const raw = extractJsonObject(response)
  if (raw === null) return { ok: false, detail: 'no JSON object in the model answer' }

  const parsed = RawClassificationSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first?.path.join('.') || '(root)'
    return { ok: false, detail: `invalid classification at ${path}` }
  }

  const value = parsed.data
  const intent = value.intent as Intent
  let task: ClassifiedTask | null = null
  if (intent === 'task') {
    const title = (value.task?.title ?? '').trim()
    if (title.length === 0) return { ok: false, detail: 'task intent requires a non-empty title' }
    task = {
      title,
      brief: (value.task?.brief ?? '').trim(),
      requirements: (value.task?.requirements ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
    }
  }

  return {
    ok: true,
    value: {
      intent,
      confidence: value.confidence,
      reason: value.reason.trim(),
      // Only a question may search; a model that sets this on other intents is normalized.
      needSearch: intent === 'question' && value.need_search,
      task,
    },
  }
}

export interface ClassifyOptions {
  /** Confidence floor; defaults to `DEFAULT_MIN_CONFIDENCE`. */
  readonly minConfidence?: number
  /** Wall-clock budget for the model call. */
  readonly timeoutMs?: number
  /** Template source; defaults to the packaged prompts. */
  readonly prompts?: PromptSource
  readonly ownerName?: string
  readonly targetLabel?: string
  /** Injected clock, so the prompt is reproducible in tests. */
  readonly now?: Date
}

export interface ClassifyInput {
  readonly message: BrainMessage
  readonly threadWindow: ThreadWindow
  readonly persona: PersonaSettings
  readonly model: ModelPort
  readonly options?: ClassifyOptions
}

function describeTarget(input: ClassifyInput): string {
  const label = input.options?.targetLabel?.trim()
  if (label) return label
  return input.message.conversationType === 'group' ? '群聊' : '私聊'
}

function buildUserTurn(input: ClassifyInput): string {
  const window = renderThreadWindow(input.threadWindow, { entries: 12, entryChars: 400, totalChars: 3000 })
  return [
    '## 会话窗口（旧的在前）',
    window,
    '',
    '## 待判断的消息',
    `${input.message.senderName || '对方'}：${input.message.text}`,
    '',
    input.message.addressed ? '（这条消息 @ 了助理）' : '',
    '',
    '请只输出一个 JSON 对象。',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * Classify one message.
 *
 * The prompt carries the safety block, a one-line persona summary and a bounded
 * conversation window. The model answer is parsed and validated; the confidence
 * floor is applied last, so a well-formed but unsure answer is reported as
 * `low_confidence` rather than being treated as a valid decision.
 */
export async function classify(input: ClassifyInput, signal: AbortSignal): Promise<ClassifyResult> {
  const prompts = input.options?.prompts ?? defaultPromptStore()
  const persona = renderPersonaSummary(input.persona, { ownerName: input.options?.ownerName })
  const system = render(prompts.get('classifier'), {
    safety: render(prompts.get('safety'), { persona_name: input.persona.name }),
    persona,
    target: describeTarget(input),
    now: formatLocalTime(input.options?.now ?? new Date()),
  })

  const outcome = await withDeadline(
    (inner) =>
      input.model.complete(
        { system, messages: [{ role: 'user', content: buildUserTurn(input) }], maxChars: CLASSIFY_MAX_RESPONSE_CHARS },
        inner,
      ),
    signal,
    input.options?.timeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS,
  )

  if (!outcome.ok) {
    if (outcome.reason === 'timeout') return { ok: false, reason: 'timeout' }
    if (outcome.reason === 'aborted') return { ok: false, reason: 'invalid', detail: 'cancelled' }
    return { ok: false, reason: 'invalid', detail: outcome.detail ?? 'model error' }
  }

  const parsed = parseClassification(outcome.value)
  if (!parsed.ok) return { ok: false, reason: 'invalid', detail: parsed.detail }

  const floor = input.options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  if (parsed.value.confidence < floor) {
    return {
      ok: false,
      reason: 'low_confidence',
      detail: `confidence ${parsed.value.confidence.toFixed(2)} is below ${floor.toFixed(2)}`,
    }
  }

  return { ok: true, ...parsed.value }
}
