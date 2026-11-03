/**
 * The narrow channel surface the management API needs.
 *
 * WS5a does not start the DingTalk channel; it only lets the panel ask the
 * channel two one-shot questions. The port speaks the shared view vocabulary
 * so `src/app` never imports `src/channel`, and WS5b injects an adapter over
 * `DingTalkChannel` without changing the routes.
 */
import type { TargetKind } from '../shared/limits.ts'
import type { TargetCandidate, TargetDraft, TargetValidation } from '../shared/models.ts'

export interface ChannelPort {
  /** Discover conversations of one kind, optionally narrowed by a search query. */
  discover(kind: TargetKind, query?: string): Promise<readonly TargetCandidate[]>
  /** Validate one draft without subscribing to it. */
  validate(target: TargetDraft): Promise<TargetValidation>
}
