/**
 * Client-only literals. Panel ids are duplicated from the shared product
 * constants intentionally: the browser half must not import host-side values.
 * `tests/contract.spec.ts` keeps this value equal to `shared/limits.ts`.
 */
export const PANEL_ID = 'whale-chan' as const
