import { describe, expect, it } from 'vitest'
import { SettingsSchema, type Settings } from '../src/shared/settings.ts'
import { ChannelError } from '../src/channel/errors.ts'
import {
  consumeSpec,
  dedupeTargets,
  EVENT_KEYS,
  parsePeerAddress,
  resolveOwnerUserId,
  targetKey,
  targetsFromSettings,
} from '../src/channel/targets.ts'
import type { DwsTarget } from '../src/channel/types.ts'

function settings(overrides: Record<string, unknown> = {}): Settings {
  return SettingsSchema.parse(overrides)
}

const atMe: DwsTarget = { kind: 'at-me', id: 'at-me', mentionOnly: true, enabled: true }
const group: DwsTarget = { kind: 'group', id: 'cid-1', label: '测试群', mentionOnly: true, enabled: true }
const dm: DwsTarget = { kind: 'dm', id: 'u-peer', mentionOnly: true, enabled: true }

describe('event keys', () => {
  it('freezes exactly the three observed keys', () => {
    expect(EVENT_KEYS).toEqual({
      'at-me': 'user_im_message_receive_at',
      group: 'user_im_message_receive_group',
      dm: 'user_im_message_receive_o2o',
    })
  })
})

describe('consumeSpec', () => {
  it('builds the global at-me subscription with flatten, ndjson and ttl', () => {
    const spec = consumeSpec(atMe, settings({ dws: { eventTtlHours: 6 } }))
    expect(spec.eventKey).toBe('user_im_message_receive_at')
    expect(spec.args).toEqual([
      'event',
      'consume',
      'user_im_message_receive_at',
      '--flatten',
      '-f',
      'ndjson',
      '--ttl',
      '6h',
    ])
  })

  it('adds the explicit group id and the profile', () => {
    const spec = consumeSpec(group, settings({ dws: { profile: 'work' } }))
    expect(spec.args).toContain('--group')
    expect(spec.args[spec.args.indexOf('--group') + 1]).toBe('cid-1')
    expect(spec.args.slice(-2)).toEqual(['--profile', 'work'])
  })

  it('subscribes a one-to-one peer by user id', () => {
    const spec = consumeSpec(dm, settings())
    expect(spec.args).toContain('--user')
    expect(spec.args[spec.args.indexOf('--user') + 1]).toBe('u-peer')
  })

  it('uses the open id flag when the target id carries the open: prefix', () => {
    const spec = consumeSpec({ ...dm, id: 'open:od-1' }, settings())
    expect(spec.args).toContain('--open-dingtalk-id')
    expect(spec.args).not.toContain('--user')
    expect(spec.args[spec.args.indexOf('--open-dingtalk-id') + 1]).toBe('od-1')
  })

  it('refuses an empty target id with a typed error', () => {
    expect(() => consumeSpec({ ...group, id: '   ' }, settings())).toThrow(ChannelError)
    try {
      consumeSpec({ ...dm, id: 'open:' }, settings())
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-target' })
    }
  })
})

describe('peer addressing', () => {
  it('treats a bare id as a userId and the prefix as an open id', () => {
    expect(parsePeerAddress('u-1')).toEqual({ flag: '--user', value: 'u-1' })
    expect(parsePeerAddress('open:od-1')).toEqual({ flag: '--open-dingtalk-id', value: 'od-1' })
    expect(() => parsePeerAddress('')).toThrow(ChannelError)
  })
})

describe('target selection', () => {
  it('keeps only the first global at-me subscription', () => {
    const targets = dedupeTargets([
      atMe,
      { ...atMe, id: 'at-me-again' },
      group,
      { ...group },
      { ...dm, enabled: false },
    ])
    expect(targets.map((target) => target.id)).toEqual(['at-me', 'cid-1'])
  })

  it('targetKey is kind plus trimmed id', () => {
    expect(targetKey({ ...group, id: ' cid-1 ' })).toBe('group:cid-1')
  })

  it('maps persisted rows onto channel targets', () => {
    const parsed = targetsFromSettings(
      settings({
        targets: {
          rows: [
            { kind: 'at-me', id: 'at-me', label: '', mentionOnly: true, enabled: true },
            { kind: 'group', id: 'cid-9', label: '孵化中心', mentionOnly: false, enabled: true },
            { kind: 'dm', id: 'open:od-9', label: '张三', mentionOnly: true, enabled: false },
          ],
        },
      }),
    )
    expect(parsed).toHaveLength(2)
    expect(parsed[1]).toEqual({
      kind: 'group',
      id: 'cid-9',
      label: '孵化中心',
      mentionOnly: false,
      enabled: true,
    })
  })

  it('uses only the supplied owner id and never falls back to a target row', () => {
    expect(resolveOwnerUserId(' u-supplied ')).toBe('u-supplied')
    // There is no settings/row fallback: an empty value stays empty, so the
    // facade and the supervisor can fail closed instead of guessing.
    expect(resolveOwnerUserId()).toBe('')
    expect(resolveOwnerUserId('   ')).toBe('')
  })
})
