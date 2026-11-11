import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn';

/** The console's few form primitives. Plain elements with the shared look — no component library. */

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

const BUTTON: Record<ButtonVariant, string> = {
  default: 'border-line bg-panel-2 text-zinc-200 enabled:hover:border-zinc-600',
  primary: 'border-brand/45 bg-brand/15 text-brand enabled:hover:bg-brand/25',
  danger: 'border-bad/40 bg-bad/10 text-rose-300 enabled:hover:bg-bad/20',
  ghost: 'border-transparent text-zinc-400 enabled:hover:bg-panel-2 enabled:hover:text-zinc-200',
};

export function Button({
  variant = 'default',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs transition-colors disabled:opacity-40',
        BUTTON[variant],
        className,
      )}
      {...props}
    />
  );
}

const FIELD =
  'rounded-sm border border-line bg-background px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-brand/60 focus:outline-none';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD, className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className={cn(FIELD, 'pr-6', className)} {...props}>
      {children}
    </select>
  );
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD, 'mono w-full', className)} {...props} />;
}

/** A label above a control. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child.
    <label className={cn('flex flex-col gap-1 text-[11px] text-zinc-500', className)}>
      <span>{label}</span>
      {children}
      {hint !== undefined && <span className="text-[10px] text-zinc-600">{hint}</span>}
    </label>
  );
}

/** An on/off switch with a real checkbox underneath (keyboard and screen readers just work). */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className={cn(
          'relative h-4 w-7 rounded-full border transition-colors peer-disabled:opacity-40 peer-focus-visible:ring-1 peer-focus-visible:ring-brand',
          checked ? 'border-good/50 bg-good/30' : 'border-line bg-panel-2',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all',
            checked ? 'left-3.5 bg-good' : 'left-0.5 bg-zinc-500',
          )}
        />
      </span>
    </label>
  );
}
