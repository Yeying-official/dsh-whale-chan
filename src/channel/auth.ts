/**
 * Read-only authentication probe.
 *
 * Two invocations: `--version` (does the binary exist?) and `auth status
 * --format json` (is the personal authorization still usable?). Only booleans,
 * the version string and the expiry instant leave this module — never a token,
 * an account id or the raw payload. Every failure degrades to
 * `available: false` instead of throwing into the host.
 */
import type { Settings } from '../shared/settings.ts'
import { toIsoTime } from './normalize.ts'
import { createRunner } from './process.ts'
import { withProfile } from './targets.ts'
import type { AuthState, CommandRunner } from './types.ts'

export interface AuthIo {
  readonly runner?: CommandRunner
  readonly versionTimeoutMs?: number
  readonly statusTimeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the first boolean among several spellings; anything else stays unknown. */
function readBoolean(record: Record<string, unknown>, fields: readonly string[]): boolean | undefined {
  for (const field of fields) {
    const value = record[field]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true' || normalized === '1') return true
      if (normalized === 'false' || normalized === '0') return false
    }
  }
  return undefined
}

/** Read the first non-empty string among several spellings. */
function readString(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = record[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/** Extract `x.y.z` from a version banner without trusting its surrounding text. */
export function parseVersion(text: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)
  return match?.[1]
}

/**
 * Probe the local dws installation.
 *
 * `available` means the executable answered `--version`; it is independent from
 * `authenticated` so a host can render "installed but logged out".
 */
export async function probeAuth(settings: Settings, io: AuthIo = {}): Promise<AuthState> {
  const unavailable: AuthState = { available: false, authenticated: false, tokenValid: false }
  const runner: CommandRunner = io.runner ?? createRunner({ command: settings.dws.binaryPath })

  try {
    const versionResult = await runner.run(['--version'], { timeoutMs: io.versionTimeoutMs ?? 5_000 })
    if (versionResult.error || versionResult.timedOut || versionResult.code !== 0) return unavailable
    const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
    if (!version) return unavailable

    const statusResult = await runner.run(withProfile(['auth', 'status', '--format', 'json'], settings), {
      timeoutMs: io.statusTimeoutMs ?? 8_000,
    })
    const payload = statusResult.error || statusResult.timedOut ? undefined : parseJsonDocument(statusResult.stdout)
    if (!isRecord(payload)) {
      return { available: true, version, authenticated: false, tokenValid: false }
    }

    const authenticated =
      readBoolean(payload, ['authenticated', 'isAuthenticated', 'is_authenticated', 'loggedIn', 'logged_in']) ?? false
    const tokenValid = readBoolean(payload, ['token_valid', 'tokenValid', 'accessTokenValid']) ?? false
    const expiresAt = toIsoTime(payload.expires_at ?? payload.expiresAt ?? payload.tokenExpiresAt)
    // Returned to the host only; it becomes `ownerUserId` for self-detection.
    const userId = readString(payload, [
      'user_id',
      'userId',
      'staff_id',
      'staffId',
      'open_dingtalk_id',
      'openDingTalkId',
    ])
    // The flattened group event carries no atUsers; `@<userName>` is the only
    // way to tell a mention, so expose it to the host as `ownerNick`.
    const userName = readString(payload, ['user_name', 'userName'])

    return {
      available: true,
      version,
      authenticated,
      tokenValid,
      ...(expiresAt ? { expiresAt } : {}),
      ...(userId ? { userId } : {}),
      ...(userName ? { userName } : {}),
    }
  } catch {
    // A throwing runner is still "not available" for the caller: the probe is a
    // status read, not a critical path that may fail the host.
    return unavailable
  }
}
