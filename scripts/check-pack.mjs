/**
 * Packaging gate for the WS0 bundle.
 *
 * Run after `pnpm build`. The command checks the manifest contract, the icon,
 * the files whitelist, and the exact artifact list produced by
 * `npm pack --dry-run --json`.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

const problems = []
const check = (condition, message) => {
  if (!condition) problems.push(message)
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
check(manifest.name === 'dsh-whale-chan-assistant', 'package name must be dsh-whale-chan-assistant')
check(manifest.version === '0.3.0', 'package version must be 0.3.0')
check(manifest.private === true, 'package must stay private')
check(manifest.type === 'module', 'package type must be module')
check(manifest.main === 'lib/index.js', 'main must be lib/index.js')
check(manifest.types === 'lib/index.d.ts', 'types must be lib/index.d.ts')
check(manifest.icon === 'assets/icon.svg', 'icon must be assets/icon.svg')
check(manifest.exports?.['.']?.default === './lib/index.js', 'exports["."].default must be ./lib/index.js')
check(manifest.exports?.['./client'] === './lib/client.js', 'exports["./client"] must be ./lib/client.js')
check(manifest.exports?.['./package.json'] === './package.json', 'package.json export is missing')
check(manifest.exports?.['./locale/*.json'] === './locale/*.json', 'locale export is missing')
check(manifest.engines?.dsh === '^0.2.1-rc.5', 'engines.dsh must be ^0.2.1-rc.5')
check(manifest.engines?.node === '^22.19.0 || >=24.0.0', 'engines.node must match the supported Node range')
check(manifest.dsh?.manifestVersion === 1, 'dsh.manifestVersion must be 1')
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch is missing')
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')
check(
  manifest.dsh?.compatibility?.dshReleases?.['0.2.1-rc.5'] === 'compatible',
  'dsh.compatibility must mark 0.2.1-rc.5 compatible',
)
check(Array.isArray(manifest.dsh?.client?.inject), 'dsh.client.inject must be an array')
for (const packageName of [
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
]) {
  check(manifest.dsh?.client?.inject?.includes(packageName), `dsh.client.inject is missing ${packageName}`)
}

const expectedFiles = ['lib', 'assets', 'prompts', 'locale/*.json', 'cordis.patch.yml', 'README.md', 'LICENSE']
for (const entry of expectedFiles) check(manifest.files?.includes(entry), `files whitelist is missing ${entry}`)
check(!manifest.files?.includes('src'), 'files whitelist must not publish src')

check(existsSync('cordis.patch.yml'), 'cordis.patch.yml is missing')
if (existsSync('cordis.patch.yml')) {
  const patch = readFileSync('cordis.patch.yml', 'utf8')
  check(/name:\s*dsh-whale-chan-assistant/.test(patch), 'cordis.patch.yml does not insert the host entry')
}

check(existsSync('assets/icon.svg'), 'assets/icon.svg is missing')
if (existsSync('assets/icon.svg')) {
  const icon = readFileSync('assets/icon.svg', 'utf8')
  check(statSync('assets/icon.svg').size <= 256 * 1024, 'icon exceeds 256 KiB')
  check(/viewBox="0 0 24 24"/.test(icon), 'icon must use viewBox 0 0 24 24')
  check(icon.includes('currentColor'), 'icon must use currentColor')
}

check(existsSync('lib/index.js'), 'lib/index.js is missing; run pnpm build first')
check(existsSync('lib/client.js'), 'lib/client.js is missing; run pnpm build first')
if (existsSync('lib/client.js')) {
  const client = readFileSync('lib/client.js', 'utf8')
  check(/window\.__ModuleLoader__\.load\s*\(/.test(client), 'client bundle has no ModuleLoader banner')
  check(/id:\s*"dsh-whale-chan-assistant"/.test(client), 'client bundle id must equal the package name')
  check(/return module\.exports;/.test(client), 'client bundle has no module.exports footer')
}

if (existsSync('lib/index.js')) {
  const host = readFileSync('lib/index.js', 'utf8')
  check(host.includes('dsh-whale-chan-assistant'), 'host bundle does not carry the plugin name')
}

let packed
try {
  const output = execSync('npm pack --dry-run --json --ignore-scripts', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const parsed = JSON.parse(output)
  packed = Array.isArray(parsed) ? parsed[0] : parsed
} catch (error) {
  problems.push(`npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`)
}

if (packed) {
  const paths = new Set((packed.files ?? []).map((file) => file.path))
  for (const required of [
    'lib/index.js',
    'lib/client.js',
    'assets/icon.svg',
    'locale/zh.json',
    'locale/en.json',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
  ]) {
    check(paths.has(required), `npm pack artifact is missing ${required}`)
  }
  for (const path of paths) {
    if (path.startsWith('src/') || path.startsWith('tests/') || path.startsWith('node_modules/')) {
      problems.push(`npm pack artifact unexpectedly contains ${path}`)
    }
  }
  if (existsSync('prompts')) {
    const hasPromptFiles = readdirSync('prompts', { recursive: true, withFileTypes: true }).some((entry) =>
      entry.isFile(),
    )
    if (hasPromptFiles) {
      check(
        [...paths].some((path) => path.startsWith('prompts/')),
        'npm pack artifact is missing prompts/',
      )
    }
  }
  check(packed.name === manifest.name, 'npm pack name does not match the manifest')
  check(packed.version === manifest.version, 'npm pack version does not match the manifest')
}

if (problems.length > 0) {
  console.error('pack check failed:')
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}

console.log(
  `pack check passed: ${packed?.files?.length ?? 0} artifacts, icon ${statSync('assets/icon.svg').size} bytes`,
)
