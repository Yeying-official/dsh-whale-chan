// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { zh } from '../src/client/locale.ts'
import { WHALE_MAID_PERSONA } from '../src/shared/persona-defaults.ts'
import {
  failure,
  pathOf,
  personaFixture,
  reply,
  renderPanel,
  requestBodies,
  resetPanelTest,
} from './client-harness.tsx'
import type { Reply } from './client-harness.tsx'

afterEach(resetPanelTest)

function renderPersona(handler: Parameters<typeof renderPanel>[0]) {
  window.location.hash = '#persona'
  return renderPanel(handler)
}

function personaHandler(
  options: { readonly put?: (body: { value: Record<string, unknown>; revision: number }) => Reply } = {},
) {
  let revision = 3
  return (request: { url: URL; method: string; body: unknown }) => {
    const path = pathOf(request.url)
    if (path === 'persona' && request.method === 'GET') return reply(200, personaFixture({}, revision))
    if (path === 'settings/persona' && request.method === 'PUT') {
      const body = request.body as { value: Record<string, unknown>; revision: number }
      if (options.put) {
        const result = options.put(body)
        if (result.body && typeof result.body === 'object' && 'revision' in result.body) {
          revision = Number((result.body as { revision: number }).revision)
        }
        return result
      }
      revision = body.revision + 1
      return reply(200, { block: 'persona', value: body.value, revision })
    }
    return undefined
  }
}

describe('persona page', () => {
  it('renders the registry fields and updates the preview locally', async () => {
    const user = userEvent.setup()
    renderPersona(personaHandler())
    const name = await screen.findByLabelText(zh['settings.persona.name.label'])
    await user.clear(name)
    await user.type(name, '小鲸')
    expect(screen.getByText(zh['persona.preview.sample'].replace('{name}', '小鲸'))).toBeTruthy()
    expect(screen.queryByText(zh['persona.preview.hint'])).toBeTruthy()
  })

  it('updates the tone and character count in the preview', async () => {
    const user = userEvent.setup()
    renderPersona(personaHandler())
    const tone = await screen.findByLabelText(zh['settings.persona.tone.label'])
    await user.clear(tone)
    await user.type(tone, '简洁专业')
    const preview = screen.getByRole('heading', { name: zh['persona.preview.title'] }).closest('section')
    if (!preview) throw new Error('missing preview')
    expect(within(preview).getByText(zh['persona.preview.tone'].replace('{tone}', '简洁专业'))).toBeTruthy()
    expect(within(preview).getByText(/\d+\/300/)).toBeTruthy()
  })

  it('saves the persona with its revision', async () => {
    const user = userEvent.setup()
    const view = renderPersona(personaHandler())
    const name = await screen.findByLabelText(zh['settings.persona.name.label'])
    await user.clear(name)
    await user.type(name, '鲸鱼酱二号')
    await user.click(screen.getByRole('button', { name: zh['common.save'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/persona')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/persona')[0] as {
      value: Record<string, unknown>
      revision: number
    }
    expect(body.revision).toBe(3)
    expect(body.value['name']).toBe('鲸鱼酱二号')
    expect(await screen.findByText(zh['persona.saved'])).toBeTruthy()
  })

  it('rejects a blank name before calling the host', async () => {
    const user = userEvent.setup()
    const view = renderPersona(personaHandler())
    const name = await screen.findByLabelText(zh['settings.persona.name.label'])
    await user.clear(name)
    await user.click(screen.getByRole('button', { name: zh['common.save'] }))
    expect(await screen.findByText(zh['persona.nameRequired'])).toBeTruthy()
    expect(requestBodies(view.fetchMock, 'PUT', 'settings/persona')).toHaveLength(0)
  })

  it('warns when the preview exceeds the reply limit', async () => {
    const user = userEvent.setup()
    renderPersona(personaHandler())
    const max = await screen.findByLabelText(zh['settings.persona.maxReplyChars.label'])
    await user.clear(max)
    await user.type(max, '1')
    expect(await screen.findByText(zh['persona.preview.overLimit'])).toBeTruthy()
  })

  it('recovers from a persona revision conflict', async () => {
    const user = userEvent.setup()
    let writes = 0
    const view = renderPersona(
      personaHandler({
        put: (body) => {
          writes += 1
          if (writes === 1) return failure(409, 'settings_conflict', { actualRevision: 9 })
          return reply(200, { block: 'persona', value: body.value, revision: body.revision + 1 })
        },
      }),
    )
    const name = await screen.findByLabelText(zh['settings.persona.name.label'])
    await user.clear(name)
    await user.type(name, '小鲸')
    await user.click(screen.getByRole('button', { name: zh['common.save'] }))
    expect(await screen.findByText(zh['persona.conflict'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['common.save'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/persona')).toHaveLength(2))
    expect((requestBodies(view.fetchMock, 'PUT', 'settings/persona')[1] as { revision: number }).revision).toBe(9)
  })

  it('shows the load error with a retry', async () => {
    const user = userEvent.setup()
    let failed = false
    renderPersona((request) => {
      if (pathOf(request.url) !== 'persona') return undefined
      if (!failed) {
        failed = true
        return failure(500, 'internal_error')
      }
      return reply(200, personaFixture())
    })
    expect(await screen.findByText(zh['persona.loadError'])).toBeTruthy()
    await user.click(screen.getByRole('button', { name: zh['common.retry'] }))
    expect(await screen.findByLabelText(zh['settings.persona.name.label'])).toBeTruthy()
  })

  it('renders the empty default persona on a fresh installation', async () => {
    renderPersona(personaHandler())
    const name = (await screen.findByLabelText(zh['settings.persona.name.label'])) as HTMLInputElement
    expect(name.value).toBe('鲸鱼酱')
    expect((screen.getByLabelText(zh['settings.persona.identity.label']) as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByLabelText(zh['settings.persona.tone.label']) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(zh['settings.persona.language.label']) as HTMLSelectElement).value).toBe('auto')
    expect((screen.getByLabelText(zh['settings.persona.maxReplyChars.label']) as HTMLInputElement).value).toBe('300')
    // The whale maid is a template, never the initial value.
    expect((screen.getByLabelText(zh['settings.persona.identity.label']) as HTMLTextAreaElement).value).not.toBe(
      WHALE_MAID_PERSONA.identity,
    )
  })

  it('restores the empty default persona into the draft without saving', async () => {
    const user = userEvent.setup()
    const view = renderPersona(personaHandler())
    const name = (await screen.findByLabelText(zh['settings.persona.name.label'])) as HTMLInputElement
    await user.clear(name)
    await user.type(name, '小鲸')
    await user.click(screen.getByRole('button', { name: zh['persona.restoreDefaults'] }))
    expect(await screen.findByText(zh['persona.restoreDefaultsFilled'])).toBeTruthy()
    expect((screen.getByLabelText(zh['settings.persona.name.label']) as HTMLInputElement).value).toBe('鲸鱼酱')
    expect((screen.getByLabelText(zh['settings.persona.identity.label']) as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByLabelText(zh['settings.persona.tone.label']) as HTMLInputElement).value).toBe('')
    expect(screen.getByText(zh['persona.dirty'])).toBeTruthy()
    expect(requestBodies(view.fetchMock, 'PUT', 'settings/persona')).toHaveLength(0)
  })

  it('loads the whale maid preset into the draft and saves it only on demand', async () => {
    const user = userEvent.setup()
    const view = renderPersona(personaHandler())
    await screen.findByLabelText(zh['settings.persona.name.label'])
    await user.click(screen.getByRole('button', { name: zh['persona.loadPreset'].replace('{name}', '蓝白鲸鱼女仆') }))
    expect(await screen.findByText(zh['persona.loadPresetFilled'].replace('{name}', '蓝白鲸鱼女仆'))).toBeTruthy()
    expect((screen.getByLabelText(zh['settings.persona.identity.label']) as HTMLTextAreaElement).value).toBe(
      WHALE_MAID_PERSONA.identity,
    )
    expect((screen.getByLabelText(zh['settings.persona.tone.label']) as HTMLInputElement).value).toBe(
      WHALE_MAID_PERSONA.tone,
    )
    expect((screen.getByLabelText(zh['settings.persona.language.label']) as HTMLSelectElement).value).toBe('zh-CN')
    expect((screen.getByLabelText(zh['settings.persona.signature.label']) as HTMLInputElement).value).toBe(
      WHALE_MAID_PERSONA.signature,
    )
    expect((screen.getByLabelText(zh['settings.persona.knowledge.label']) as HTMLTextAreaElement).value).toBe(
      WHALE_MAID_PERSONA.knowledge,
    )
    const rules = screen.getByRole('group', { name: zh['settings.persona.rules.label'] })
    const samples = screen.getByRole('group', { name: zh['settings.persona.samples.label'] })
    const firstRule = within(rules).getByLabelText(zh['settings.list.item'].replace('{index}', '1')) as HTMLInputElement
    const firstSample = within(samples).getByLabelText(
      zh['settings.list.item'].replace('{index}', '1'),
    ) as HTMLInputElement
    expect(firstRule.value).toBe(WHALE_MAID_PERSONA.rules[0])
    expect(firstSample.value).toBe(WHALE_MAID_PERSONA.samples[0])
    expect(screen.getByText(zh['persona.dirty'])).toBeTruthy()
    expect(requestBodies(view.fetchMock, 'PUT', 'settings/persona')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: zh['common.save'] }))
    await waitFor(() => expect(requestBodies(view.fetchMock, 'PUT', 'settings/persona')).toHaveLength(1))
    const body = requestBodies(view.fetchMock, 'PUT', 'settings/persona')[0] as {
      value: Record<string, unknown>
      revision: number
    }
    expect(body.revision).toBe(3)
    expect(body.value['identity']).toBe(WHALE_MAID_PERSONA.identity)
    expect(body.value['tone']).toBe(WHALE_MAID_PERSONA.tone)
    expect(body.value['language']).toBe('zh-CN')
    expect(body.value['signature']).toBe(WHALE_MAID_PERSONA.signature)
    expect(body.value['rules']).toEqual(WHALE_MAID_PERSONA.rules)
    expect(body.value['samples']).toEqual(WHALE_MAID_PERSONA.samples)
    expect(await screen.findByText(zh['persona.saved'])).toBeTruthy()
  })

  it('keeps a saved custom persona instead of applying a template', async () => {
    renderPersona((request) => {
      if (pathOf(request.url) !== 'persona') return undefined
      return reply(200, personaFixture({ name: '小鲸', identity: '自定义身份', tone: '简洁专业' }))
    })
    const name = (await screen.findByLabelText(zh['settings.persona.name.label'])) as HTMLInputElement
    expect(name.value).toBe('小鲸')
    expect((screen.getByLabelText(zh['settings.persona.identity.label']) as HTMLTextAreaElement).value).toBe(
      '自定义身份',
    )
    expect((screen.getByLabelText(zh['settings.persona.tone.label']) as HTMLInputElement).value).toBe('简洁专业')
    // Both actions exist, but neither applies itself to a saved persona.
    expect(screen.getByRole('button', { name: zh['persona.restoreDefaults'] })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: zh['persona.loadPreset'].replace('{name}', '蓝白鲸鱼女仆') }),
    ).toBeTruthy()
  })

  it('hides the default and preset actions on a host that does not send them', async () => {
    renderPersona((request) => {
      if (pathOf(request.url) !== 'persona') return undefined
      return reply(200, personaFixture({}, 3, { legacyHost: true }))
    })
    expect(await screen.findByLabelText(zh['settings.persona.name.label'])).toBeTruthy()
    expect(screen.queryByText(zh['persona.restoreDefaults'])).toBeNull()
    expect(screen.queryByText(zh['persona.loadPresetHint'])).toBeNull()
  })
})
