/** Tasks tab: status filter, task detail, and the approve/reject/cancel/retry actions. */
import { useState, type ReactNode } from 'react'
import { ApiError, call, isRecord, useApi, useMutation, usePaged } from '../api.ts'
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Skeleton } from '../controls.tsx'
import { asError, errorText } from '../errors.ts'
import { FieldRow, TextField } from '../fields.tsx'
import { isAbsoluteWorkspace, timeText } from '../format.ts'
import { usePanel } from '../provider.tsx'
import { sessionErrorText } from '../session.ts'
import { approvalTone, taskTone } from '../status.ts'
import type { Approval, MessageView, Task, TaskDetail, TaskStatus } from '../../shared/models.ts'

const FILTERS = [
  'all',
  'awaiting-approval',
  'queued',
  'running',
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'expired',
] as const

type TaskFilter = (typeof FILTERS)[number]
type ActionKind = 'approve' | 'reject' | 'cancel' | 'retry'

/** Forward-compatible view of fields a later host version may add to `GET tasks/:id`. */
interface AssignmentView {
  readonly sessionId?: unknown
  readonly workspace?: unknown
  readonly state?: unknown
  readonly outcome?: unknown
  readonly error?: unknown
}

interface TaskDetailExtension {
  readonly assignment?: AssignmentView
  readonly result?: unknown
}

function statusLabel(t: ReturnType<typeof usePanel>['t'], status: TaskStatus): string {
  return t(`tasks.status.${status}` as 'tasks.status.captured')
}

function approvalLabel(t: ReturnType<typeof usePanel>['t'], approval: Approval): string {
  return t(`tasks.approval.${approval.status}` as 'tasks.approval.pending')
}

function Messages({ messages }: { messages: readonly MessageView[] }) {
  const { t } = usePanel()
  if (messages.length === 0) return <EmptyState title={t('tasks.detail.messages.empty')} />
  return (
    <div>
      {messages.map((message) => (
        <article key={message.id} className="wc-message">
          <div className="wc-message-meta">
            <Badge tone={message.direction === 'incoming' ? 'neutral' : 'info'}>
              {message.direction === 'incoming' ? t('threads.direction.incoming') : t('threads.direction.outgoing')}
            </Badge>
            <span>{message.senderName}</span>
            <span className="wc-mono">{message.senderId}</span>
            <span>{timeText(message.sentAt)}</span>
          </div>
          <p className="wc-message-text">{message.text}</p>
        </article>
      ))}
    </div>
  )
}

function DetailFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function TaskDetailView({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const { t, refreshToken, notify, openSession, refresh } = usePanel()
  const detail = useApi((signal) => call('GET tasks/:id', { params: { id: taskId }, signal }), {
    deps: [taskId, refreshToken],
  })
  const settings = useApi((signal) => call('GET settings', { signal }))
  const [action, setAction] = useState<ActionKind>()
  const [workspace, setWorkspace] = useState('')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [fieldError, setFieldError] = useState<string>()
  const [formError, setFormError] = useState<string>()
  const [openingSession, setOpeningSession] = useState(false)

  const approve = useMutation((body: unknown) => call('POST tasks/:id/approve', { params: { id: taskId }, body }))
  const reject = useMutation((body: unknown) => call('POST tasks/:id/reject', { params: { id: taskId }, body }))
  const cancel = useMutation((body: unknown) => call('POST tasks/:id/cancel', { params: { id: taskId }, body }))
  const retry = useMutation((body: unknown) => call('POST tasks/:id/retry', { params: { id: taskId }, body }))

  const task: Task | undefined = detail.data?.task
  const approval: Approval | null | undefined = detail.data?.approval
  const extra = detail.data as (TaskDetail & TaskDetailExtension) | undefined
  const assignment = extra?.assignment
  const directSession = (detail.data as { readonly sessionId?: unknown } | undefined)?.sessionId
  const sessionId =
    assignment && typeof assignment.sessionId === 'string' && assignment.sessionId.length > 0
      ? assignment.sessionId
      : typeof directSession === 'string' && directSession.length > 0
        ? directSession
        : undefined
  const tasksBlock = settings.data?.blocks.tasks.value
  const workspaceRoot =
    isRecord(tasksBlock) && typeof tasksBlock['workspaceRoot'] === 'string' ? tasksBlock['workspaceRoot'] : ''
  const expiresAt = approval ? Date.parse(approval.expiresAt) : Number.NaN
  const expired = approval?.status === 'pending' && Number.isFinite(expiresAt) && expiresAt <= Date.now()

  const canApprove = task?.status === 'awaiting-approval' && approval?.status === 'pending' && !expired
  const canReject = canApprove
  const canCancel = task?.status === 'awaiting-approval' || task?.status === 'queued' || task?.status === 'running'
  const canRetry = task?.status === 'failed'
  const pending = approve.pending || reject.pending || cancel.pending || retry.pending

  const close = () => {
    if (pending) return
    setAction(undefined)
    setFieldError(undefined)
    setFormError(undefined)
  }
  const start = (kind: ActionKind) => {
    setAction(kind)
    setWorkspace('')
    setNote('')
    setReason('')
    setFieldError(undefined)
    setFormError(undefined)
  }

  const submit = async () => {
    if (!action) return
    setFieldError(undefined)
    setFormError(undefined)
    const trimmed = workspace.trim()
    if ((action === 'approve' || action === 'retry') && !isAbsoluteWorkspace(trimmed)) {
      setFieldError(t('tasks.approve.workspaceInvalid'))
      return
    }
    try {
      if (action === 'approve') {
        await approve.run({
          ...(approval ? { approvalId: approval.id } : {}),
          ...(trimmed.length > 0 ? { workspace: trimmed } : {}),
          ...(note.trim().length > 0 ? { note: note.trim() } : {}),
        })
      } else if (action === 'reject') {
        await reject.run({ ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}) })
      } else if (action === 'cancel') {
        await cancel.run({ ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}) })
      } else {
        await retry.run({ ...(trimmed.length > 0 ? { workspace: trimmed } : {}) })
      }
      notify(t(`tasks.${action}.success` as 'tasks.approve.success'))
      setAction(undefined)
      refresh()
    } catch (failure) {
      const error = asError(failure)
      if (error instanceof ApiError && (error.code === 'invalidWorkspace' || error.code === 'missingWorkspace')) {
        setFieldError(t('tasks.approve.workspaceInvalid'))
      } else {
        setFormError(errorText(error, t))
      }
      notify(errorText(error, t), 'error')
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) detail.reload()
    }
  }

  const openTaskSession = async () => {
    if (!sessionId) return
    setOpeningSession(true)
    try {
      await openSession(sessionId)
    } catch (failure) {
      notify(sessionErrorText(asError(failure), t), 'error')
    } finally {
      setOpeningSession(false)
    }
  }

  const actionTitle = action ? t(`tasks.${action}.title` as 'tasks.approve.title') : ''
  const confirmLabel = action ? t(`tasks.${action}.confirm` as 'tasks.approve.confirm') : ''

  return (
    <div className="wc-page">
      <PageHeader
        title={task?.title ?? t('tasks.detail.title')}
        subtitle={task ? statusLabel(t, task.status) : undefined}
        actions={
          <div className="wc-action-row">
            {task ? <Badge tone={taskTone(task.status)}>{statusLabel(t, task.status)}</Badge> : null}
            <Button size="sm" onClick={onBack}>
              {t('tasks.back')}
            </Button>
          </div>
        }
      />
      {detail.error ? (
        <Alert
          tone="error"
          role="alert"
          title={t('tasks.detailError')}
          action={
            <Button size="sm" onClick={detail.reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(detail.error, t)}
        </Alert>
      ) : null}
      {detail.loading && !task ? <Skeleton label={t('common.loading')} rows={5} /> : null}
      {task ? (
        <>
          <Card title={t('tasks.detail.title')}>
            <dl className="wc-facts">
              <DetailFact label={t('tasks.detail.brief')}>{task.title}</DetailFact>
              <DetailFact label={t('tasks.field.id')}>
                <span className="wc-mono">{task.id}</span>
              </DetailFact>
              <DetailFact label={t('tasks.field.status')}>
                <Badge tone={taskTone(task.status)}>{statusLabel(t, task.status)}</Badge>
              </DetailFact>
              <DetailFact label={t('tasks.field.thread')}>
                <span className="wc-mono">{task.threadKey}</span>
              </DetailFact>
              <DetailFact label={t('tasks.field.created')}>{timeText(task.createdAt)}</DetailFact>
              <DetailFact label={t('tasks.field.updated')}>{timeText(task.updatedAt)}</DetailFact>
              <DetailFact label={t('tasks.field.approvalId')}>
                <span className="wc-mono">{task.approvalId ?? '—'}</span>
              </DetailFact>
            </dl>
          </Card>
          <Card title={t('common.actions')}>
            <div className="wc-action-row">
              <Button
                size="sm"
                variant="primary"
                disabled={!canApprove || pending}
                title={canApprove ? undefined : t('tasks.action.unavailable')}
                onClick={() => start('approve')}
              >
                {t('tasks.action.approve')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!canReject || pending}
                title={canReject ? undefined : t('tasks.action.unavailable')}
                onClick={() => start('reject')}
              >
                {t('tasks.action.reject')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!canCancel || pending}
                title={canCancel ? undefined : t('tasks.action.unavailable')}
                onClick={() => start('cancel')}
              >
                {t('tasks.action.cancel')}
              </Button>
              <Button
                size="sm"
                disabled={!canRetry || pending}
                title={canRetry ? undefined : t('tasks.action.unavailable')}
                onClick={() => start('retry')}
              >
                {t('tasks.action.retry')}
              </Button>
            </div>
          </Card>
          <Card
            title={t('tasks.approval.title')}
            actions={approval ? <Badge tone={approvalTone(approval.status)}>{approvalLabel(t, approval)}</Badge> : null}
          >
            {approval ? (
              <>
                <dl className="wc-facts">
                  <DetailFact label={t('tasks.approval.status')}>{approvalLabel(t, approval)}</DetailFact>
                  <DetailFact label={t('tasks.approval.requestedAt')}>{timeText(approval.requestedAt)}</DetailFact>
                  <DetailFact label={t('tasks.approval.expiresAt')}>{timeText(approval.expiresAt)}</DetailFact>
                  <DetailFact label={t('tasks.approval.decidedAt')}>{timeText(approval.decidedAt)}</DetailFact>
                  <DetailFact label={t('tasks.approval.decidedBy')}>
                    <span className="wc-mono">{approval.decidedBy ?? '—'}</span>
                  </DetailFact>
                </dl>
                {expired ? (
                  <div style={{ marginTop: 12 }}>
                    <Alert tone="warning">{t('tasks.approval.expiredNote')}</Alert>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState title={t('tasks.approval.none')} />
            )}
          </Card>
          <Card title={t('tasks.detail.execution')}>
            {assignment ? (
              <dl className="wc-facts">
                <DetailFact label={t('tasks.detail.workspace')}>
                  <span className="wc-mono">
                    {typeof assignment.workspace === 'string' && assignment.workspace.length > 0
                      ? assignment.workspace
                      : '—'}
                  </span>
                </DetailFact>
                <DetailFact label={t('tasks.detail.assignment')}>
                  {typeof assignment.state === 'string' ? assignment.state : '—'}
                </DetailFact>
                <DetailFact label={t('tasks.detail.result')}>
                  {assignment.outcome === undefined || assignment.outcome === null ? '—' : String(assignment.outcome)}
                </DetailFact>
                <DetailFact label={t('tasks.detail.session')}>
                  {sessionId ? (
                    <Button
                      size="sm"
                      onClick={() => void openTaskSession()}
                      disabled={openingSession}
                      aria-label={t('tasks.detail.openSession')}
                    >
                      {openingSession ? t('common.loading') : sessionId}
                    </Button>
                  ) : (
                    <span className="wc-muted">{t('tasks.sessionUnavailable')}</span>
                  )}
                </DetailFact>
              </dl>
            ) : (
              <p className="wc-muted">{t('tasks.detail.executionUnavailable')}</p>
            )}
          </Card>
          <Card title={t('tasks.detail.messages')}>
            <Messages messages={detail.data?.messages ?? []} />
          </Card>
        </>
      ) : null}

      <Modal
        open={action !== undefined}
        title={actionTitle}
        closeLabel={t('dialog.close')}
        onClose={close}
        footer={
          <>
            <Button size="sm" onClick={close} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              variant={action === 'reject' || action === 'cancel' ? 'danger' : 'primary'}
              onClick={() => void submit()}
              disabled={pending}
            >
              {pending ? t('common.saving') : confirmLabel}
            </Button>
          </>
        }
      >
        {action === 'approve' ? <p className="wc-muted">{t('tasks.approve.body')}</p> : null}
        {action === 'reject' ? <p className="wc-muted">{t('tasks.reject.body')}</p> : null}
        {action === 'cancel' ? <p className="wc-muted">{t('tasks.cancel.body')}</p> : null}
        {action === 'retry' ? <p className="wc-muted">{t('tasks.retry.body')}</p> : null}
        {formError ? (
          <Alert tone="error" role="alert">
            {formError}
          </Alert>
        ) : null}
        {action === 'approve' || action === 'retry' ? (
          <FieldRow
            label={action === 'approve' ? t('tasks.approve.workspace') : t('tasks.retry.workspace')}
            hint={t('tasks.approve.workspaceHint', {
              root: workspaceRoot.length > 0 ? workspaceRoot : t('tasks.approve.workspacePlaceholder'),
            })}
            error={fieldError}
          >
            <TextField
              value={workspace}
              placeholder={workspaceRoot.length > 0 ? workspaceRoot : t('tasks.approve.workspacePlaceholder')}
              onChange={setWorkspace}
            />
          </FieldRow>
        ) : null}
        {action === 'approve' ? (
          <FieldRow label={t('tasks.approve.note')} hint={t('tasks.approve.notePlaceholder')}>
            <TextField value={note} multiline onChange={setNote} />
          </FieldRow>
        ) : null}
        {action === 'reject' || action === 'cancel' ? (
          <FieldRow label={action === 'reject' ? t('tasks.reject.reason') : t('tasks.cancel.reason')}>
            <TextField value={reason} multiline onChange={setReason} />
          </FieldRow>
        ) : null}
      </Modal>
    </div>
  )
}

export function TasksPage() {
  const { t, refreshToken } = usePanel()
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [selected, setSelected] = useState<string>()
  const list = usePaged<Task>(
    (offset, signal) =>
      call('GET tasks', {
        signal,
        query: { status: filter === 'all' ? undefined : filter, offset, limit: 20 },
      }),
    { deps: [filter, refreshToken] },
  )

  if (selected !== undefined) return <TaskDetailView taskId={selected} onBack={() => setSelected(undefined)} />

  return (
    <div className="wc-page">
      <PageHeader title={t('tabs.tasks')} subtitle={t('tasks.subtitle')} />
      <div className="wc-chips" role="group" aria-label={t('tasks.title')}>
        {FILTERS.map((item) => (
          <button
            key={item}
            type="button"
            className="wc-chip"
            aria-pressed={filter === item}
            onClick={() => setFilter(item)}
          >
            {item === 'all' ? t('tasks.filter.all') : statusLabel(t, item)}
          </button>
        ))}
      </div>
      {list.error ? (
        <Alert
          tone="error"
          role="alert"
          title={t('tasks.loadError')}
          action={
            <Button size="sm" onClick={list.reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {errorText(list.error, t)}
        </Alert>
      ) : null}
      <Card
        title={t('tasks.title')}
        actions={
          list.hasMore ? (
            <Button size="sm" onClick={list.loadMore} disabled={list.loadingMore}>
              {list.loadingMore ? t('common.loading') : t('tasks.loadMore')}
            </Button>
          ) : null
        }
      >
        {list.loading && list.items.length === 0 ? <Skeleton label={t('common.loading')} rows={4} /> : null}
        {!list.loading && !list.error && list.items.length === 0 ? <EmptyState title={t('tasks.empty')} /> : null}
        {list.items.length > 0 ? (
          <div className="wc-tablewrap">
            <table className="wc-table">
              <thead>
                <tr>
                  <th scope="col">{t('tasks.title')}</th>
                  <th scope="col">{t('tasks.field.status')}</th>
                  <th scope="col">{t('tasks.field.thread')}</th>
                  <th scope="col">{t('tasks.field.updated')}</th>
                  <th scope="col">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((task) => (
                  <tr key={task.id} data-clickable="true">
                    <td>
                      <span className="wc-cell-title">{task.title}</span>
                      <span className="wc-cell-meta wc-mono">{task.id}</span>
                    </td>
                    <td>
                      <Badge tone={taskTone(task.status)}>{statusLabel(t, task.status)}</Badge>
                    </td>
                    <td>
                      <span className="wc-mono">{task.threadKey}</span>
                    </td>
                    <td>{timeText(task.updatedAt)}</td>
                    <td>
                      <Button size="sm" aria-label={t('tasks.open')} onClick={() => setSelected(task.id)}>
                        {t('tasks.open')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </div>
  )
}
