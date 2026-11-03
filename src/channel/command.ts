/**
 * Resolve the `dws` command for the current host.
 *
 * The DSH host process does not necessarily inherit the interactive shell's
 * environment: on Windows the npm global shim lives in `%APPDATA%\npm\dws.cmd`,
 * and `cross-spawn` cannot find a bare `dws` unless that directory is on the
 * inherited `PATH`. Resolving the shim to an absolute path here keeps every
 * spawn site (`probeAuth`, `send`, discovery, validation, supervisor) on the
 * same rule instead of repeating it.
 *
 * The rule is deliberately conservative: anything that is already a path, has a
 * known Windows executable extension, or does not run on Windows is returned
 * unchanged. When nothing is found the original command is returned so the
 * failure stays visible instead of being replaced by a guess.
 */
import { statSync } from 'node:fs'
import { win32 } from 'node:path'

/** Extensions tried for a bare command, in the documented order. */
export const WINDOWS_COMMAND_EXTENSIONS = ['.cmd', '.exe', '.bat', ''] as const

/** Known executable extensions; a command that already has one is not expanded. */
const KNOWN_EXTENSION = /\.(?:exe|cmd|bat|ps1)$/i

/** One resolution per command+environment; the mapping is stable for a process. */
const cache = new Map<string, string>()

/** Clear the resolution cache; tests and settings reloads use it for determinism. */
export function clearDwsCommandCache(): void {
  cache.clear()
}

function pathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? ''
}

function searchDirectories(env: NodeJS.ProcessEnv): string[] {
  const directories: string[] = []
  for (const entry of pathValue(env).split(';')) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (directory !== '') directories.push(directory)
  }
  const appData = (env.APPDATA ?? '').trim()
  if (appData !== '') directories.push(win32.join(appData, 'npm'))
  const programFiles = (env.ProgramFiles ?? '').trim()
  if (programFiles !== '') directories.push(win32.join(programFiles, 'nodejs'))
  const localAppData = (env.LOCALAPPDATA ?? '').trim()
  if (localAppData !== '') {
    const localNode = win32.join(localAppData, 'Programs', 'nodejs')
    // The per-user Node install is optional; only search it when it exists.
    if (isFile(localNode) || existsDirectory(localNode)) directories.push(localNode)
  }
  return [...new Set(directories)]
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function existsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function cacheKey(command: string, env: NodeJS.ProcessEnv): string {
  return [command, pathValue(env), env.APPDATA ?? '', env.ProgramFiles ?? '', env.LOCALAPPDATA ?? ''].join('\u0000')
}

/**
 * Resolve one command for `platform`.
 *
 * `platform` and `env` are injectable so tests can simulate a Windows host
 * without depending on the machine's real installation.
 */
export function resolveDwsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || command === '') return command
  if (command.includes('/') || command.includes('\\')) return command
  if (KNOWN_EXTENSION.test(command)) return command

  const key = cacheKey(command, env)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  for (const directory of searchDirectories(env)) {
    for (const extension of WINDOWS_COMMAND_EXTENSIONS) {
      const candidate = win32.join(directory, `${command}${extension}`)
      if (isFile(candidate)) {
        cache.set(key, candidate)
        return candidate
      }
    }
  }
  // Nothing found: keep the original command so the spawn error names the
  // configured value instead of a fabricated path.
  cache.set(key, command)
  return command
}
