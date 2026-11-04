/** Reusable form primitives driven by the shared field registry. */
import { cloneElement, useId, type ReactElement } from 'react'
import { Badge, Button, Switch, cx } from './controls.tsx'
import type { BadgeTone } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { FIELDS, fieldsOf } from '../shared/fields.ts'
import type { ApiIssue } from './api.ts'
import type { FieldSpec } from '../shared/fields.ts'
import type { ChannelTargetHealthView } from '../shared/models.ts'
import type { SettingsBlock } from '../shared/settings.ts'
import type { ReplyMode, TargetKind } from '../shared/limits.ts'

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one dot path out of a settings value. */
export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const part of path.split('.')) {
    if (!isRecordValue(current)) return undefined
    current = current[part]
  }
  return current
}

/** Immutably write one dot path, creating missing objects along the way. */
export function setPath(value: Record<string, unknown>, path: string, next: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.')
  if (head === undefined) return value
  const base: Record<string, unknown> = { ...value }
  if (rest.length === 0) {
    base[head] = next
    return base
  }
  const child = isRecordValue(base[head]) ? base[head] : {}
  base[head] = setPath(child, rest.join('.'), next)
  return base
}

/** Every leaf of one block, filled with the frozen defaults. */
export function blockDefaults(block: SettingsBlock): Record<string, unknown> {
  let value: Record<string, unknown> = {}
  for (const spec of fieldsOf(block)) {
    value = setPath(value, spec.path, structuredClone(spec.defaultValue))
  }
  return value
}

/** Read one block value as a plain object, falling back to defaults when the host omits it. */
export function blockValue(block: SettingsBlock, value: unknown): Record<string, unknown> {
  const defaults = blockDefaults(block)
  if (!isRecordValue(value)) return defaults
  let merged = defaults
  for (const spec of fieldsOf(block)) {
    const current = getPath(value, spec.path)
    if (current !== undefined) merged = setPath(merged, spec.path, current)
  }
  return merged
}

/** Normalize `400 invalid_settings` issue paths into field-keyed messages. */
export function issueFieldMap(block: SettingsBlock, issues: readonly ApiIssue[]): Record<string, string> {
  const prefix = `${block}.`
  const map: Record<string, string> = {}
  for (const issue of issues) {
    const path = issue.path.startsWith(prefix) ? issue.path.slice(prefix.length) : issue.path
    if (path.length > 0) map[path] = issue.message
  }
  return map
}

export interface FieldRowProps {
  readonly label: string
  readonly labelFor?: string | undefined
  readonly hint?: string | undefined
  readonly note?: string | undefined
  readonly error?: string | undefined
  readonly className?: string
  /** Composite controls (lists, row editors) label a group instead of one input. */
  readonly group?: boolean
  readonly children: ReactElement<{ id?: string; 'aria-invalid'?: boolean | undefined }>
}

/** One labeled control with hint, warning note and field-level error. */
export function FieldRow({ label, labelFor, hint, note, error, className, group, children }: FieldRowProps) {
  const generated = useId()
  const id = labelFor ?? children.props.id ?? `wc-field-${generated}`
  const labelId = `${id}-label`
  const control = cloneElement(children, { id, 'aria-invalid': error ? true : undefined })
  if (group) {
    return (
      <div className={cx('wc-field', className)}>
        <span className="wc-field-label">
          <span id={labelId}>{label}</span>
        </span>
        <div role="group" aria-labelledby={labelId}>
          {control}
        </div>
        {hint ? <span className="wc-field-hint">{hint}</span> : null}
        {note ? <span className="wc-field-note">{note}</span> : null}
        {error ? (
          <span className="wc-field-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    )
  }
  return (
    <div className={cx('wc-field', className)}>
      <span className="wc-field-label">
        <label htmlFor={id}>{label}</label>
      </span>
      {control}
      {hint ? <span className="wc-field-hint">{hint}</span> : null}
      {note ? <span className="wc-field-note">{note}</span> : null}
      {error ? (
        <span className="wc-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

export interface TextFieldProps {
  readonly id?: string
  readonly value: string
  readonly onChange: (next: string) => void
  readonly placeholder?: string
  readonly multiline?: boolean
  readonly rows?: number
  readonly disabled?: boolean
  readonly autoFocus?: boolean
  readonly ariaLabel?: string
  readonly 'aria-invalid'?: boolean | undefined
}

export function TextField({
  id,
  value,
  onChange,
  placeholder,
  multiline,
  rows = 3,
  disabled,
  autoFocus,
  ariaLabel,
  'aria-invalid': ariaInvalid,
}: TextFieldProps) {
  if (multiline) {
    return (
      <textarea
        id={id}
        className="wc-textarea"
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  return (
    <input
      id={id}
      className="wc-input"
      type="text"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export interface NumberFieldProps {
  readonly id?: string
  readonly value: number | ''
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly unit?: string | undefined
  readonly onChange: (next: number | '') => void
  readonly disabled?: boolean
  readonly 'aria-invalid'?: boolean | undefined
}

export function NumberField({
  id,
  value,
  min,
  max,
  unit,
  onChange,
  disabled,
  'aria-invalid': ariaInvalid,
}: NumberFieldProps) {
  return (
    <div className="wc-number">
      <input
        id={id}
        className="wc-input"
        type="number"
        inputMode="numeric"
        value={value === '' ? '' : String(value)}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        aria-invalid={ariaInvalid}
        onChange={(event) => {
          const text = event.target.value.trim()
          if (text === '') return onChange('')
          const parsed = Number(text)
          onChange(Number.isFinite(parsed) ? parsed : '')
        }}
      />
      {unit ? <span className="wc-number-unit">{unit}</span> : null}
    </div>
  )
}

export interface SwitchFieldProps {
  readonly id?: string
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: string
  readonly hint?: string
  readonly disabled?: boolean
}

export function SwitchField({ id, checked, onChange, label, hint, disabled }: SwitchFieldProps) {
  return (
    <div className="wc-switch-row">
      <div>
        <span className="wc-field-label">{label}</span>
        {hint ? <span className="wc-field-hint">{hint}</span> : null}
      </div>
      <Switch id={id} checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  )
}

export interface EnumFieldProps {
  readonly id?: string
  readonly value: string
  readonly options: readonly string[]
  readonly optionLabel: (option: string) => string
  readonly onChange: (next: string) => void
  readonly disabled?: boolean
  readonly 'aria-invalid'?: boolean | undefined
}

export function EnumField({
  id,
  value,
  options,
  optionLabel,
  onChange,
  disabled,
  'aria-invalid': ariaInvalid,
}: EnumFieldProps) {
  return (
    <select
      id={id}
      className="wc-select"
      value={value}
      disabled={disabled}
      aria-invalid={ariaInvalid}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {optionLabel(option)}
        </option>
      ))}
    </select>
  )
}

export interface ListFieldProps {
  readonly id?: string
  readonly items: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  readonly disabled?: boolean
}

/** Editable string list with add and per-row remove actions. */
export function ListField({ id, items, onChange, disabled }: ListFieldProps) {
  const { t } = usePanel()
  const add = () => onChange([...items, ''])
  const update = (index: number, next: string) =>
    onChange(items.map((item, position) => (position === index ? next : item)))
  const remove = (index: number) => onChange(items.filter((_item, position) => position !== index))
  return (
    <div className="wc-list">
      {items.length === 0 ? <span className="wc-field-hint">{t('settings.list.empty')}</span> : null}
      {items.map((item, index) => (
        <div className="wc-list-row" key={index}>
          <TextField
            id={index === 0 && id ? id : undefined}
            value={item}
            disabled={disabled}
            ariaLabel={t('settings.list.item', { index: index + 1 })}
            onChange={(next) => update(index, next)}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label={t('settings.list.remove', { index: index + 1 })}
            onClick={() => remove(index)}
          >
            {t('common.remove')}
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" disabled={disabled} onClick={add}>
          {t('settings.list.add')}
        </Button>
      </div>
    </div>
  )
}

/** One editable target row; the shape mirrors `TargetRow` from the settings contract. */
export interface TargetRowValue {
  readonly kind: TargetKind
  readonly id: string
  readonly label: string
  readonly mentionOnly: boolean
  readonly replyMode: ReplyMode
  readonly enabled: boolean
}

export interface RowsFieldProps {
  readonly rows: readonly TargetRowValue[]
  readonly onChange: (next: readonly TargetRowValue[]) => void
  readonly disabled?: boolean
  readonly rowErrors?: Readonly<Record<number, string>>
  /** Live subscription state per target id; omitted when the host cannot report it. */
  readonly health?: ReadonlyMap<string, ChannelTargetHealthView>
}

/** Tone of one subscription-state badge; the labels themselves live in the dictionary. */
const HEALTH_TONES: Record<ChannelTargetHealthView['state'] | 'unknown', BadgeTone> = {
  starting: 'info',
  ready: 'success',
  stopped: 'neutral',
  failed: 'error',
  orphaned: 'warning',
  unknown: 'neutral',
}

/** The mention-only rule that actually applies to each target kind. */
const MENTION_ONLY_HINTS = {
  'at-me': 'settings.rows.mentionOnly.atMe',
  group: 'settings.rows.mentionOnly.group',
  dm: 'settings.rows.mentionOnly.dm',
} as const

/** Stack a control and its inline hint inside one table cell. */
const CELL_STACK = { display: 'flex', flexDirection: 'column', gap: 4 } as const

interface TargetHealthCellProps {
  readonly entry: ChannelTargetHealthView | undefined
}

/**
 * Read-only subscription state of one target row.
 *
 * Only the state label is localized. `lastError` is host data and is rendered
 * verbatim, truncated visually with the complete text kept in `title`.
 */
function TargetHealthCell({ entry }: TargetHealthCellProps) {
  const { t } = usePanel()
  const state = entry?.state ?? 'unknown'
  return (
    <div style={CELL_STACK}>
      <span>
        <Badge tone={HEALTH_TONES[state]}>{t(`targets.health.${state}` as 'targets.health.ready')}</Badge>
      </span>
      {entry !== undefined && entry.restarts > 0 ? (
        <span className="wc-cell-meta">{t('targets.health.restarts', { count: entry.restarts })}</span>
      ) : null}
      {entry?.lastError ? (
        <span
          className="wc-cell-meta"
          style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={entry.lastError}
        >
          {entry.lastError}
        </span>
      ) : null}
    </div>
  )
}

/** Target-row editor: kind, id, label, mention-only, reply mode and enabled. */
export function RowsField({ rows, onChange, disabled, rowErrors = {}, health }: RowsFieldProps) {
  const { t } = usePanel()
  const update = (index: number, patch: Partial<TargetRowValue>) =>
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)))
  const remove = (index: number) => onChange(rows.filter((_row, position) => position !== index))
  const add = () =>
    onChange([...rows, { kind: 'group', id: '', label: '', mentionOnly: true, replyMode: 'auto', enabled: true }])

  return (
    <div className="wc-rows">
      {rows.length === 0 ? <p className="wc-muted">{t('settings.rows.empty')}</p> : null}
      {rows.length > 0 ? (
        <div className="wc-tablewrap">
          <table className="wc-table">
            <thead>
              <tr>
                <th scope="col">{t('settings.rows.kind')}</th>
                <th scope="col">{t('settings.rows.id')}</th>
                <th scope="col">{t('settings.rows.label')}</th>
                <th scope="col">{t('settings.rows.mentionOnly')}</th>
                <th scope="col">{t('settings.rows.replyMode')}</th>
                <th scope="col">{t('settings.rows.enabled')}</th>
                {health ? <th scope="col">{t('targets.health.column')}</th> : null}
                <th scope="col">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <td>
                    <select
                      className="wc-select wc-inline-select"
                      aria-label={`${t('settings.rows.kind')} ${index + 1}`}
                      value={row.kind}
                      disabled={disabled}
                      onChange={(event) => update(index, { kind: event.target.value as TargetKind })}
                    >
                      {(['at-me', 'group', 'dm'] as const).map((kind) => (
                        <option key={kind} value={kind}>
                          {t(`targets.kind.${kind}` as 'targets.kind.group')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div style={CELL_STACK}>
                      <input
                        id={`wc-target-row-${index}`}
                        className="wc-input wc-mono"
                        aria-label={`${t('settings.rows.id')} ${index + 1}`}
                        value={row.id}
                        disabled={disabled}
                        placeholder={
                          row.kind === 'at-me'
                            ? t('settings.rows.idPlaceholder.atMe')
                            : row.kind === 'dm'
                              ? t('settings.rows.idPlaceholder.dm')
                              : undefined
                        }
                        aria-invalid={rowErrors[index] ? true : undefined}
                        onChange={(event) => update(index, { id: event.target.value })}
                      />
                      {row.kind === 'at-me' ? (
                        <span className="wc-cell-meta">{t('settings.rows.idHint.atMe')}</span>
                      ) : null}
                      {row.kind === 'dm' ? <span className="wc-cell-meta">{t('settings.rows.idHint.dm')}</span> : null}
                    </div>
                  </td>
                  <td>
                    <input
                      className="wc-input"
                      aria-label={`${t('settings.rows.label')} ${index + 1}`}
                      value={row.label}
                      disabled={disabled}
                      onChange={(event) => update(index, { label: event.target.value })}
                    />
                  </td>
                  <td>
                    <div style={CELL_STACK}>
                      <Switch
                        checked={row.mentionOnly}
                        label={`${t('settings.rows.mentionOnly')} ${index + 1}`}
                        disabled={disabled || row.kind !== 'group'}
                        onChange={(next) => update(index, { mentionOnly: next })}
                      />
                      <span className="wc-cell-meta">{t(MENTION_ONLY_HINTS[row.kind])}</span>
                    </div>
                  </td>
                  <td>
                    <select
                      className="wc-select wc-inline-select"
                      aria-label={`${t('settings.rows.replyMode')} ${index + 1}`}
                      value={row.replyMode}
                      disabled={disabled}
                      onChange={(event) => update(index, { replyMode: event.target.value as ReplyMode })}
                    >
                      {(['auto', 'review', 'off'] as const).map((mode) => (
                        <option key={mode} value={mode}>
                          {t(`targets.replyMode.${mode}` as 'targets.replyMode.auto')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Switch
                      checked={row.enabled}
                      label={`${t('settings.rows.enabled')} ${index + 1}`}
                      disabled={disabled}
                      onChange={(next) => update(index, { enabled: next })}
                    />
                  </td>
                  {health ? (
                    <td>
                      <TargetHealthCell entry={health.get(row.id)} />
                    </td>
                  ) : null}
                  <td>
                    <div className="wc-cell-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        aria-label={t('settings.rows.remove')}
                        onClick={() => remove(index)}
                      >
                        {t('common.remove')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {Object.entries(rowErrors).map(([index, message]) => (
        <p className="wc-field-error" role="alert" key={index}>
          {t('targets.rowError', { index: Number(index) + 1, message })}
        </p>
      ))}
      <div className="wc-action-row" style={{ marginTop: 4 }}>
        <Button size="sm" disabled={disabled} onClick={add}>
          {t('settings.rows.add')}
        </Button>
      </div>
      <p className="wc-hint">{t('settings.rows.hint')}</p>
    </div>
  )
}

export interface FormActionsProps {
  readonly dirty: boolean
  readonly saving: boolean
  readonly saveLabel: string
  readonly savingLabel: string
  readonly resetLabel: string
  readonly dirtyLabel: string
  readonly onSave: () => void
  readonly onReset: () => void
  readonly disabled?: boolean
}

/** Save/reset footer used by every settings-driven form. */
export function FormActions({
  dirty,
  saving,
  saveLabel,
  savingLabel,
  resetLabel,
  dirtyLabel,
  onSave,
  onReset,
  disabled,
}: FormActionsProps) {
  return (
    <div className="wc-form-actions">
      <span className="wc-form-status">{dirty ? dirtyLabel : ''}</span>
      <Button size="sm" onClick={onReset} disabled={!dirty || saving || disabled}>
        {resetLabel}
      </Button>
      <Button size="sm" variant="primary" onClick={onSave} disabled={!dirty || saving || disabled}>
        {saving ? savingLabel : saveLabel}
      </Button>
    </div>
  )
}

/** Resolve an enum option label from the settings dictionary. */
export function useEnumLabel(path: string): (option: string) => string {
  const { t } = usePanel()
  return (option) => {
    const key = `settings.enum.${path}.${option}`
    const value = t(key as 'settings.enum.language.auto')
    return value === key ? option : value
  }
}

/** Keep the exported registry reachable for tests that assert one source of truth. */
export const FIELD_REGISTRY = FIELDS

export type { SettingsBlock }

/** Stable DOM id for one registry field, used for focus management after an error. */
export function fieldDomId(block: SettingsBlock, path: string): string {
  return `wc-field-${block}-${path.replace(/\./g, '-')}`
}

/** Locally enforce the numeric bounds before a round trip; the host stays authoritative. */
export function validateBlock(
  block: SettingsBlock,
  value: Record<string, unknown>,
  t: (key: Parameters<ReturnType<typeof usePanel>['t']>[0], params?: Record<string, unknown>) => string,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const spec of fieldsOf(block)) {
    const current = getPath(value, spec.path)
    if (spec.type === 'number') {
      if (typeof current !== 'number' || !Number.isFinite(current)) {
        errors[spec.path] = t('settings.numberRequired')
        continue
      }
      const min = spec.min ?? Number.NEGATIVE_INFINITY
      const max = spec.max ?? Number.POSITIVE_INFINITY
      if (current < min || current > max) {
        errors[spec.path] = t('settings.numberRange', { min, max })
      }
    } else if (spec.type === 'string' && typeof current !== 'string') {
      errors[spec.path] = t('settings.fieldRequired')
    } else if (spec.type === 'enum' && (typeof current !== 'string' || !(spec.options ?? []).includes(current))) {
      errors[spec.path] = t('settings.fieldRequired')
    }
  }
  return errors
}

const LONG_TEXT = new Set(['persona.identity', 'persona.knowledge'])

export interface RegistryFieldProps {
  readonly spec: FieldSpec
  readonly value: unknown
  readonly error?: string | undefined
  readonly note?: string | undefined
  readonly wide?: boolean
  readonly disabled?: boolean
  readonly onChange: (next: unknown) => void
}

/** Render one registry leaf with the component its declared type calls for. */
export function RegistryField({ spec, value, error, note, wide, disabled, onChange }: RegistryFieldProps) {
  const { t } = usePanel()
  const label = t(spec.labelKey as Parameters<typeof t>[0])
  const hint = t(spec.hintKey as Parameters<typeof t>[0])
  const id = fieldDomId(spec.block, spec.path)
  const unit = spec.unit ? t(`settings.unit.${spec.unit}` as 'settings.unit.seconds') : undefined
  const className = wide ? 'wc-field-wide' : undefined
  const optionLabel = (option: string) => {
    const key = `settings.enum.${spec.path}.${option}` as 'settings.enum.language.auto'
    const text = t(key)
    return text === key ? option : text
  }

  if (spec.type === 'boolean') {
    return (
      <div className={className}>
        <SwitchField
          id={id}
          checked={value === true}
          label={label}
          hint={hint}
          disabled={disabled}
          onChange={(next) => onChange(next)}
        />
        {note ? <span className="wc-field-note">{note}</span> : null}
        {error ? (
          <span className="wc-field-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    )
  }
  if (spec.type === 'number') {
    return (
      <FieldRow className={className} label={label} hint={hint} note={note} error={error}>
        <NumberField
          value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
          min={spec.min}
          max={spec.max}
          unit={unit}
          disabled={disabled}
          onChange={onChange}
        />
      </FieldRow>
    )
  }
  if (spec.type === 'enum') {
    return (
      <FieldRow className={className} label={label} hint={hint} note={note} error={error}>
        <EnumField
          value={typeof value === 'string' ? value : ''}
          options={spec.options ?? []}
          optionLabel={optionLabel}
          disabled={disabled}
          onChange={onChange}
        />
      </FieldRow>
    )
  }
  if (spec.type === 'string-list') {
    return (
      <FieldRow className={className} label={label} hint={hint} note={note} error={error} group>
        <ListField
          items={Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []}
          disabled={disabled}
          onChange={onChange}
        />
      </FieldRow>
    )
  }
  if (spec.type === 'rows') {
    return (
      <FieldRow className={className} label={label} hint={hint} note={note} error={error} group>
        <RowsField
          rows={(Array.isArray(value) ? value : []) as TargetRowValue[]}
          disabled={disabled}
          onChange={(next) => onChange(next)}
        />
      </FieldRow>
    )
  }
  const text = typeof value === 'string' ? value : ''
  return (
    <FieldRow className={className} label={label} hint={hint} note={note} error={error}>
      <TextField
        value={text}
        multiline={LONG_TEXT.has(`${spec.block}.${spec.path}`)}
        disabled={disabled}
        onChange={onChange}
      />
    </FieldRow>
  )
}

export { fieldsOf }
