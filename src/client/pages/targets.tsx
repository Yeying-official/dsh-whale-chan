/** Targets tab: edit watched targets, discover new ones and validate them. */
import { useEffect, useState } from 'react'
import { ApiError, archiveTargetSessions, call, isRecord, useApi, useMutation } from '../api.ts'
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Skeleton, Switch } from '../controls.tsx'
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
import type { T } from '../locale.ts'
import type {
  ArchiveTargetSessionsRequest,
  ArchiveTargetSessionsResult,
  ArchivedSessionActivity,
  Target,
  TargetCandidate,
  TargetValidation,
  TargetWorkspace,
} from '../../shared/models.ts'
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

/**
 * Localized copy for an archive failure.
 *
 * The route documents a refusal for a target without one workspace, an unknown
 * target and an unavailable runtime; every other failure keeps the shared
 * `errorText` mapping (offline, conflict, invalid body, server error).
 */
function archiveErrorText(error: Error, t: T): string {
  if (error instanceof ApiError) {
    if (error.code === 'per_conversation_workspace') return t('errors.archivePerConversation')
    if (error.code === 'unknown_target') return t('errors.archiveUnknownTarget')
    if (error.code === 'state_unavailable') return t('errors.archiveUnavailable')
  }
  return errorText(error, t)
}

/** Render one refused session's activity families; `kind` is data, never translated. */
function activityText(activity: ArchivedSessionActivity): string {
  if (activity.items === undefined || activity.items.length === 0) return activity.kind
  const items = activity.items.map((item) => (item.label ? `${item.label} (${item.id})` : item.id)).join(', ')
  return `${activity.kind}: ${items}`
}

/**
 * The outcome of one archive pass, kept inside the still-open dialog so the
 * owner can read it before closing. Counts partition the candidate set; the
 * `truncated` note names how many candidates the enumeration found and how many
 * of them this bounded pass actually handled.
 */
function ArchiveResult({ result, t }: { result: ArchiveTargetSessionsResult; t: T }) {
  const processed =
    result.archived.length +
    result.alreadyArchived.length +
    result.refused.length +
    result.missing.length +
    result.failed.length
  return (
    <div role="status" aria-live="polite">
      <h3 style={{ marginTop: 0 }}>{t('targets.archive.resultTitle')}</h3>
      <p className="wc-mono" style={{ marginTop: 0 }}>
        {result.workspace.path}
      </p>
      <ul className="wc-health-list">
        <li className="wc-health-row">
          <span className="wc-health-name">{t('targets.archive.archived', { count: result.archived.length })}</span>
        </li>
        <li className="wc-health-row">
          <span className="wc-health-name">
            {t('targets.archive.alreadyArchived', { count: result.alreadyArchived.length })}
          </span>
        </li>
        <li className="wc-health-row">
          <span className="wc-health-name">{t('targets.archive.refused', { count: result.refused.length })}</span>
        </li>
        <li className="wc-health-row">
          <span className="wc-health-name">{t('targets.archive.missing', { count: result.missing.length })}</span>
        </li>
        <li className="wc-health-row">
          <span className="wc-health-name">{t('targets.archive.failed', { count: result.failed.length })}</span>
        </li>
      </ul>
      {result.refused.length > 0 ? (
        <ul className="wc-health-list" style={{ marginTop: 8 }}>
          {result.refused.map((session) => (
            <li key={session.sessionId} className="wc-health-row">
              <div>
                <span className="wc-mono">{session.sessionId}</span>
                <span className="wc-health-detail-text">{session.activity.map(activityText).join(' · ')}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {result.failed.length > 0 ? (
        <ul className="wc-health-list" style={{ marginTop: 8 }}>
          {result.failed.map((session) => (
            <li key={session.sessionId} className="wc-health-row">
              <div>
                <span className="wc-mono">{session.sessionId}</span>
                <span className="wc-health-detail-text">{session.error}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {result.truncated ? (
        <div style={{ marginTop: 10 }}>
          <Alert tone="warning" role="status">
            {t('targets.archive.truncated', { count: result.candidateCount, processed })}
          </Alert>
        </div>
      ) : null}
      <p className="wc-muted" style={{ marginTop: 10 }}>
        {result.replySessionRotated ? t('targets.archive.rotated') : t('targets.archive.notRotated')}
      </p>
    </div>
  )
}

export function TargetsPage() {
  const { t, refreshToken, notify } = usePanel()
  const targetsApi = useApi((signal) => call('GET targets', { signal }), { deps: [refreshToken] })
  const settingsApi = useApi((signal) => call('GET settings', { signal }), { deps: [refreshToken] })
  const channelApi = useApi((signal) => call('GET channel', { signal }), { deps: [refreshToken] })
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
  const [copiedWorkspace, setCopiedWorkspace] = useState<string>()
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
  // Archiving is explicit and modal-scoped: no request is sent until the owner
  // confirms, and the result stays in the dialog until they close it.
  const [archiveTarget, setArchiveTarget] = useState<{ target: Target; workspace: TargetWorkspace }>()
  const [stopActivity, setStopActivity] = useState(false)
  const [archiveResult, setArchiveResult] = useState<ArchiveTargetSessionsResult>()
  const archive = useMutation((targetId: string, request: ArchiveTargetSessionsRequest) =>
    archiveTargetSessions(targetId, request),
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

  /**
   * Copy one read-only workspace path.
   *
   * The path is display-only: copying it must never feed the editable draft or
   * a PUT body. `navigator.clipboard` is unavailable on an insecure origin, so
   * the selection fallback keeps the button useful in a plain-http panel.
   */
  const copyWorkspacePath = async (key: string, path: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(path)
        setCopiedWorkspace(key)
        return
      }
    } catch {
      // Fall through to the selection fallback.
    }
    try {
      const field = document.createElement('textarea')
      field.value = path
      field.setAttribute('readonly', '')
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.append(field)
      field.select()
      const copied = document.execCommand('copy')
      field.remove()
      setCopiedWorkspace(copied ? key : undefined)
    } catch {
      setCopiedWorkspace(undefined)
    }
  }

  /**
   * Open the confirmation dialog for one ready workspace.
   *
   * Reopening always starts from a clean slate: no stale result, no stale error
   * and the stop switch off, so the dialog never implies a request already ran.
   */
  const openArchive = (target: Target, workspace: TargetWorkspace) => {
    archive.reset()
    setArchiveResult(undefined)
    setStopActivity(false)
    setArchiveTarget({ target, workspace })
  }

  const closeArchive = () => {
    if (archive.pending) return
    archive.reset()
    setArchiveResult(undefined)
    setStopActivity(false)
    setArchiveTarget(undefined)
  }

  const submitArchive = async () => {
    if (!archiveTarget) return
    try {
      const result = await archive.run(archiveTarget.target.id, { stopActivity })
      setArchiveResult(result)
      // The live projection may now show a different rotation generation.
      targetsApi.reload()
    } catch {
      // `useMutation` keeps the failure; the dialog renders it and stays open.
    }
  }

  const loadError = targetsApi.error ?? settingsApi.error
  // Subscription health is additive: when `GET channel` fails the rows keep
  // working and only the read-only status column goes away.
  const health = channelApi.data
    ? new Map(channelApi.data.targets.map((target) => [target.targetId, target] as const))
    : undefined
  const validCount = validation.filter((item) => item.valid).length
  const invalidCount = validation.length - validCount
  // `workspace` is a derived, read-only projection; older hosts omit it, in
  // which case the whole section stays hidden instead of showing a guess.
  const workspaceTargets = (targetsApi.data?.targets ?? []).flatMap((target) =>
    target.workspace === undefined ? [] : [{ target, workspace: target.workspace as TargetWorkspace }],
  )

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
          {channelApi.error ? (
            <div style={{ marginBottom: 10 }}>
              <Alert tone="info" role="status">
                {t('targets.health.unavailable')}
              </Alert>
            </div>
          ) : null}
          <RowsField
            rows={rows}
            onChange={updateRows}
            disabled={saving || revision === undefined}
            rowErrors={rowErrors}
            health={health}
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
      {workspaceTargets.length > 0 ? (
        <Card title={t('targets.workspace.title')}>
          <p className="wc-hint">{t('targets.workspace.hint')}</p>
          <div className="wc-tablewrap" style={{ marginTop: 10 }}>
            <table className="wc-table">
              <thead>
                <tr>
                  <th scope="col">{t('targets.list.title')}</th>
                  <th scope="col">{t('targets.workspace.title')}</th>
                  <th scope="col">{t('targets.workspace.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {workspaceTargets.map(({ target, workspace }) => {
                  const key = `${target.kind}:${target.id}`
                  const label = target.label || target.id
                  const path = workspace.path
                  return (
                    <tr key={key} data-workspace-mode={workspace.mode}>
                      <td>
                        <span className="wc-cell-title">{label}</span>
                        <span className="wc-cell-meta">
                          {t(`targets.kind.${target.kind}` as 'targets.kind.group')} · {target.id}
                        </span>
                      </td>
                      <td>
                        {workspace.mode === 'ready' && path !== null ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                            <Badge tone="success">{t('targets.workspace.ready')}</Badge>
                            <span className="wc-mono">{path}</span>
                            <Button
                              size="sm"
                              aria-label={`${t('targets.workspace.copy')}: ${label}`}
                              onClick={() => void copyWorkspacePath(key, path)}
                            >
                              {t('targets.workspace.copy')}
                            </Button>
                            {copiedWorkspace === key ? (
                              <span className="wc-hint" role="status">
                                {t('targets.workspace.copied')}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <Badge tone="neutral">{t('targets.workspace.perConversation')}</Badge>
                        )}
                      </td>
                      <td>
                        {workspace.mode === 'ready' ? (
                          <Button
                            size="sm"
                            aria-label={t('targets.archive.openAria', { label })}
                            onClick={() => openArchive(target, workspace)}
                          >
                            {t('targets.archive.open')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      <div className="wc-grid" data-columns="two">
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
              <TextField
                value={query}
                placeholder={
                  discoverKind === 'dm'
                    ? t('targets.discover.queryPlaceholderDm')
                    : t('targets.discover.queryPlaceholder')
                }
                onChange={setQuery}
              />
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
          {validation.length === 0 && !validate.error ? <p className="wc-hint">{t('targets.discover.body')}</p> : null}
        </Card>
      </div>
      <Modal
        open={archiveTarget !== undefined}
        title={t('targets.archive.title')}
        closeLabel={t('dialog.close')}
        onClose={closeArchive}
        footer={
          archiveResult !== undefined ? (
            <Button size="sm" onClick={closeArchive}>
              {t('targets.archive.close')}
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={closeArchive} disabled={archive.pending}>
                {t('targets.archive.cancel')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void submitArchive()} disabled={archive.pending}>
                {archive.pending ? t('targets.archive.pending') : t('targets.archive.confirm')}
              </Button>
            </>
          )
        }
      >
        {archiveTarget ? (
          archiveResult ? (
            <ArchiveResult result={archiveResult} t={t} />
          ) : (
            <>
              <p className="wc-hint" style={{ marginTop: 0 }}>
                {archiveTarget.target.label || archiveTarget.target.id}
                {archiveTarget.workspace.path ? ` · ${archiveTarget.workspace.path}` : ''}
              </p>
              <p className="wc-muted">{t('targets.archive.body')}</p>
              <p className="wc-hint">{t('targets.archive.warning')}</p>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginTop: 12,
                }}
              >
                <div>
                  <div className="wc-cell-title">{t('targets.archive.stopActivity')}</div>
                  <p className="wc-hint" style={{ marginTop: 4 }}>
                    {t('targets.archive.stopActivityHint')}
                  </p>
                </div>
                <Switch
                  checked={stopActivity}
                  onChange={setStopActivity}
                  label={t('targets.archive.stopActivity')}
                  disabled={archive.pending}
                />
              </div>
              {archive.error ? (
                <div style={{ marginTop: 12 }}>
                  <Alert tone="error" role="alert">
                    {t('targets.archive.error', { message: archiveErrorText(archive.error, t) })}
                  </Alert>
                </div>
              ) : null}
            </>
          )
        ) : null}
      </Modal>
    </div>
  )
}
