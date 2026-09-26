import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconAlert, IconChevronLeft, IconChevronRight, IconInfo, IconX } from './icons';

// ------------------------------------------------------------------ layout

export function Screen({
  title,
  eyebrow,
  back,
  actions,
  children,
}: {
  title: string;
  eyebrow?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Tr-e-V0r`;
  }, [title]);
  return (
    <main className="screen" aria-labelledby="screen-title">
      <header className="screen-head">
        {back ? (
          <a className="back-link" href={back.href}>
            <IconChevronLeft size={20} />
            <span>{back.label}</span>
          </a>
        ) : null}
        <div className="row-between screen-head-row">
          <div className="grow">
            {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
            <h1 id="screen-title" className="screen-title">
              {title}
            </h1>
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      </header>
      <div className="stack-lg screen-body">{children}</div>
    </main>
  );
}

export function Section({ title, action, children, id }: { title: string; action?: ReactNode; children: ReactNode; id?: string }) {
  const hid = useId();
  return (
    <section className="section" aria-labelledby={hid} id={id}>
      <div className="row-between section-head">
        <h2 id={hid} className="section-title">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className = '', tone }: { children: ReactNode; className?: string; tone?: 'accent' | 'warn' | 'bad' }) {
  return <div className={`card ${tone ? `card-${tone}` : ''} ${className}`}>{children}</div>;
}

// ----------------------------------------------------------------- controls

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={loading || rest.disabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function LinkButton({ href, children, variant = 'secondary', icon }: { href: string; children: ReactNode; variant?: ButtonVariant; icon?: ReactNode }) {
  return (
    <a className={`btn btn-${variant} btn-md`} href={href}>
      {icon}
      <span>{children}</span>
    </a>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; ariaLabel?: string; disabled?: boolean; title?: string | undefined }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          aria-disabled={o.disabled || undefined}
          aria-label={o.ariaLabel}
          title={o.title ?? o.ariaLabel}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const id = useId();
  return (
    <label className="toggle-row" htmlFor={id}>
      <span className="grow">
        <span className="toggle-label">{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ display

export type Tone = 'neutral' | 'accent' | 'good' | 'bad' | 'warn' | 'up' | 'down';

export function Pill({ tone = 'neutral', children, icon }: { tone?: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon}
      {children}
    </span>
  );
}

export function Stat({ label, value, sub, className = '' }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`stat ${className}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub ? <div className="stat-sub num">{sub}</div> : null}
    </div>
  );
}

export function ListRow({
  href,
  onClick,
  icon,
  title,
  subtitle,
  trailing,
  chevron = true,
}: {
  href?: string;
  onClick?: () => void;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
}) {
  const body = (
    <>
      {icon ? <span className="list-icon">{icon}</span> : null}
      <span className="grow list-main">
        <span className="list-title">{title}</span>
        {subtitle ? <span className="list-sub">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="list-trailing">{trailing}</span> : null}
      {chevron && (href || onClick) ? <IconChevronRight size={18} className="list-chevron" /> : null}
    </>
  );
  if (href) {
    return (
      <a className="list-row" href={href}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className="list-row" onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className="list-row">{body}</div>;
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'bad'; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'note'}>
      <span className="notice-icon">{tone === 'info' ? <IconInfo size={18} /> : <IconAlert size={18} />}</span>
      <div className="grow">
        {title ? <div className="notice-title">{title}</div> : null}
        {children ? <div className="notice-body">{children}</div> : null}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-text">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role={label ? 'status' : undefined} aria-label={label}>
      <span className="spinner-ring" aria-hidden="true" />
    </span>
  );
}

export function Skeleton({ h = 18, w = '100%', r = 8 }: { h?: number; w?: number | string; r?: number }) {
  return <span className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden="true" />;
}

export function LoadingBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card stack" role="status" aria-label="Chargement">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={i === 0 ? '45%' : i % 2 ? '85%' : '70%'} />
      ))}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Notice tone="bad" title="Impossible de charger ces données">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="text-link" onClick={onRetry}>
          Réessayer
        </button>
      ) : null}
    </Notice>
  );
}

/** Usage of a limit: value / max, with the tone moving to warning then critical. */
export function Meter({ label, value, max, display }: { label: string; value: number; max: number; display: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const tone = ratio >= 1 ? 'bad' : ratio >= 0.75 ? 'warn' : 'ok';
  return (
    <div className="meter">
      <div className="row-between">
        <span className="small muted">{label}</span>
        <span className="small num">{display}</span>
      </div>
      <div
        className={`meter-track meter-${tone}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={display}
      >
        <span className="meter-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- sheet

/**
 * Bottom sheet (modal). Escape and the backdrop close it; focus moves inside
 * on open and returns to the trigger on close.
 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.sheet-close)');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea')];
        if (items.length === 0) return;
        const firstItem = items[0]!;
        const lastItem = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="sheet-layer">
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="row-between sheet-head">
          <h2 id={titleId} className="sheet-title">
            {title}
          </h2>
          <button type="button" className="icon-btn sheet-close" onClick={onClose} aria-label="Fermer">
            <IconX size={20} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
