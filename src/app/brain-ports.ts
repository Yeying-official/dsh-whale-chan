/**
 * Ports the runtime supplies to the reply effect handlers.
 *
 * The brain itself only knows `ModelPort`; a long-lived replier session is the
 * executor's concern. The factory shape lets the runtime rotate those sessions
 * (persona or model changes) without the handlers holding a dead object.
 */
import type { ModelPort } from '../brain/index.ts'
import type { ModelRoute } from '../shared/settings.ts'

export interface BrainModelFactory {
  /** One model port bound to a conversation; calls on one thread are serialized. */
  forThread(threadKey: string, title?: string): ModelPort
  /** Rebuild every cached replier session; used after a persona change. */
  reset(): Promise<void> | void
  /** Adopt the current `settings.models.reply` route for new sessions. */
  updateRoute(route: ModelRoute): Promise<void> | void
  dispose(): Promise<void> | void
}
