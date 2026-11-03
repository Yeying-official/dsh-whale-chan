/**
 * Public surface of the executor layer.
 *
 * The app layer composes:
 *
 * - `DshTaskExecutor` with `DshSessionHost` to run approved tasks;
 * - `SessionModel` with the same host to serve the brain's `ModelPort`;
 * - `DshResearch` with `ctx.web` to serve the brain's `ResearchPort`.
 *
 * `initializeRoleModel`/`seedRoleModel` are part of the host implementation, not
 * something the app layer calls: the host seeds `settings.models.*` while it
 * creates a session.
 *
 * Tests replace the host with an in-memory fake, so nothing here has to start a
 * session to be verified.
 */
export * from './types.ts'
export * from './errors.ts'
export * from './session-host.ts'
export * from './task.ts'
export * from './model.ts'
export * from './research.ts'
export * from './role-model.ts'
