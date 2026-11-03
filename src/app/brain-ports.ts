/**
 * Ports the runtime supplies to the reply effect handlers.
 *
 * The brain itself only knows `ModelPort`. Replies now use `LlmModel`, a direct
 * `ctx.llm.stream` call with no session, tools or workspace; the factory shape
 * survives because the pipeline asks for one port per thread and the route can
 * change at runtime. `reset()` is a compatibility no-op for a stateless model.
 */
import type { ModelPort } from '../brain/index.ts'
import type { ModelRoute } from '../shared/settings.ts'

export interface BrainModelFactory {
  /** One model port for a conversation; a direct LLM model has no per-thread state. */
  forThread(threadKey: string, title?: string): ModelPort
  /** Compatibility hook; stateless models do nothing. */
  reset(): Promise<void> | void
  /** Adopt the current `settings.models.reply` route; rebuilds the direct model. */
  updateRoute(route: ModelRoute): Promise<void> | void
  /** Release resources; the LLM stream is owned by the caller's signal. */
  dispose(): Promise<void> | void
}
