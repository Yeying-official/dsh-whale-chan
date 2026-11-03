/**
 * Public surface of the executor layer.
 *
 * The app layer composes:
 *
 * - `DshTaskExecutor` with `DshSessionHost` to run approved tasks;
 * - `LlmModel` to serve the brain's `ModelPort` — a direct `ctx.llm.stream`
 *   call with no session, no tools and no workspace;
 * - `DshResearch` with `ctx.web` to serve the brain's `ResearchPort`.
 *
 * `SessionModel` is deliberately not re-exported: it is the session-based reply
 * path a session with a 141k-token tool schema made too slow, and it stays in
 * `model.ts` only as a reference for a future tool-using reply.
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
