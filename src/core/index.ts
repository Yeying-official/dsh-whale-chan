/**
 * Public surface of the pure domain layer.
 *
 * Everything the app layer, the channel adapter and the executor need is
 * exported here. Nothing in `src/core` performs I/O or imports a Node
 * built-in; see `docs/007-architecture.md`.
 */
export * from './model.ts'
export * from './errors.ts'
export * from './ports.ts'
export * from './engine.ts'
