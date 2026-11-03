/**
 * Public surface of the executor layer.
 *
 * The app layer composes `DshTaskExecutor` with `DshSessionHost` to run
 * approved tasks. Tests replace the host with an in-memory fake, so nothing
 * here has to start a session to be verified.
 */
export * from './types.ts'
export * from './errors.ts'
export * from './session-host.ts'
export * from './task.ts'
