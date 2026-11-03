/** Small pure formatters shared by the panel views. */

/** Format an ISO instant for the current locale; invalid values are shown verbatim. */
export function timeText(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
}

/** Format a timestamp with a short date/time, used in dense tables. */
export function shortTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

/**
 * Whether an owner-entered workspace is absolute enough for the host.
 *
 * A blank value is allowed and means "derive the default". The host expands a
 * leading `~` and then requires an absolute path, so the same forms are
 * accepted here before the request is sent.
 */
export function isAbsoluteWorkspace(value: string): boolean {
  const path = value.trim()
  if (path.length === 0) return true
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return true
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  return path.startsWith('/') || path.startsWith('\\')
}

/** Truncate one line of text without splitting a surrogate pair. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}
