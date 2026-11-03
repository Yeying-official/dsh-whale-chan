/**
 * Public surface of the reply brain.
 *
 * The app layer composes a brain call per message: classify, decide whether to
 * answer at all, optionally research, then draft. Every external dependency is a
 * port, so this package adds no network access and no host import.
 */
export * from './types.ts'
export * from './deadline.ts'
export * from './format.ts'
export * from './prompts.ts'
export * from './persona.ts'
export * from './classifier.ts'
export * from './reply.ts'
export * from './research.ts'
export * from './policy.ts'
export * from './rate-limit.ts'
export * from './loop-guard.ts'
