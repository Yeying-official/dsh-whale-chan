/** Persona tab: registry-driven form on the left, local preview on the right. */
import { useEffect, useState } from 'react'
import { ApiError, call, useApi } from '../api.ts'
import { Alert, Button, Card, PageHeader, Skeleton } from '../controls.tsx'
import { asError, errorText } from '../errors.ts'
import {
  FormActions,
  RegistryField,
  fieldDomId,
  fieldsOf,
  getPath,
  issueFieldMap,
  setPath,
  validateBlock,
} from '../fields.tsx'
import { usePanel } from '../provider.tsx'

const BLOCK = 'persona' as const

export function PersonaPage() {
  const { t, refreshToken, notify } = usePanel()
  const personaApi = useApi((signal) => call('GET persona', { signal }), { deps: [refreshToken] })
  const [draft, setDraft] = useState<Record<string, unknown>>()
  const [revision, setRevision] = useState<number>()
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    if (dirty || !personaApi.data) return
    setDraft({ ...personaApi.data.persona })
    setRevision(personaApi.data.revision)
    setErrors({})
    setConflict(false)
  }, [personaApi.data]) // eslint-disable-line react-hooks/exhaustive-deps -- a dirty draft must survive server refreshes

  const update = (path: string, next: unknown) => {
    if (!draft) return
    const value = setPath(draft, path, next)
    setDraft(value)
    setDirty(true)
    if (errors[path]) {
      const rest = { ...errors }
      delete rest[path]
      setErrors(rest)
    }
  }

  const save = async () => {
    if (!draft || revision === undefined) return
    const nextErrors = validateBlock(BLOCK, draft, t)
    const name = getPath(draft, 'name')
    if (typeof name !== 'string' || name.trim().length === 0) nextErrors['name'] = t('persona.nameRequired')
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      const first = Object.keys(nextErrors)[0]
      if (first) document.getElementById(fieldDomId(BLOCK, first))?.focus()
      return
    }
    setSaving(true)
    setConflict(false)
    try {
      const result = await call('PUT settings/:block', {
        params: { block: BLOCK },
        body: { value: draft, revision },
      })
      const value = result.value
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        setDraft({ ...(value as Record<string, unknown>) })
      }
      setRevision(result.revision)
      setDirty(false)
      setErrors({})
      notify(t('persona.saved'))
      personaApi.reload()
    } catch (failure) {
      const error = asError(failure)
      if (error instanceof ApiError && error.conflict) {
        setRevision(error.actualRevision ?? revision)
        setConflict(true)
        personaApi.reload()
        notify(t('errors.conflict'), 'error')
      } else if (error instanceof ApiError && error.status === 400) {
        setErrors(issueFieldMap(BLOCK, error.issues))
        notify(errorText(error, t), 'error')
      } else {
        notify(errorText(error, t), 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  const reloadDraft = () => {
    if (personaApi.data) {
      setDraft({ ...personaApi.data.persona })
      setRevision(personaApi.data.revision)
      setErrors({})
      setConflict(false)
      setDirty(false)
    }
    personaApi.reload()
  }

  /**
   * Fill the draft from a frozen definition without saving.
   *
   * The host sends deep copies, and the spread keeps the draft a plain record;
   * the existing save action still owns the only write path.
   */
  const fillDraft = (value: Record<string, unknown> | undefined, message: string) => {
    if (!value) return
    setDraft({ ...structuredClone(value) })
    setDirty(true)
    setErrors({})
    notify(message)
  }

  // An older host omits both fields; either action is hidden rather than broken.
  const defaults = personaApi.data?.defaults as Record<string, unknown> | undefined
  const preset = personaApi.data?.presets?.[0]
  const presetPersona = preset?.persona as Record<string, unknown> | undefined

  const name = typeof draft?.['name'] === 'string' ? draft['name'] : ''
  const tone = typeof draft?.['tone'] === 'string' ? draft['tone'] : ''
  const signature = typeof draft?.['signature'] === 'string' ? draft['signature'] : ''
  const samples = Array.isArray(draft?.['samples'])
    ? draft['samples'].filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const allowEmoji = draft?.['allowEmoji'] !== false
  const maxChars = typeof draft?.['maxReplyChars'] === 'number' ? draft['maxReplyChars'] : 300
  const base = samples[0] ?? t('persona.preview.fallback')
  const composed = `${base}${allowEmoji ? ' 😊' : ''}${signature.trim().length > 0 ? `\n${signature}` : ''}`
  const overLimit = composed.length > maxChars
  const shown = overLimit ? `${composed.slice(0, Math.max(1, maxChars - 1))}…` : composed
  const loadError = personaApi.error

  return (
    <div className="wc-page">
      <PageHeader title={t('tabs.persona')} subtitle={t('persona.subtitle')} />
      {loadError ? (
        <Alert
          tone="error"
          role="alert"
          title={t('persona.loadError')}
          action={
            <Button size="sm" onClick={personaApi.reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(loadError, t)}
        </Alert>
      ) : null}
      {personaApi.loading && !draft ? <Skeleton label={t('common.loading')} rows={6} /> : null}
      {draft ? (
        <div className="wc-grid" data-columns="form">
          <Card
            title={t('persona.form.title')}
            actions={
              dirty ? (
                <span className="wc-badge" data-tone="warning">
                  {t('common.dirty')}
                </span>
              ) : null
            }
          >
            {conflict ? (
              <div style={{ marginBottom: 12 }}>
                <Alert
                  tone="warning"
                  role="alert"
                  action={
                    <Button size="sm" onClick={reloadDraft}>
                      {t('common.reload')}
                    </Button>
                  }
                >
                  {t('persona.conflict')}
                </Alert>
              </div>
            ) : null}
            <div className="wc-form-grid">
              {fieldsOf(BLOCK).map((spec) => (
                <RegistryField
                  key={spec.path}
                  spec={spec}
                  value={getPath(draft, spec.path)}
                  error={errors[spec.path]}
                  wide={['identity', 'knowledge', 'rules', 'samples'].includes(spec.path)}
                  disabled={saving}
                  onChange={(next) => update(spec.path, next)}
                />
              ))}
            </div>
            {defaults || (preset && presetPersona) ? (
              <div className="wc-persona-actions">
                {defaults ? (
                  <div className="wc-persona-action">
                    <Button
                      size="sm"
                      onClick={() => fillDraft(defaults, t('persona.restoreDefaultsFilled'))}
                      disabled={saving}
                    >
                      {t('persona.restoreDefaults')}
                    </Button>
                    <span className="wc-hint">{t('persona.restoreDefaultsHint')}</span>
                  </div>
                ) : null}
                {preset && presetPersona ? (
                  <div className="wc-persona-action">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => fillDraft(presetPersona, t('persona.loadPresetFilled', { name: preset.name }))}
                      disabled={saving}
                    >
                      {t('persona.loadPreset', { name: preset.name })}
                    </Button>
                    <span className="wc-hint">{t('persona.loadPresetHint')}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            <FormActions
              dirty={dirty}
              saving={saving}
              saveLabel={t('common.save')}
              savingLabel={t('common.saving')}
              resetLabel={t('common.reset')}
              dirtyLabel={t('persona.dirty')}
              onSave={() => void save()}
              onReset={reloadDraft}
              disabled={revision === undefined}
            />
          </Card>
          <div className="wc-grid-col">
            <Card title={t('persona.preview.title')} className="wc-preview">
              <div className="wc-preview-name">
                <span aria-hidden="true">🐋</span>
                <span>{name || t('panel.label')}</span>
                <span className="wc-badge" data-tone={allowEmoji ? 'info' : 'neutral'}>
                  {allowEmoji ? t('persona.preview.emojiOn') : t('persona.preview.emojiOff')}
                </span>
              </div>
              <p className="wc-hint">{t('persona.preview.sample', { name: name || t('panel.label') })}</p>
              <div className="wc-bubble">{shown}</div>
              <div className="wc-preview-meta">
                <span>{t('persona.preview.tone', { tone: tone || t('common.notAvailable') })}</span>
                <span>{t('persona.preview.chars', { count: composed.length, max: maxChars })}</span>
                <span>{allowEmoji ? t('persona.preview.emojiOn') : t('persona.preview.emojiOff')}</span>
                {signature.trim().length > 0 ? <span>{t('persona.preview.signature', { signature })}</span> : null}
              </div>
              {overLimit ? (
                <p className="wc-field-note" role="status">
                  {t('persona.preview.overLimit')}
                </p>
              ) : null}
              <p className="wc-hint" style={{ marginTop: 10 }}>
                {t('persona.preview.hint')}
              </p>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  )
}
