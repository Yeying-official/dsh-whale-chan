/**
 * `LlmModel`: the brain's `ModelPort` over DSH's LLM service directly.
 *
 * The replier used to be a DSH session, but a session carries whatever the
 * preset mounts — on a real host that measured 141k tokens of tool schemas,
 * which pushed model prefill past a minute before the first token. A reply
 * needs none of it: no tools, no workspace, no session log. This adapter calls
 * `ctx.llm.stream` with one system text and one user message, so the request is
 * exactly what the brain asked for.
 *
 * What it still honours:
 *
 * - **Routing** comes from `settings.models.reply` when both `provider` and
 *   `model` are set, otherwise from the host's default selection
 *   (`ctx.agentDefaultModel`). The route is validated through
 *   `ctx.llm.resolveCallConfig`, which fills the adapter defaults without
 *   creating anything.
 * - **Budget** is the caller's `AbortSignal`; the brain owns the deadline, so
 *   this adapter adds no timer of its own and never keeps a call alive.
 * - **Output** is the concatenated `text-delta` chunks, trimmed. Reasoning
 *   deltas are ignored: they are not a reply.
 *
 * It never registers a tool, never creates a workspace, never writes a session
 * and never touches the deployment default model.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ModelPort, ModelRequest } from '../brain/types.ts'
import type { ModelRoute } from '../shared/settings.ts'
import { ExecutorError, ModelAbortedError, ModelFailedError } from './errors.ts'
import { assemblePrompt } from './model.ts'
import { routeSelection, type RoleSelection } from './role-model.ts'
import type { ExecutorLogger } from './types.ts'

/**
 * Ceiling on one reply request's output tokens, whatever `maxChars` implies.
 */
export const MAX_OUTPUT_TOKENS = 4_096

/**
 * Floor on one reply request's output tokens.
 *
 * A reasoning model spends part of the budget thinking before it emits the
 * answer, so a small character hint (a classification asks for 800 characters,
 * a reply for 300) would be spent on reasoning alone: the JSON arrives
 * truncated or empty and the brain reports `classify:invalid` on a model that
 * answered correctly. One kilotoken leaves room for the reasoning plus the
 * answer, and the brain still bounds the visible text itself.
 */
export const MIN_OUTPUT_TOKENS = 1_024

/** Ratio between the brain's character hint and the token budget. */
export const CHARS_PER_TOKEN = 4

/** The host's default model selection, as the live `agentDefaultModel` service exposes it. */
export interface DefaultModelLike {
  currentSelection(): ModelSelection
}

/** The two `ctx.llm` members this adapter needs; replaced by tests. */
export interface LlmLike {
  resolveCallConfig(config: RoleSelection, signal?: AbortSignal): Promise<RoleSelection>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface LlmModelOptions {
  readonly llm: LlmLike
  /** Host default selection; consulted only when the settings route is empty. */
  readonly defaultModel?: DefaultModelLike | undefined
  /** Route from `settings.models.reply`. */
  readonly route?: ModelRoute
  readonly logger?: ExecutorLogger
}

/**
 * Read the host's default selection without declaring the service.
 *
 * `@deepseek-ai/dsh-agent-default-model` is not a dependency of this bundle, so
 * augmenting `Context` here would invent a contract the package cannot keep;
 * the host mounts the service in every deployment that has a model, and an
 * absent service is reported as "no route" rather than guessed.
 */
export function defaultModelOf(ctx: Context): DefaultModelLike | undefined {
  const service = (ctx as unknown as { agentDefaultModel?: DefaultModelLike }).agentDefaultModel
  return service === undefined ? undefined : service
}

/** Translate a resolved selection back into the LLM service's request shape. */
function asSelection(value: ModelSelection | RoleSelection): RoleSelection {
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(value.reasoningEffort) }),
  }
}

/**
 * Output-token budget implied by the brain's character hint.
 *
 * `maxChars / 4` is the *content* budget; reasoning comes on top of it, so the
 * result is floored at `MIN_OUTPUT_TOKENS` and capped at `MAX_OUTPUT_TOKENS`.
 */
export function outputTokensFor(maxChars: number | undefined): number | undefined {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) return undefined
  const budget = Math.floor(maxChars / CHARS_PER_TOKEN)
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, budget))
}

/** `ModelPort` over `ctx.llm.stream`: one system text plus one user message, no tools. */
export class LlmModel implements ModelPort {
  private readonly llm: LlmLike
  private readonly defaultModel: DefaultModelLike | undefined
  private readonly route: ModelRoute | undefined
  private readonly logger: ExecutorLogger | undefined
  private resolved: RoleSelection | undefined

  constructor(options: LlmModelOptions) {
    this.llm = options.llm
    this.defaultModel = options.defaultModel
    this.route = options.route
    this.logger = options.logger
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new ModelAbortedError('the model call was aborted before it started')
    const selection = await this.selection(signal)
    // The system text travels in its own field, so the user message is only the
    // conversation; the shared assembler still bounds it and marks truncation.
    const prompt = assemblePrompt('', request.messages)
    const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: prompt.text }] }]
    const maxTokens = outputTokensFor(request.maxChars)
    const options: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      system: request.system,
      messages,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      signal,
    }

    let text = ''
    try {
      for await (const chunk of this.llm.stream(options)) {
        // Reasoning deltas are the model thinking out loud, not a reply.
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch (error) {
      if (signal.aborted) throw new ModelAbortedError('the model call was aborted')
      throw new ModelFailedError(describe(error))
    }
    if (signal.aborted) throw new ModelAbortedError('the model call was aborted')
    return text.trim()
  }

  /** Resolve the route once: settings first, host default second. */
  private async selection(signal: AbortSignal): Promise<RoleSelection> {
    if (this.resolved !== undefined) return this.resolved
    const configured = routeSelection(this.route)
    const fallback = this.defaultModel?.currentSelection()
    const candidate = configured ?? (fallback === undefined ? undefined : asSelection(fallback))
    if (candidate === undefined) {
      throw new ExecutorError('modelUnavailable', 'settings.models.reply and the host default are both empty')
    }
    const resolved = await this.llm.resolveCallConfig(candidate, signal)
    this.resolved = asSelection(resolved)
    this.logger?.debug?.(`dsh-whale-chan: replies use ${this.resolved.provider}/${this.resolved.model}`)
    return this.resolved
  }
}

/** The reply port a composition root builds from the host context and settings. */
export function replyModelFor(ctx: Context, route: ModelRoute | undefined, logger?: ExecutorLogger): LlmModel {
  return new LlmModel({
    llm: {
      resolveCallConfig: async (config, signal) => await ctx.llm.resolveCallConfig(config, signal),
      stream: (options) => ctx.llm.stream(options),
    },
    defaultModel: defaultModelOf(ctx),
    ...(route === undefined ? {} : { route }),
    ...(logger === undefined ? {} : { logger }),
  })
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300)
  return String(error).slice(0, 300)
}
