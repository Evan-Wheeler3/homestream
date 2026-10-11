import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { Link, type LinkProps } from 'react-router';
import { Icon, type IconName } from './Icon';

// -----------------------------------------------------------------------------
// Buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, busy, children, className = '', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`btn btn--${variant} btn--${size} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? (
        <Spinner size={16} />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 16 : 20} />
      ) : null}
      {children && <span>{children}</span>}
    </button>
  );
});

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  ...rest
}: LinkProps & { variant?: Variant; size?: Size; icon?: IconName }) {
  return (
    <Link className={`btn btn--${variant} btn--${size} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 20} />}
      {children && <span>{children}</span>}
    </Link>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: number;
  pressed?: boolean;
  variant?: 'plain' | 'filled' | 'outline';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 20, pressed, variant = 'plain', className = '', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-btn icon-btn--${variant} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
});

// -----------------------------------------------------------------------------
// Feedback

export function Spinner({ size = 24, label }: { size?: number; label?: string }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
    >
      {label && <span className="visually-hidden">{label}</span>}
    </span>
  );
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="page-loader" role="status" aria-live="polite">
      <Spinner size={28} />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

export function Skeleton({
  className = '',
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

interface StatusViewProps {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'error';
  compact?: boolean;
}

/** Shared empty / error / offline state. */
export function StatusView({
  icon = 'film',
  title,
  children,
  action,
  tone = 'neutral',
  compact,
}: StatusViewProps) {
  return (
    <div
      className={`status-view status-view--${tone} ${compact ? 'status-view--compact' : ''}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      <span className="status-view__icon">
        <Icon name={icon} size={compact ? 22 : 28} />
      </span>
      <h2 className="status-view__title">{title}</h2>
      {children && <div className="status-view__body">{children}</div>}
      {action && <div className="status-view__action">{action}</div>}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label ?? 'Watched'}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Dialog (native <dialog>: focus trapping, Esc to close, inert background)

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${size}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Click on the backdrop (the dialog element itself) closes it.
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog__panel">
          <header className="dialog__header">
            <div>
              <h2 id={titleId} className="dialog__title">
                {title}
              </h2>
              {description && <div className="dialog__description">{description}</div>}
            </div>
            <IconButton icon="close" label="Close" onClick={onClose} />
          </header>
          <div className="dialog__body">{children}</div>
          {footer && <footer className="dialog__footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

// -----------------------------------------------------------------------------
// Form controls

interface FieldProps {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
  error?: string | null;
}

export function Field({ label, hint, children, error }: FieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="field__hint">{hint}</p>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <div>
        <label htmlFor={id} className="switch-row__label">
          {label}
        </label>
        {description && <p className="switch-row__desc">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className="switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className="segmented__option"
          onClick={() => onChange(option.value)}
          title={option.icon ? option.label : undefined}
          aria-label={option.icon ? option.label : undefined}
        >
          {option.icon ? <Icon name={option.icon} size={18} /> : option.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  selected,
  onClick,
  children,
  count,
  removable,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  count?: number;
  removable?: boolean;
}) {
  return (
    <button
      type="button"
      className={`chip ${selected ? 'chip--selected' : ''}`}
      aria-pressed={removable ? undefined : selected}
      onClick={onClick}
    >
      <span>{children}</span>
      {count != null && <span className="chip__count">{count}</span>}
      {removable && <Icon name="close" size={14} />}
    </button>
  );
}

export function StarRating({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="stars" role="radiogroup" aria-label="My rating">
      {[1, 2, 3, 4, 5].map((n) => {
        const active = value != null && n <= value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            className={`stars__star ${active ? 'is-active' : ''}`}
            disabled={disabled}
            onClick={() => onChange(value === n ? null : n)}
          >
            <Icon name={active ? 'starFilled' : 'star'} size={24} />
          </button>
        );
      })}
    </div>
  );
}
