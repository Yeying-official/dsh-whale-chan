/**
 * Windows command resolution.
 *
 * The fixtures are temporary directories, so these tests never depend on the
 * host's real `dws` installation; every case injects both the environment and
 * the platform.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { probeAuth } from '../src/channel/auth.ts'
import { clearDwsCommandCache, resolveDwsCommand, WINDOWS_COMMAND_EXTENSIONS } from '../src/channel/command.ts'
import { createRunner } from '../src/channel/process.ts'
import { SettingsSchema } from '../src/shared/settings.ts'

const fakeDws = fileURLToPath(new URL('./fixtures/fake-dws.mjs', import.meta.url))
const win = process.platform === 'win32'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ws2-command-'))
}

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}

/** A minimal environment; the resolver only reads these keys on Windows. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: '',
    APPDATA: '',
    ProgramFiles: '',
    LOCALAPPDATA: '',
    ...overrides,
  }
}

beforeEach(() => {
  clearDwsCommandCache()
})

describe('resolveDwsCommand: passthrough', () => {
  it('returns the command unchanged on non-Windows platforms', () => {
    expect(resolveDwsCommand('dws', env({ PATH: 'C:\\tools' }), 'linux')).toBe('dws')
    expect(resolveDwsCommand('dws', env({ PATH: 'C:\\tools' }), 'darwin')).toBe('dws')
  })

  it('returns a command that already contains a path separator unchanged', () => {
    expect(resolveDwsCommand('C:\\tools\\dws', env(), 'win32')).toBe('C:\\tools\\dws')
    expect(resolveDwsCommand('.\\bin\\dws', env(), 'win32')).toBe('.\\bin\\dws')
    expect(resolveDwsCommand('C:/tools/dws', env(), 'win32')).toBe('C:/tools/dws')
  })

  it('does not append an extension to a command that already has one', () => {
    expect(resolveDwsCommand('dws.cmd', env(), 'win32')).toBe('dws.cmd')
    expect(resolveDwsCommand('dws.exe', env(), 'win32')).toBe('dws.exe')
    expect(resolveDwsCommand('dws.ps1', env(), 'win32')).toBe('dws.ps1')
  })
})

describe.runIf(win)('resolveDwsCommand: Windows search order', () => {
  it('finds the npm .cmd shim on PATH', () => {
    const directory = tempDir()
    const shim = join(directory, 'dws.cmd')
    touch(shim)
    expect(resolveDwsCommand('dws', env({ PATH: directory }), 'win32')).toBe(shim)
    expect(WINDOWS_COMMAND_EXTENSIONS).toEqual(['.cmd', '.exe', '.bat', ''])
  })

  it('falls back to %APPDATA%\\npm when PATH does not contain dws', () => {
    const appData = tempDir()
    const shim = join(appData, 'npm', 'dws.exe')
    touch(shim)
    expect(resolveDwsCommand('dws', env({ PATH: tempDir(), APPDATA: appData }), 'win32')).toBe(shim)
  })

  it('falls back to %ProgramFiles%\\nodejs and prefers .cmd over .exe', () => {
    const programFiles = tempDir()
    const nodeDirectory = join(programFiles, 'nodejs')
    touch(join(nodeDirectory, 'dws.exe'))
    touch(join(nodeDirectory, 'dws.cmd'))
    expect(resolveDwsCommand('dws', env({ ProgramFiles: programFiles }), 'win32')).toBe(join(nodeDirectory, 'dws.cmd'))
  })

  it('searches %LOCALAPPDATA%\\Programs\\nodejs only when that directory exists', () => {
    const localAppData = tempDir()
    const localNode = join(localAppData, 'Programs', 'nodejs')
    const shim = join(localNode, 'dws.bat')
    touch(shim)
    expect(resolveDwsCommand('dws', env({ LOCALAPPDATA: localAppData }), 'win32')).toBe(shim)
    // A different, empty LOCALAPPDATA must not resolve anything.
    expect(resolveDwsCommand('dws', env({ LOCALAPPDATA: tempDir() }), 'win32')).toBe('dws')
  })

  it('accepts the Path spelling of the environment variable', () => {
    const directory = tempDir()
    const shim = join(directory, 'dws.cmd')
    touch(shim)
    const windowsEnv: NodeJS.ProcessEnv = { Path: directory, APPDATA: '', ProgramFiles: '', LOCALAPPDATA: '' }
    expect(resolveDwsCommand('dws', windowsEnv, 'win32')).toBe(shim)
  })

  it('returns the original command when nothing is found', () => {
    expect(resolveDwsCommand('dws', env({ PATH: tempDir(), APPDATA: tempDir() }), 'win32')).toBe('dws')
  })

  it('resolves the shim used by probeAuth end to end', async () => {
    const directory = tempDir()
    const shim = join(directory, 'dws.cmd')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fakeDws}" %*\r\n`, 'utf8')
    const runner = createRunner({ command: 'dws', env: { ...process.env, PATH: directory } })
    const state = await probeAuth(SettingsSchema.parse({}), { runner })
    expect(state).toMatchObject({ available: true, authenticated: true, tokenValid: true })
    expect(state.version).toBe('1.0.66-fake')
  })
})
