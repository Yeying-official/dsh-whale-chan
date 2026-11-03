/**
 * Non-destructive target validation.
 *
 * Validation runs the exact `event consume` spec with `--dry-run`, so it proves
 * the id, the event key and the flags are accepted without opening a
 * subscription or waiting for an event.
 */
import type { Settings } from '../shared/settings.ts'
import { describeError, redact, truncate } from './log.ts'
import { createRunner, shortStderr } from './process.ts'
import { consumeSpec } from './targets.ts'
import type { CommandRunner, DwsTarget, ValidateResult } from './types.ts'

/** Authentication failures a dry-run may still report; a rejected plan is not valid. */
const AUTH_FAILURE = /(?:not\s+logged\s+in|未登录|请先登录|auth(?:entication)?\s+(?:required|expired)|unauthori[sz]ed)/i

export interface ValidateIo {
  readonly runner?: CommandRunner
  readonly timeoutMs?: number
}

/**
 * Validate one target without creating anything.
 *
 * A thrown `ChannelError` becomes `{ valid: false, error }`; the caller never has
 * to distinguish a bad target from an unreachable dws.
 */
export async function validateTarget(
  target: DwsTarget,
  settings: Settings,
  io: ValidateIo = {},
): Promise<ValidateResult> {
  let spec
  try {
    spec = consumeSpec(target, settings)
  } catch (error) {
    return { valid: false, error: describeError(error) }
  }

  const runner = io.runner ?? createRunner({ command: settings.dws.binaryPath })
  const args = [...spec.args, '--dry-run']
  let result
  try {
    result = await runner.run(args, { timeoutMs: io.timeoutMs ?? 15_000 })
  } catch (error) {
    return { valid: false, error: describeError(error) }
  }

  if (result.error) return { valid: false, error: truncate(redact(`dws could not start: ${result.error}`), 240) }
  if (result.timedOut) return { valid: false, error: 'dws --dry-run timed out' }
  const output = `${result.stderr}\n${result.stdout}`
  if (AUTH_FAILURE.test(output)) {
    return { valid: false, error: 'dws is not authorized; run `dws auth login` first' }
  }
  if (result.code !== 0) {
    const detail = shortStderr(result.stderr) || shortStderr(result.stdout) || 'no diagnostic output'
    return {
      valid: false,
      error: truncate(redact(`dws --dry-run exited ${result.code ?? 'null'}: ${detail}`), 240),
    }
  }
  return { valid: true }
}
