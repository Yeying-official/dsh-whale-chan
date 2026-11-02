/** Small context-free UI primitives for the WS0 panel. */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

export type ButtonProps = {
  readonly variant?: 'primary' | 'secondary'
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

export function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="wc-card">
      <header className="wc-card-head">
        <h2>{title}</h2>
        {actions ? <div className="wc-card-actions">{actions}</div> : null}
      </header>
      <div className="wc-card-body">{children}</div>
    </section>
  )
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error'

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="wc-badge" data-tone={tone}>
      {children}
    </span>
  )
}
