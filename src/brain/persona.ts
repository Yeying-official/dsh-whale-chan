/**
 * Assembles the persona block from settings.
 *
 * `persona` is the only source of the assistant's identity: name, identity
 * statement, tone, language, signature, rules, background knowledge, examples
 * and the reply length cap. This module renders those fields into the frame in
 * `prompts/persona.md`; it reads no environment variable, configuration file or
 * secret, so the block can only ever contain what the owner typed in settings.
 *
 * Extras are bounded on purpose. A persona pasted from a long document must not
 * crowd the message out of the model's context, so an over-long persona loses
 * its examples first, then its background knowledge, then its trailing rules.
 */
import type { PersonaSettings } from '../shared/settings.ts'
import { EMPTY_PERSONA } from '../shared/persona-defaults.ts'
import { clip, codePointLength, collapseBlankLines, formatLocalTime, redactSecretLike } from './format.ts'
import { render } from './prompts.ts'

/** Hard ceiling for the rendered persona block, in Unicode code points. */
export const PERSONA_MAX_CHARS = 6000

/**
 * Fallback frame used when a caller has no `PromptStore` (unit tests, or a
 * prompt reload before the store exists). `tests/brain-prompts.spec.ts` holds
 * the shipped `prompts/persona.md` to the same placeholder set, so the two
 * cannot drift apart without a failing test.
 */
export const PERSONA_FRAME = `你是「{{name}}」，{{owner}} 的钉钉回复助理，以主人的身份对外回复。

{{identity}}

{{rules}}

{{knowledge}}

{{samples}}

{{style}}

{{context}}

{{limit}}`

/** Values the frame needs from the conversation, not from settings. */
export interface PersonaContext {
  /** How the owner is addressed; defaults to 「主人」. */
  readonly ownerName?: string
  /** Conversation label, such as a group name. */
  readonly targetLabel?: string
  /** Injected clock; quiet hours and prompts both read the same instant. */
  readonly now: Date
}

export interface PersonaRenderOptions {
  /** Frame to fill; defaults to `PERSONA_FRAME`. */
  readonly template?: string
  /** Ceiling in code points; defaults to `PERSONA_MAX_CHARS`. */
  readonly limit?: number
}

function trimOrEmpty(value: string | undefined): string {
  return (value ?? '').trim()
}

function section(title: string, body: string, prefix = ''): string {
  const text = body.trim()
  return text.length === 0 ? '' : `## ${title}\n${prefix}${text}`
}

function languageRule(language: PersonaSettings['language']): string {
  switch (language) {
    case 'zh-CN':
      return '语言：始终使用简体中文。'
    case 'en':
      return '语言：始终使用英语，即使对方用中文提问。'
    default:
      return '语言：跟随对方使用的语言；对方混用时以中文为主。'
  }
}

function emojiRule(allowEmoji: boolean): string {
  return allowEmoji ? '表情：可以少量使用 emoji，每段最多一个。' : '表情：不要使用 emoji。'
}

function signatureLine(signature: string): string {
  return signature.length === 0 ? '' : `- 签名：回复末尾以「${signature}」结尾，不加引号。`
}

/** The style rules a reply prompt needs, in the exact wording the persona block uses. */
export interface PersonaStyleRules {
  readonly language: string
  readonly emoji: string
  readonly signature: string
}

/** Style rules for the reply prompt, so the persona block and the reply prompt cannot disagree. */
export function personaStyleRules(persona: PersonaSettings): PersonaStyleRules {
  const signature = trimOrEmpty(persona.signature)
  return {
    language: languageRule(persona.language),
    emoji: emojiRule(persona.allowEmoji),
    signature: signature.length === 0 ? '不需要签名。' : `回复末尾以「${signature}」结尾，不加引号。`,
  }
}

interface PersonaDraft {
  readonly samples: readonly string[]
  readonly rules: readonly string[]
  readonly knowledge: string
}

function fillFrame(persona: PersonaSettings, context: PersonaContext, template: string, draft: PersonaDraft): string {
  const name = trimOrEmpty(persona.name) || EMPTY_PERSONA.name
  const owner = trimOrEmpty(context.ownerName) || '主人'
  const knowledge = trimOrEmpty(draft.knowledge)
  const style = [
    `- 语气：${trimOrEmpty(persona.tone) || '自然、克制，不喧宾夺主'}`,
    `- ${languageRule(persona.language)}`,
    `- ${emojiRule(persona.allowEmoji)}`,
    signatureLine(trimOrEmpty(persona.signature)),
  ]
    .filter((line) => line.length > 0)
    .join('\n')
  const contextLines = [
    trimOrEmpty(context.targetLabel).length > 0 ? `- 当前会话：${trimOrEmpty(context.targetLabel)}` : '',
    `- 当前时间：${formatLocalTime(context.now)}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n')

  const rendered = render(template, {
    name,
    owner,
    identity: trimOrEmpty(persona.identity),
    rules: draft.rules.length > 0 ? draft.rules.map((rule) => `- ${rule}`).join('\n') : '',
    knowledge,
    samples: draft.samples.map((sample, index) => `示例 ${index + 1}：${sample}`).join('\n'),
    style,
    context: contextLines,
    limit: `单条回复不超过 ${persona.maxReplyChars} 个字符（含标点）。`,
  })
  return redactSecretLike(collapseBlankLines(rendered))
}

/**
 * Render the persona block.
 *
 * Empty fields disappear instead of leaving an empty heading. When the result
 * exceeds `limit`, examples are dropped from the last one backwards, then the
 * background knowledge, then trailing rules; a persona that is still too long
 * after that is clipped, so the block always fits the ceiling.
 */
export function renderPersona(
  persona: PersonaSettings,
  context: PersonaContext,
  options: PersonaRenderOptions = {},
): string {
  const template = options.template ?? PERSONA_FRAME
  const limit = options.limit ?? PERSONA_MAX_CHARS
  const samples = persona.samples.map(trimOrEmpty).filter((sample) => sample.length > 0)
  const rules = persona.rules.map(trimOrEmpty).filter((rule) => rule.length > 0)
  let knowledge = trimOrEmpty(persona.knowledge)

  for (;;) {
    const text = fillFrame(persona, context, template, { samples, rules, knowledge })
    if (codePointLength(text) <= limit) return text
    if (samples.length > 0) {
      samples.pop()
      continue
    }
    if (knowledge.length > 0) {
      knowledge = ''
      continue
    }
    if (rules.length > 0) {
      rules.pop()
      continue
    }
    return clip(text, limit)
  }
}

/**
 * One-line persona summary for prompts that judge a message rather than answer
 * it, such as the classifier. It carries identity only, never rules or samples.
 */
export function renderPersonaSummary(
  persona: PersonaSettings,
  context: Pick<PersonaContext, 'ownerName'> = {},
): string {
  const name = trimOrEmpty(persona.name) || EMPTY_PERSONA.name
  const owner = trimOrEmpty(context.ownerName) || '主人'
  const tone = trimOrEmpty(persona.tone) || '自然克制'
  return `「${name}」，${owner} 的钉钉回复助理；语气：${tone}。`
}
