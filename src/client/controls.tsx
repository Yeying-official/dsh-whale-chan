/** Small context-free UI primitives shared by every panel page. */
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Join conditional class names. */
export const cx = (...names: (string | false | undefined | null)[]) => names.filter(Boolean).join(' ')

export type ButtonProps = {
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  readonly size?: 'sm' | 'md'
} & ButtonHTMLAttributes<HTMLButtonElement>

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('wc-button', `wc-button-${variant}`, `wc-button-${size}`, className)}
      {...props}
    />
  )
}

export interface CardProps {
  readonly title: string
  readonly children: ReactNode
  readonly actions?: ReactNode
  readonly className?: string
  readonly id?: string
  readonly headingId?: string
}

export function Card({ title, children, actions, className, id, headingId }: CardProps) {
  return (
    <section className={cx('wc-card', className)} id={id} aria-labelledby={headingId}>
      <header className="wc-card-head">
        <h2 id={headingId}>{title}</h2>
        {actions ? <div className="wc-card-actions">{actions}</div> : null}
      </header>
      <div className="wc-card-body">{children}</div>
    </section>
  )
}

/** Accessible binary switch built as a real `role="switch"` button. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  id?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className="wc-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'info'

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="wc-badge" data-tone={tone}>
      {children}
    </span>
  )
}

/** One inline loading placeholder; the label is announced once. */
export function Skeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="wc-skeleton" role="status" aria-label={label}>
      <span className="wc-visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_value, index) => (
        <span key={index} className="wc-skeleton-line" style={{ width: `${88 - index * 12}%` }} />
      ))}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="wc-empty">
      <p className="wc-empty-title">{title}</p>
      {hint ? <p className="wc-muted">{hint}</p> : null}
    </div>
  )
}

export type AlertTone = 'info' | 'warning' | 'error' | 'success'

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  role,
}: {
  tone?: AlertTone
  title?: string
  children?: ReactNode
  action?: ReactNode
  role?: 'alert' | 'status'
}) {
  return (
    <div className="wc-alert" data-tone={tone} role={role}>
      <div className="wc-alert-body">
        {title ? <strong>{title}</strong> : null}
        {children ? <div className="wc-alert-text">{children}</div> : null}
      </div>
      {action ? <div className="wc-alert-action">{action}</div> : null}
    </div>
  )
}

export interface ModalProps {
  readonly open: boolean
  readonly title: string
  readonly closeLabel: string
  readonly onClose: () => void
  readonly children: ReactNode
  readonly footer?: ReactNode
}

/**
 * Accessible modal dialog.
 *
 * Escape closes it, the first focusable control receives focus on open, and
 * focus returns to the triggering element on close.
 */
export function Modal({ open, title, closeLabel, onClose, children, footer }: ModalProps) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const focusable = panel.current?.querySelector<HTMLElement>('input, textarea, select, button, [href]')
    focusable?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      className="wc-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={panel} className="wc-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <header className="wc-modal-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <button type="button" className="wc-icon-button" aria-label={closeLabel} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="wc-modal-body">{children}</div>
        {footer ? <footer className="wc-modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}

/** One page heading with optional actions. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="wc-page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="wc-page-actions">{actions}</div> : null}
    </header>
  )
}
