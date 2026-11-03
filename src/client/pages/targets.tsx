/** Targets tab: edit watched targets, discover new ones and validate them. */
import { useEffect, useState } from 'react'
import { ApiError, call, isRecord, useApi, useMutation } from '../api.ts'
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '../controls.tsx'
import { asError, errorText } from '../errors.ts'
import {
  EnumField,
  FieldRow,
  FormActions,
  RowsField,
  TextField,
  issueFieldMap,
  type TargetRowValue,
} from '../fields.tsx'
import { usePanel } from '../provider.tsx'
import type { Target, TargetCandidate, TargetValidation } from '../../shared/models.ts'
import type { TargetKind } from '../../shared/limits.ts'

function toRows(targets: readonly Target[]): TargetRowValue[] {
  return targets.map((target) => ({
    kind: target.kind,
    id: target.id,
    label: target.label,
    mentionOnly: target.mentionOnly,
    replyMode: target.replyMode,
    enabled: target.enabled,
  }))
}

function rowsFromValue(value: unknown): TargetRowValue[] {
  if (!isRecord(value) || !Array.isArray(value['rows'])) return []
  return value['rows'].flatMap((item): TargetRowValue[] => {
    if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['kind'] !== 'string') return []
    if (item['kind'] !== 'at-me' && item['kind'] !== 'group' && item['kind'] !== 'dm') return []
    return [
      {
        kind: item['kind'],
        id: item['id'],
        label: typeof item['label'] === 'string' ? item['label'] : '',
        mentionOnly: item['mentionOnly'] !== false,
        replyMode: item['replyMode'] === 'review' || item['replyMode'] === 'off' ? item['replyMode'] : 'auto',
        enabled: item['enabled'] !== false,
      },
    ]
  })
}

export function TargetsPage() {
  const { t, refreshToken, notify } = usePanel()
  const targetsApi = useApi((signal) => call('GET targets', { signal }), { deps: [refreshToken] })
  const settingsApi = useApi((signal) => call('GET settings', { signal }), { deps: [refreshToken] })
  const [rows, setRows] = useState<TargetRowValue[]>([])
  const [revision, setRevision] = useState<number>()
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  const [blockErrors, setBlockErrors] = useState<Record<string, string>>({})
  const [discoverKind, setDiscoverKind] = useState<TargetKind>('group')
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<readonly TargetCandidate[]>([])
  const [searched, setSearched] = useState(false)
  const [validation, setValidation] = useState<readonly TargetValidation[]>([])
  const discover = useMutation((kind: TargetKind) =>
    call('POST targets/discover', { body: { kind, ...(query.trim() ? { query: query.trim() } : {}) } }),
  )
  const validate = useMutation(() =>
    call('POST targets/validate', {
      body: {
        targets: rows.map((row) => ({
          kind: row.kind,
          id: row.id.trim(),
          ...(row.label.trim() ? { label: row.label.trim() } : {}),
        })),
      },
    }),
  )

  useEffect(() => {
    if (dirty || !targetsApi.data || !settingsApi.data) return
    setRows(toRows(targetsApi.data.targets))
    setRevision(settingsApi.data.blocks.targets.revision)
    setRowErrors({})
    setBlockErrors({})
  }, [targetsApi.data, settingsApi.data]) // eslint-disable-line react-hooks/exhaustive-deps -- a dirty draft must survive server refreshes

  const updateRows = (next: readonly TargetRowValue[]) => {
    setRows([...next])
    setDirty(true)
    setRowErrors({})
  }

  const save = async () => {
    if (revision === undefined) return
    const missing = rows.findIndex((row) => row.id.trim().length === 0)
    if (missing >= 0) {
      setRowErrors({ [missing]: t('targets.rowRequired') })
      document.getElementById(`wc-target-row-${missing}`)?.focus()
      return
    }
    setSaving(true)
    setConflict(false)
    setBlockErrors({})
    try {
      const result = await call('PUT settings/:block', {
        params: { block: 'targets' },
        body: {
          value: {
            rows: rows.map((row) => ({
              kind: row.kind,
              id: row.id.trim(),
              label: row.label.trim(),
              mentionOnly: row.mentionOnly,
              replyMode: row.replyMode,
              enabled: row.enabled,
            })),
          },
          revision,
        },
      })
      setRows(rowsFromValue(result.value))
      setRevision(result.revision)
      setDirty(false)
      notify(t('targets.saved'))
      targetsApi.reload()
      settingsApi.reload()
    } catch (failure) {
      const error = asError(failure)
      if (error instanceof ApiError && error.conflict) {
        setRevision(error.actualRevision ?? revision)
        setConflict(true)
        targetsApi.reload()
        settingsApi.reload()
        notify(t('errors.conflict'), 'error')
      } else if (error instanceof ApiError && error.status === 400) {
        const issues = issueFieldMap('targets', error.issues)
        const perRow: Record<number, string> = {}
        const rest: Record<string, string> = {}
        for (const [path, message] of Object.entries(issues)) {
          const match = /^rows\.(\d+)/.exec(path)
          if (match) perRow[Number(match[1])] = message
          else rest[path] = message
        }
        setRowErrors(perRow)
        setBlockErrors(rest)
        notify(errorText(error, t), 'error')
      } else {
        notify(errorText(error, t), 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  const resetDraft = () => {
    setDirty(false)
    setConflict(false)
    setRowErrors({})
    setBlockErrors({})
    targetsApi.reload()
    settingsApi.reload()
  }

  const search = async () => {
    setSearched(true)
    try {
      const result = await discover.run(discoverKind)
      setCandidates(result.candidates)
    } catch {
      setCandidates([])
    }
  }

  const addCandidate = (candidate: TargetCandidate) => {
    if (rows.some((row) => row.kind === candidate.kind && row.id === candidate.id)) {
      notify(t('targets.duplicate'), 'info')
      return
    }
    updateRows([
      ...rows,
      {
        kind: candidate.kind,
        id: candidate.id,
        label: candidate.label,
        mentionOnly: true,
        replyMode: 'auto',
        enabled: true,
      },
    ])
    notify(t('targets.added', { label: candidate.label || candidate.id }))
  }

  const runValidation = async () => {
    if (rows.length === 0) return
    const missing = rows.findIndex((row) => row.id.trim().length === 0)
    if (missing >= 0) {
      setRowErrors({ [missing]: t('targets.rowRequired') })
      return
    }
    try {
      const result = await validate.run()
      setValidation(result.results)
    } catch {
      setValidation([])
    }
  }

  const loadError = targetsApi.error ?? settingsApi.error
  const validCount = validation.filter((item) => item.valid).length
  const invalidCount = validation.length - validCount

  return (
    <div className="wc-page">
      <PageHeader title={t('tabs.targets')} subtitle={t('targets.subtitle')} />
      {loadError ? (
        <Alert
          tone="error"
          role="alert"
          title={t('targets.loadError')}
          action={
            <Button
              size="sm"
              onClick={() => {
                targetsApi.reload()
                settingsApi.reload()
              }}
            >
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(loadError, t)}
        </Alert>
      ) : null}
      <div className="wc-grid" data-columns="two">
        <div className="wc-grid-col">
          <Card
            title={t('targets.list.title')}
            actions={<Badge tone={dirty ? 'warning' : 'neutral'}>{rows.length}</Badge>}
          >
            {targetsApi.loading && !targetsApi.data ? <Skeleton label={t('common.loading')} rows={4} /> : null}
            {conflict ? (
              <div style={{ marginBottom: 12 }}>
                <Alert
                  tone="warning"
                  role="alert"
                  action={
                    <Button size="sm" onClick={resetDraft}>
                      {t('common.reload')}
                    </Button>
                  }
                >
                  {t('targets.conflict')}
                </Alert>
              </div>
            ) : null}
            {Object.entries(blockErrors).map(([path, message]) => (
              <p className="wc-field-error" role="alert" key={path}>
                {message}
              </p>
            ))}
            {!targetsApi.loading && targetsApi.data && rows.length === 0 ? (
              <EmptyState title={t('targets.empty')} />
            ) : null}
            <RowsField
              rows={rows}
              onChange={updateRows}
              disabled={saving || revision === undefined}
              rowErrors={rowErrors}
            />
            <FormActions
              dirty={dirty}
              saving={saving}
              saveLabel={t('targets.save')}
              savingLabel={t('common.saving')}
              resetLabel={t('common.reset')}
              dirtyLabel={t('targets.dirty')}
              onSave={() => void save()}
              onReset={resetDraft}
              disabled={revision === undefined}
            />
          </Card>
        </div>
        <div className="wc-grid-col">
          <Card
            title={t('targets.discover.title')}
            actions={
              <Button size="sm" onClick={() => void search()} disabled={discover.pending}>
                {discover.pending ? t('targets.discover.searching') : t('targets.discover.search')}
              </Button>
            }
          >
            <p className="wc-hint">{t('targets.discover.body')}</p>
            <div className="wc-toolbar" style={{ marginTop: 10 }}>
              <FieldRow label={t('targets.discover.kind')}>
                <EnumField
                  value={discoverKind}
                  options={['group', 'dm', 'at-me']}
                  optionLabel={(option) => t(`targets.kind.${option}` as 'targets.kind.group')}
                  onChange={(next) => setDiscoverKind(next as TargetKind)}
                />
              </FieldRow>
              <FieldRow label={t('targets.discover.query')}>
                <TextField value={query} placeholder={t('targets.discover.queryPlaceholder')} onChange={setQuery} />
              </FieldRow>
            </div>
            {discover.error ? (
              <div style={{ marginTop: 10 }}>
                <Alert tone="error" role="alert">
                  {errorText(discover.error, t)}
                </Alert>
              </div>
            ) : null}
            {searched && !discover.pending && candidates.length === 0 && !discover.error ? (
              <div style={{ marginTop: 10 }}>
                <EmptyState title={t('targets.discover.empty')} />
              </div>
            ) : null}
            {candidates.length > 0 ? (
              <ul className="wc-health-list" style={{ marginTop: 10 }}>
                {candidates.map((candidate) => (
                  <li key={`${candidate.kind}:${candidate.id}`} className="wc-health-row">
                    <div>
                      <span className="wc-health-name">{candidate.label || candidate.id}</span>
                      <span className="wc-health-detail-text">
                        {t(`targets.kind.${candidate.kind}` as 'targets.kind.group')} · {candidate.id}
                        {candidate.description ? ` · ${candidate.description}` : ''}
                      </span>
                    </div>
                    <Button size="sm" aria-label={t('targets.discover.add')} onClick={() => addCandidate(candidate)}>
                      {t('targets.discover.add')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
          <Card
            title={t('targets.validate')}
            actions={
              <Button size="sm" onClick={() => void runValidation()} disabled={validate.pending || rows.length === 0}>
                {validate.pending ? t('targets.validate.validating') : t('targets.validate')}
              </Button>
            }
          >
            {validate.error ? (
              <Alert tone="error" role="alert">
                {errorText(validate.error, t)}
              </Alert>
            ) : null}
            {validation.length > 0 ? (
              <Alert tone={invalidCount > 0 ? 'warning' : 'success'} role="status">
                <span>{t('targets.validate.summary', { valid: validCount, invalid: invalidCount })}</span>
                {validation.some((item) => !item.valid) ? (
                  <ul className="wc-health-list" style={{ marginTop: 8 }}>
                    {validation
                      .filter((item) => !item.valid)
                      .map((item, index) => (
                        <li key={`${item.target.kind}:${item.target.id}:${index}`} className="wc-health-detail-text">
                          {item.target.label || item.target.id} —{' '}
                          {t('targets.validate.invalid', { message: item.error ?? '' })}
                        </li>
                      ))}
                  </ul>
                ) : null}
              </Alert>
            ) : null}
            {validation.length === 0 && !validate.error ? (
              <p className="wc-hint">{t('targets.discover.body')}</p>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  )
}
