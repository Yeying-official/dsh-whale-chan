import { describe, expect, it } from 'vitest'
import { ChannelError } from '../src/channel/errors.ts'
import { describeError, redact, truncate } from '../src/channel/log.ts'

describe('redact', () => {
  it('masks credential-like key/value pairs in text, JSON and headers', () => {
    const text = redact('token=abc123 clientSecret="s3cr3t" Authorization: Bearer abc.def.ghi corpId=corp-9 userId=u-1')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('s3cr3t')
    expect(text).not.toContain('abc.def.ghi')
    expect(text).not.toContain('corp-9')
    expect(text).not.toContain('u-1')
    expect(text).toContain('[redacted]')
  })

  it('masks every URL query value', () => {
    const text = redact('see https://example.test/path?access_token=abc&foo=bar#frag')
    expect(text).toBe('see https://example.test/path?access_token=[redacted]&foo=[redacted]#frag')
  })

  it('keeps ordinary log text unchanged', () => {
    const text = 'channel: at-me subscription ready'
    expect(redact(text)).toBe(text)
    expect(redact('exit code=1 signal=null')).toBe('exit code=1 signal=null')
  })

  it('masks a sensitive key written with an equals sign', () => {
    expect(redact('idempotency_key=key-123')).not.toContain('key-123')
  })
})

describe('describeError', () => {
  it('prints the stable code for a channel error, redacted and single-line', () => {
    const line = describeError(new ChannelError('dws-failed', 'boom token=abc'))
    expect(line).toContain('code=dws-failed')
    expect(line).not.toContain('abc')
    expect(line).not.toContain('\n')
  })

  it('prints name, code and message for a Node error without a stack', () => {
    const error = Object.assign(new Error('first line\nsecond line'), { code: 'ENOENT' })
    const line = describeError(error)
    expect(line).toContain('name=Error')
    expect(line).toContain('code=ENOENT')
    expect(line).not.toContain('\n')
    expect(line).not.toContain('at ')
  })

  it('never includes a stack for an object value', () => {
    expect(describeError({ secret: 'x' })).toBe('value object')
  })

  it('truncates to the requested length', () => {
    expect(describeError(new Error('x'.repeat(400)), { maxLength: 40 })).toHaveLength(40)
  })
})

describe('truncate', () => {
  it('leaves short text and marks a cut', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('0123456789abcdef', 8)).toBe('0123456…')
  })
})
