/**
 * Local typings for `cross-spawn` 7.0.6.
 *
 * The package intentionally ships no TypeScript declaration and the project may
 * not add a dependency just for types. `cross-spawn` handles the Windows
 * `.cmd`/`.exe` resolution that plain `child_process.spawn` misses, which is why
 * the channel uses it for the `dws` binary.
 */
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process'

  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess

  const crossSpawn: { spawn: typeof spawn }
  export default crossSpawn
}
