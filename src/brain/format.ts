/**
 * Text helpers shared by the brain modules.
 *
 * They are pure string functions so every prompt now has one definition of
 * "normalized", "bounded" and "redacted". Nothing here reads the environment,
 * the clock or the filesystem.
 */

/** Collapse every whitespace run (including newlines) to one space and trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** Collapse runs of blank lines and trim; keeps deliberate line structure. */
export function collapseBlankLines(text: string): string {
  return text
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** Length in Unicode code points, which is what `maxReplyChars` means to a person. */
export function codePointLength(text: string): number {
  return [...text].length
}

/** Cut to `max` code points, appending `ellipsis` inside the budget. */
export function clip(text: string, max: number, ellipsis = '…'): string {
  const points = [...text]
  if (max <= 0) return ''
  if (points.length <= max) return text
  const suffix = [...ellipsis].length < max ? ellipsis : ''
  const room = max - [...suffix].length
  return points.slice(0, room).join('').trimEnd() + suffix
}

/**
 * Cut to `max` code points, preferring the last sentence boundary in the tail.
 * The result never exceeds `max`, and an ellipsis marks an unfinished sentence.
 */
export function truncateSentence(text: string, max: number): string {
  const points = [...text]
  if (max <= 0) return ''
  if (points.length <= max) return text
  const window = points.slice(0, max)
  const floor = Math.floor(max * 0.6)
  let cut = -1
  for (let index = window.length - 1; index >= floor; index -= 1) {
    if ('。！？!?；;，,.\n'.includes(window[index] ?? '')) {
      cut = index
      break
    }
  }
  if (cut < 0) return clip(text, max)
  const kept = window
    .slice(0, cut + 1)
    .join('')
    .trimEnd()
  // Replacing the final punctuation with an ellipsis keeps the budget exact.
  return clip(kept, max)
}

/** Join strings as a markdown bullet list; empty entries are dropped. */
export function bulletList(items: readonly string[], prefix = '- '): string {
  return items
    .map((item) => normalizeWhitespace(item))
    .filter((item) => item.length > 0)
    .map((item) => `${prefix}${item}`)
    .join('\n')
}

/** Remove HTML comments, which is how a prompt file documents itself without leaking into a model call. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/gu, '')
}

/** `YYYY-MM-DD HH:mm` in the machine's local time, which is the clock people read. */
export function formatLocalTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Mask material that looks like a credential.
 *
 * Persona fields and model output are copied into requests to a third-party
 * model, so a pasted token or an API key must not travel with them. The
 * patterns are deliberately narrow: they only fire on credential shapes, never
 * on ordinary prose, code snippets or hashes.
 */
const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string | ((match: string) => string) }[] = [
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/gu, replacement: 'sk-***' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu, replacement: 'Bearer ***' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/gu, replacement: 'AKIA***' },
  {
    pattern: /\b(?:api[_-]?key|access[_-]?token|token|secret|password|passwd)\s*[:=]\s*\S{8,}/giu,
    replacement: (match) => `${match.split(/[:=]/u)[0]?.trimEnd() ?? 'secret'}: ***`,
  },
]

export function redactSecretLike(text: string): string {
  let result = text
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    if (typeof replacement === 'string') result = result.replace(pattern, replacement)
    else result = result.replace(pattern, (match) => replacement(match))
  }
  return result
}

export interface ThreadWindowRenderOptions {
  /** How many trailing entries to include. */
  readonly entries?: number
  /** Per-entry character cap. */
  readonly entryChars?: number
  /** Total character cap; the window keeps the newest entries when it overflows. */
  readonly totalChars?: number
  /** Text used when there is nothing to show. */
  readonly empty?: string
}

/**
 * Render recent history as `昵称：内容` lines.
 *
 * The window is bounded twice (per entry and in total) so a long conversation
 * cannot crowd the instruction out of the model's context, and the newest
 * entries win the remaining budget.
 */
export function renderThreadWindow(
  window: readonly { author: string; text: string; self: boolean }[],
  options: ThreadWindowRenderOptions = {},
): string {
  const entries = options.entries ?? 12
  const entryChars = options.entryChars ?? 400
  const totalChars = options.totalChars ?? 4000
  const lines = window.slice(-entries).map((entry) => {
    const author = normalizeWhitespace(entry.author) || (entry.self ? '我' : '对方')
    return `${author}：${clip(normalizeWhitespace(entry.text), entryChars)}`
  })
  if (lines.length === 0) return options.empty ?? '（无）'
  let text = lines.join('\n')
  if ([...text].length > totalChars) {
    const points = [...text]
    text = `…${points.slice(points.length - totalChars + 1).join('')}`
  }
  return text
}
