import { describe, expect, it } from 'vitest'
import {
  LOOP_CONSECUTIVE_CAP,
  consecutiveCap,
  isEcho,
  isSelf,
  normalizeForEcho,
  stripQuotePrefix,
} from '../src/brain/loop-guard.ts'

describe('isSelf', () => {
  it('recognises the owner by user id and by nick', () => {
    expect(isSelf({ userId: 'owner-1', nick: '阿岚' }, { userId: 'owner-1' })).toBe(true)
    expect(isSelf({ userId: 'other', nick: '阿岚' }, { userId: 'owner-1', nicks: ['阿岚'] })).toBe(true)
    expect(isSelf({ userId: 'other', nick: ' 阿岚 ' }, { nicks: ['阿岚'] })).toBe(true)
  })

  it('does not treat a similar but different sender as the owner', () => {
    expect(isSelf({ userId: 'other', nick: '阿岚的同事' }, { userId: 'owner-1', nicks: ['阿岚'] })).toBe(false)
    expect(isSelf({}, {})).toBe(false)
    expect(isSelf({ userId: '', nick: '' }, { userId: 'owner-1', nicks: [] })).toBe(false)
  })
})

describe('normalization', () => {
  it('collapses whitespace and compatibility forms', () => {
    // NFKC turns full-width punctuation and letters into their ASCII forms, and a
    // re-wrapped message must compare equal to the original, so spaces go too.
    expect(normalizeForEcho('  你好，\n 世界  ')).toBe('你好,世界')
    expect(normalizeForEcho('ＡＢＣ')).toBe('abc')
  })

  it('drops quote markers but keeps the quoted body', () => {
    expect(stripQuotePrefix('> 你好呀\n\n我在呢')).toBe('你好呀\n\n我在呢')
    expect(stripQuotePrefix('引用：你好呀')).toBe('你好呀')
    expect(stripQuotePrefix('第一行\n> 第二行')).toBe('第一行\n第二行')
  })
})

describe('isEcho', () => {
  const outbound = ['会议改到十点了，记得看一下', '好的']

  it('recognises the exact text after whitespace normalization', () => {
    expect(isEcho('会议改到十点了，  记得看一下', outbound)).toBe(true)
  })

  it('recognises an echo that arrived as a quote', () => {
    expect(isEcho('> 好的\n\n收到', ['好的'])).toBe(true)
  })

  it('recognises a long outbound body inside a longer incoming message', () => {
    expect(isEcho('他说：会议改到十点了，记得看一下。你看呢？', outbound)).toBe(true)
  })

  it('does not match a short outbound body buried in other text', () => {
    expect(isEcho('好的，那就这样吧，明天见', ['好的'])).toBe(false)
  })

  it('ignores empty input and empty history', () => {
    expect(isEcho('   ', outbound)).toBe(false)
    expect(isEcho('随便说点什么', [])).toBe(false)
    expect(isEcho('随便说点什么', ['  '])).toBe(false)
  })
})

describe('consecutiveCap', () => {
  it('caps at three assistant messages in a row', () => {
    expect(LOOP_CONSECUTIVE_CAP).toBe(3)
    expect(consecutiveCap(2)).toBe(false)
    expect(consecutiveCap(3)).toBe(true)
    expect(consecutiveCap(4)).toBe(true)
    expect(consecutiveCap(0)).toBe(false)
  })

  it('accepts a custom cap and refuses a nonsense count', () => {
    expect(consecutiveCap(1, 1)).toBe(true)
    expect(consecutiveCap(Number.NaN)).toBe(false)
    expect(consecutiveCap(Number.POSITIVE_INFINITY)).toBe(true)
  })
})
