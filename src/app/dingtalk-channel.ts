/**
 * The one adapter between `src/app` and the DingTalk facade.
 *
 * Nothing else in the app layer imports `src/channel`; this file keeps the
 * production wiring in one place, so the runtime composes a `ChannelRuntime`
 * without depending on channel internals. The wrapper only translates method
 * names and result shapes — it never decides whether a message may be sent.
 */
import { DingTalkChannel, type DingTalkChannelOptions } from '../channel/index.ts'
import type { Settings } from '../shared/settings.ts'
import type { ChannelAuthState, ChannelHealthState, ChannelRuntime, ChannelSendDetail } from './channel-runtime.ts'
import type { TargetKind } from '../shared/limits.ts'
import type { TargetCandidate, TargetDraft, TargetValidation } from '../shared/models.ts'

/** A `DingTalkChannel` viewed through the runtime's narrow port. */
export class DingTalkChannelRuntime implements ChannelRuntime {
  constructor(private readonly channel: DingTalkChannel) {}

  async start(sink: Parameters<ChannelRuntime['start']>[0]): Promise<ChannelHealthState> {
    return await this.channel.start(undefined, sink)
  }

  async stop(): Promise<void> {
    await this.channel.stop()
  }

  async sendWithReceipt(outbound: Parameters<ChannelRuntime['sendWithReceipt']>[0]): Promise<ChannelSendDetail> {
    return await this.channel.sendWithReceipt(outbound)
  }

  async probeAuth(): Promise<ChannelAuthState> {
    return await this.channel.probeAuth()
  }

  health(): ChannelHealthState {
    return this.channel.health()
  }

  ownerUserId(): string {
    return this.channel.ownerUserId()
  }

  async discover(kind: TargetKind, query?: string): Promise<readonly TargetCandidate[]> {
    // The at-me subscription is global; there is no conversation to discover.
    if (kind === 'at-me') return []
    if (kind === 'group') return await this.channel.discoverGroups(query ?? '')
    return await this.channel.discoverPeers(query)
  }

  async validate(target: TargetDraft): Promise<TargetValidation> {
    const result = await this.channel.validateTarget({
      kind: target.kind,
      id: target.id,
      ...(target.label === undefined ? {} : { label: target.label }),
      mentionOnly: true,
      enabled: true,
    })
    return result.valid
      ? { target, valid: true }
      : { target, valid: false, ...(result.error === undefined ? {} : { error: result.error }) }
  }
}

export interface RuntimeChannelOptions {
  readonly settings: () => Settings | Promise<Settings>
  readonly logger: DingTalkChannelOptions['logger']
  readonly ownerUserId?: string
  /** Display name used for `@<name>` mention detection in flattened group events. */
  readonly ownerNick?: string
  readonly command?: string
  readonly baseArgs?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

/** Build one production channel facade; the caller decides when to start it. */
export function createDingTalkChannel(options: RuntimeChannelOptions): DingTalkChannelRuntime {
  return new DingTalkChannelRuntime(
    new DingTalkChannel({
      settingsProvider: options.settings,
      logger: options.logger,
      ...(options.ownerUserId === undefined ? {} : { ownerUserId: options.ownerUserId }),
      ...(options.ownerNick === undefined ? {} : { ownerNick: options.ownerNick }),
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.baseArgs === undefined ? {} : { baseArgs: options.baseArgs }),
      ...(options.env === undefined ? {} : { env: options.env }),
    }),
  )
}
