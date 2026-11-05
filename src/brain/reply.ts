/**
 * Drafts one reply and post-processes whatever the model produced.
 *
 * The model is asked for the message body only. Everything after the call is
 * enforced here, because prompt text is advice while these checks are rules:
 *
 * - a leading code fence or a wrapping quote pair is stripped;
 * - sentences that claim to be an AI or a human are dropped;
 * - links the retrieval layer did not vouch for are removed, so a hallucinated
 *   citation cannot reach the chat;
 * - a verbatim line of the system prompt is treated as a leak and the draft is
 *   refused rather than sent;
 * - the text is cut to `persona.maxReplyChars`; citations have a separate
 *   ceiling and are trimmed or dropped instead of shortening the body.
 */
import type { PersonaSettings } from '../shared/settings.ts'
import { withDeadline } from './deadline.ts'
import {
  codePointLength,
  collapseBlankLines,
  normalizeWhitespace,
  outputSample,
  redactSecretLike,
  renderThreadWindow,
  truncateSentence,
} from './format.ts'
import { personaStyleRules, renderPersona } from './persona.ts'
import { defaultPromptStore, render } from './prompts.ts'
import { renderResearchGuide } from './research.ts'
import type {
  BrainMessage,
  ClassifySuccess,
  ComposeFailureReason,
  ComposeResult,
  ModelPort,
  PromptSource,
  ResearchResult,
  ResearchSource,
  ThreadWindow,
} from './types.ts'

/** Wall-clock budget for one reply draft; a real first call can take 15–40s. */
export const DEFAULT_REPLY_TIMEOUT_MS = 60_000

/** A system-prompt line shorter than this is too generic to prove a leak. */
const LEAK_LINE_MIN_CHARS = 24

/**
 * Independent ceiling for the trailing citation block, in code points.
 *
 * Citations are evidence, not the reply: they are bounded on their own (about
 * twice the default body limit) so a long footer can never eat the body budget.
 */
export const CITATIONS_MAX_CHARS = 600

/** Claimed-identity phrasings that never belong in a reply written as the owner. */
const DISCLAIMER_CLAUSE =
  /(?:^|[，,；;。！？!?\n])\s*(?:(?:作为|身为)(?:一个|一名)?[^，,；;。！？!?\n]{0,20}?(?:AI|ＡＩ|人工智能|机器人|语言模型|大模型)|我是(?:一个|一名)?(?:AI|ＡＩ|人工智能|机器人|语言模型|大模型|人类|真人|真人助理)|我是人类|我是真人)/giu

const DISCLAIMER_CLAUSE_EN =
  /(?:^|[.!?;\n])\s*(?:as an? (?:ai|assistant|language model)|i(?:'m| am) (?:an? )?(?:ai|language model))/giu

const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&*+;=%]+/gu

export interface SanitizeOptions {
  /** Hard ceiling in code points. */
  readonly maxChars: number
  /** System prompt the reply must not echo; omitted in tests that do not check leaks. */
  readonly systemPrompt?: string
  /** URLs the draft may keep; when omitted, links are left untouched. */
  readonly allowedUrls?: readonly string[]
  /** Sources to append when the draft cites nothing itself. */
  readonly citeSources?: readonly ResearchSource[]
}

export interface SanitizeResult {
  readonly text: string
  /** Research URLs present in the final text, in the order given. */
  readonly sources: readonly string[]
  readonly echoedSystemPrompt: boolean
  readonly truncated: boolean
  /** What happened to the citation block: kept whole, trimmed by lines, or omitted. */
  readonly citations: 'kept' | 'trimmed' | 'dropped'
}

/** Remove one whole-output code fence, or a stray fence line at either edge. */
export function stripFences(text: string): string {
  const trimmed = text.trim()
  const whole = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  if (whole) return (whole[1] ?? '').trim()
  return trimmed
    .replace(/^```[^\n]*\n/u, '')
    .replace(/\n?```$/u, '')
    .trim()
}

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
  ["'", "'"],
  ['《', '》'],
]

/** Strip a wrapping quote pair, repeatedly: a model often adds two layers. */
export function stripWrappingQuotes(text: string): string {
  let result = text.trim()
  for (;;) {
    const pair = QUOTE_PAIRS.find(
      ([open, close]) => result.length > 2 && result.startsWith(open) && result.endsWith(close),
    )
    if (!pair) return result
    result = result.slice(pair[0].length, result.length - pair[1].length).trim()
  }
}

/** Drop clauses that claim an AI or human identity, keeping the rest of the sentence. */
export function stripDisclaimers(text: string): string {
  const kept = text
    .replace(DISCLAIMER_CLAUSE, (match) => (/^[，,；;。！？!?\n]/u.test(match) ? (match[0] ?? '') : ''))
    .replace(DISCLAIMER_CLAUSE_EN, '')
  return kept
    .replace(/([，,])\s*[，,]/gu, '$1')
    .replace(/^[，,、；;：:\s]+/u, '')
    .replace(/\s+([。！？!?])/gu, '$1')
    .trim()
}

function withoutUrlText(text: string, allowed: ReadonlySet<string>): string {
  return text
    .replace(URL_PATTERN, (url) => (allowed.has(url) ? url : ''))
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[（(]\s*[）)]/gu, '')
    .replace(/\s+([。！？!?，,；;])/gu, '$1')
}

function urlsIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(URL_PATTERN)) found.add(match[0])
  return found
}

function longLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => normalizeWhitespace(line).replace(/^(?:[-*]|\d+\.)\s+/u, ''))
    .filter((line) => codePointLength(line) >= LEAK_LINE_MIN_CHARS && !line.startsWith('#'))
}

/**
 * Whether the draft repeats a line of its own system prompt.
 *
 * A leaked line is not merely a style problem: it tells the recipient what the
 * owner configured, so the draft is refused instead of being cleaned, because a
 * model that leaks once will leak again on the next try.
 */
export function echoesSystemPrompt(reply: string, systemPrompt: string | undefined): boolean {
  if (!systemPrompt || systemPrompt.trim().length === 0) return false
  const normalized = normalizeWhitespace(reply)
  if (codePointLength(normalized) < LEAK_LINE_MIN_CHARS) return false
  return longLines(systemPrompt).some((line) => normalized.includes(line))
}

/** Lines of the trailing citation block; one source contributes one line. */
function buildCitations(sources: readonly ResearchSource[], limit = 3): string[] {
  return sources.slice(0, limit).map((source) => `- ${source.title}：${source.url}`)
}

function renderCitations(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `参考：\n${lines.join('\n')}`
}

/**
 * Fit the citation block into its own ceiling, dropping whole lines from the tail.
 *
 * A line is never cut: half a URL is not a citation. Trimming therefore removes
 * sources instead of shortening them, and the block disappears entirely when no
 * single line fits.
 */
function fitCitations(lines: readonly string[]): { footer: string; citations: SanitizeResult['citations'] } {
  if (lines.length === 0) return { footer: '', citations: 'dropped' }
  if (codePointLength(renderCitations(lines)) <= CITATIONS_MAX_CHARS) {
    return { footer: renderCitations(lines), citations: 'kept' }
  }
  for (let count = lines.length - 1; count >= 1; count -= 1) {
    const footer = renderCitations(lines.slice(0, count))
    if (codePointLength(footer) <= CITATIONS_MAX_CHARS) return { footer, citations: 'trimmed' }
  }
  return { footer: '', citations: 'dropped' }
}

/**
 * Apply every post-check to a raw draft.
 *
 * The order matters: cleaning happens before the leak check (so a fence cannot
 * hide a leaked line), the leak check happens before truncation (so a cut cannot
 * hide one), and citations are appended last against their own ceiling so the
 * body always keeps the full persona limit.
 */
export function sanitizeReply(draft: string, options: SanitizeOptions): SanitizeResult {
  const maxChars = Math.max(options.maxChars, 0)
  let text = collapseBlankLines(stripWrappingQuotes(stripFences(draft)))
  text = collapseBlankLines(stripDisclaimers(text))
  // A model that repeats a credential from the conversation must not send it back.
  text = redactSecretLike(text)

  const allowed = options.allowedUrls === undefined ? undefined : new Set(options.allowedUrls)
  if (allowed) text = withoutUrlText(text, allowed)

  const echoedSystemPrompt = echoesSystemPrompt(text, options.systemPrompt)
  const truncated = codePointLength(text) > maxChars

  // The body owns the whole persona budget. Citations are paid for separately,
  // so an oversized footer can never shorten or empty the reply itself.
  const body = truncateSentence(text, maxChars)
  const fitted =
    body.length > 0 && allowed && options.citeSources && options.citeSources.length > 0 && urlsIn(body).size === 0
      ? fitCitations(buildCitations(options.citeSources, 3))
      : { footer: '', citations: 'dropped' as const }

  const finalText = fitted.footer.length > 0 ? `${body}\n\n${fitted.footer}` : body
  const present = urlsIn(finalText)
  const sources = options.allowedUrls === undefined ? [] : options.allowedUrls.filter((url) => present.has(url))

  return {
    text: finalText,
    sources,
    echoedSystemPrompt,
    truncated: truncated || body.length < codePointLength(text),
    citations: fitted.citations,
  }
}

function describeClassification(classification: ClassifySuccess): string {
  const lines = [
    `- 意图：${classification.intent}`,
    `- 置信度：${classification.confidence.toFixed(2)}`,
    `- 需要检索：${classification.needSearch ? '是' : '否'}`,
  ]
  if (classification.task) {
    lines.push(`- 任务标题：${classification.task.title}`)
    if (classification.task.brief) lines.push(`- 任务说明：${classification.task.brief}`)
    if (classification.task.requirements.length > 0) {
      lines.push(`- 验收点：${classification.task.requirements.join('；')}`)
    }
  }
  return lines.join('\n')
}

export interface ReplyOptions {
  /** Template source; defaults to the packaged prompts. */
  readonly prompts?: PromptSource
  readonly ownerName?: string
  readonly targetLabel?: string
  /** Injected clock, shared with the persona block. */
  readonly now?: Date
  /** Wall-clock budget for the model call. */
  readonly timeoutMs?: number
  /** Pre-rendered persona block, when the caller already has one. */
  readonly personaText?: string
}

export interface ComposeInput {
  readonly persona: PersonaSettings
  readonly classification: ClassifySuccess
  readonly message: BrainMessage
  readonly threadWindow: ThreadWindow
  readonly research?: ResearchResult
  readonly options?: ReplyOptions
}

function describeMessage(message: BrainMessage): string {
  const where = message.conversationType === 'group' ? '群聊' : '私聊'
  const addressed = message.addressed ? '（@ 了助理）' : ''
  return `${message.senderName || '对方'}（${where}）${addressed}：${message.text}`
}

/**
 * Whether a compose failure is worth one automatic retry.
 *
 * A timeout and a leaked system prompt are refused: retrying either would spend
 * another call for the same deterministic outcome.
 */
export function isRetryableComposeFailure(reason: ComposeFailureReason): boolean {
  return reason === 'empty' || reason === 'sanitized_empty' || reason === 'model_error'
}

/**
 * Ask the model for a reply body and return it only if it survives every check.
 *
 * `sources` lists the research links that stayed in the text, which is what the
 * draft and the panel show; the sender appends its own fixed AI badge and never
 * takes it from model output.
 */
export async function composeReply(input: ComposeInput, model: ModelPort, signal: AbortSignal): Promise<ComposeResult> {
  const options = input.options ?? {}
  const prompts = options.prompts ?? defaultPromptStore()
  const persona = input.persona
  const personaText =
    options.personaText ??
    renderPersona(persona, {
      ownerName: options.ownerName,
      targetLabel: options.targetLabel,
      now: options.now ?? new Date(),
    })
  const style = personaStyleRules(persona)
  const researchGuide = input.research
    ? renderResearchGuide(prompts, { facts: input.research.facts, sources: input.research.sources })
    : ''
  const system = render(prompts.get('reply'), {
    safety: render(prompts.get('safety'), { persona_name: persona.name }),
    classification: describeClassification(input.classification),
    persona: personaText,
    research_guide: researchGuide,
    max_reply_chars: persona.maxReplyChars,
    emoji_rule: style.emoji,
    language_rule: style.language,
    signature_rule: style.signature,
    message: describeMessage(input.message),
    thread: renderThreadWindow(input.threadWindow),
  })

  const outcome = await withDeadline(
    (inner) =>
      model.complete(
        {
          system,
          messages: [{ role: 'user', content: '请按上面的要求写出这一条回复正文。' }],
          maxChars: persona.maxReplyChars,
        },
        inner,
      ),
    signal,
    options.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
  )

  if (!outcome.ok) {
    if (outcome.reason === 'timeout') return { ok: false, reason: 'timeout' }
    if (outcome.reason === 'aborted') return { ok: false, reason: 'model_error', detail: 'cancelled' }
    return { ok: false, reason: 'model_error', detail: outcome.detail ?? 'model error' }
  }
  // A model that said nothing is a different failure from a draft that our own
  // cleaning emptied; keeping them apart lets the app retry only the latter.
  if (outcome.value.trim() === '') return { ok: false, reason: 'empty', detail: outputSample(outcome.value) }

  const research = input.research
  const sanitized = sanitizeReply(outcome.value, {
    maxChars: persona.maxReplyChars,
    systemPrompt: system,
    // A link is allowed only when retrieval vouched for it; without retrieval the
    // draft may still quote a link the person sent.
    allowedUrls: research ? research.sources.map((source) => source.url) : undefined,
    citeSources: research?.includeCitations ? research.sources : undefined,
  })

  if (sanitized.echoedSystemPrompt) return { ok: false, reason: 'echoes_system_prompt' }
  if (sanitized.text.length === 0) return { ok: false, reason: 'sanitized_empty', detail: outputSample(outcome.value) }
  return { ok: true, text: sanitized.text, sources: sanitized.sources }
}
