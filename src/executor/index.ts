/**
 * Public surface of the executor layer.
 *
 * The app layer composes:
 *
 * - `DshTaskExecutor` with `DshSessionHost` to run approved tasks;
 * - `SessionModel` to serve the brain's `ModelPort` — one visible DSH session
 *   per conversation, with the replier preset and its tools, so the exchange is
 *   recorded in the session;
 * - `DshResearch` with `ctx.web` to serve the brain's `ResearchPort`.
 *
 * `LlmModel` remains exported as an experimental direct `ctx.llm.stream` path
 * (no session, no tools); the runtime does not wire it. The T3 timeout was a
 * TurnTracker issue (inbox append before `turn/start`), not the tool schema.
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
export * from './llm-model.ts'
export * from './research.ts'
export * from './role-model.ts'

export { SessionModel, type PreparedSession } from './model.ts'
