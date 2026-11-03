/** Settings tab: one registry-driven form per block with optimistic-concurrency saves. */
import { useEffect, useState } from 'react'
import { ApiError, call, useApi } from '../api.ts'
import { Alert, Button, Card, PageHeader, Skeleton } from '../controls.tsx'
import { asError, errorText } from '../errors.ts'
import {
  FormActions,
  RegistryField,
  blockValue,
  fieldDomId,
  fieldsOf,
  getPath,
  issueFieldMap,
  setPath,
  validateBlock,
} from '../fields.tsx'
import { usePanel } from '../provider.tsx'
import type { SettingsBlock } from '../../shared/settings.ts'

/**
 * Blocks with a registry form on this tab. `targets` and `persona` have their
 * own tabs, and listing the seven here keeps the zod-based settings schema out
 * of the browser bundle.
 */
const FORM_BLOCKS: readonly SettingsBlock[] = ['monitor', 'reply', 'research', 'tasks', 'models', 'dws', 'advanced']

const WIDE_FIELDS = new Set(['tasks.workspaceRoot', 'dws.binaryPath', 'dws.profile'])

interface DraftState {
  readonly value: Record<string, unknown>
  readonly revision: number
  readonly dirty: boolean
  readonly errors: Record<string, string>
  readonly conflict: boolean
}

function dangerNote(
  block: SettingsBlock,
  path: string,
  value: unknown,
  t: ReturnType<typeof usePanel>['t'],
): string | undefined {
  if (block === 'monitor' && path === 'paused') return t('settings.danger.paused')
  if (block === 'advanced' && path === 'dryRun') return t('settings.danger.dryRun')
  if (block === 'tasks' && path === 'permissionPreset' && value === 'danger-full-access')
    return t('settings.danger.permission')
  return undefined
}

export function SettingsPage() {
  const { t, refreshToken, notify } = usePanel()
  const settingsApi = useApi((signal) => call('GET settings', { signal }), { deps: [refreshToken] })
  const [active, setActive] = useState<SettingsBlock>('monitor')
  const [drafts, setDrafts] = useState<Partial<Record<SettingsBlock, DraftState>>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const data = settingsApi.data
    if (!data) return
    setDrafts((previous) => {
      let changed = false
      const next: Partial<Record<SettingsBlock, DraftState>> = { ...previous }
      for (const block of FORM_BLOCKS) {
        const server = data.blocks[block]
        const current = previous[block]
        if (!current || !current.dirty) {
          next[block] = {
            value: blockValue(block, server.value),
            revision: server.revision,
            dirty: false,
            errors: {},
            conflict: false,
          }
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [settingsApi.data])

  const draft = drafts[active]

  const update = (block: SettingsBlock, path: string, next: unknown) => {
    setDrafts((previous) => {
      const current = previous[block]
      if (!current) return previous
      const errors = { ...current.errors }
      delete errors[path]
      return {
        ...previous,
        [block]: { ...current, value: setPath(current.value, path, next), dirty: true, errors },
      }
    })
  }

  const save = async (block: SettingsBlock) => {
    const current = drafts[block]
    if (!current) return
    const errors = validateBlock(block, current.value, t)
    if (Object.keys(errors).length > 0) {
      setDrafts((previous) => ({ ...previous, [block]: { ...current, errors } }))
      const first = Object.keys(errors)[0]
      if (first) document.getElementById(fieldDomId(block, first))?.focus()
      return
    }
    setSaving(true)
    try {
      const result = await call('PUT settings/:block', {
        params: { block },
        body: { value: current.value, revision: current.revision },
      })
      setDrafts((previous) => ({
        ...previous,
        [block]: {
          value: blockValue(block, result.value),
          revision: result.revision,
          dirty: false,
          errors: {},
          conflict: false,
        },
      }))
      notify(t('settings.blockSaved', { block: t(`settings.block.${block}.label` as 'settings.block.monitor.label') }))
      settingsApi.reload()
    } catch (failure) {
      const error = asError(failure)
      if (error instanceof ApiError && error.conflict) {
        setDrafts((previous) => {
          const latest = previous[block]
          if (!latest) return previous
          return {
            ...previous,
            [block]: { ...latest, revision: error.actualRevision ?? latest.revision, conflict: true },
          }
        })
        settingsApi.reload()
        notify(t('errors.conflict'), 'error')
      } else if (error instanceof ApiError && error.status === 400) {
        setDrafts((previous) => {
          const latest = previous[block]
          if (!latest) return previous
          return { ...previous, [block]: { ...latest, errors: issueFieldMap(block, error.issues) } }
        })
        notify(errorText(error, t), 'error')
      } else {
        notify(errorText(error, t), 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  const reloadBlock = (block: SettingsBlock) => {
    setDrafts((previous) => {
      const latest = previous[block]
      if (!latest) return previous
      return { ...previous, [block]: { ...latest, dirty: false, errors: {}, conflict: false } }
    })
    settingsApi.reload()
  }

  const resetBlock = (block: SettingsBlock) => reloadBlock(block)

  return (
    <div className="wc-page">
      <PageHeader title={t('tabs.settings')} subtitle={t('settings.subtitle')} />
      {settingsApi.error ? (
        <Alert
          tone="error"
          role="alert"
          title={t('settings.loadError')}
          action={
            <Button size="sm" onClick={settingsApi.reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(settingsApi.error, t)}
        </Alert>
      ) : null}
      {settingsApi.loading && !settingsApi.data ? <Skeleton label={t('common.loading')} rows={6} /> : null}
      {settingsApi.data ? (
        <>
          <div className="wc-block-nav" role="group" aria-label={t('settings.blocks')}>
            {FORM_BLOCKS.map((block) => {
              const state = drafts[block]
              return (
                <button
                  key={block}
                  type="button"
                  className="wc-block-button"
                  aria-current={active === block}
                  aria-pressed={active === block}
                  onClick={() => setActive(block)}
                >
                  {t(`settings.block.${block}.label` as 'settings.block.monitor.label')}
                  {state?.dirty ? <span className="wc-dirty-dot" aria-label={t('common.dirty')} /> : null}
                </button>
              )
            })}
          </div>
          {draft ? (
            <Card
              title={t(`settings.block.${active}.label` as 'settings.block.monitor.label')}
              actions={
                draft.dirty ? (
                  <span className="wc-badge" data-tone="warning">
                    {t('common.dirty')}
                  </span>
                ) : null
              }
            >
              {draft.conflict ? (
                <div style={{ marginBottom: 12 }}>
                  <Alert
                    tone="warning"
                    role="alert"
                    action={
                      <Button size="sm" onClick={() => reloadBlock(active)}>
                        {t('common.reload')}
                      </Button>
                    }
                  >
                    {t('settings.conflict')}
                  </Alert>
                </div>
              ) : null}
              <div className="wc-form-grid">
                {fieldsOf(active).map((spec) => (
                  <RegistryField
                    key={spec.path}
                    spec={spec}
                    value={getPath(draft.value, spec.path)}
                    error={draft.errors[spec.path]}
                    note={dangerNote(active, spec.path, getPath(draft.value, spec.path), t)}
                    wide={WIDE_FIELDS.has(`${active}.${spec.path}`)}
                    disabled={saving}
                    onChange={(next) => update(active, spec.path, next)}
                  />
                ))}
              </div>
              <FormActions
                dirty={draft.dirty}
                saving={saving}
                saveLabel={t('settings.saveBlock')}
                savingLabel={t('common.saving')}
                resetLabel={t('common.reset')}
                dirtyLabel={t('settings.dirty')}
                onSave={() => void save(active)}
                onReset={() => resetBlock(active)}
              />
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
