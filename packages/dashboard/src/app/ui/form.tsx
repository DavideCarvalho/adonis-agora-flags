import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../agora-kit/lib/utils';
import { Button as KitButton } from '../../agora-kit/ui/button';

/**
 * The console's form primitives. `Button` is the kit's (shadcn on Base UI) under the four names the
 * screens use; the fields are plain elements with the kit's input look, so native `<select>` and
 * `<input>` keep working with every browser feature (autofill, keyboard, screen readers).
 */

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

const VARIANT = {
  default: 'outline',
  primary: 'default',
  danger: 'destructive',
  ghost: 'ghost',
} as const;

export function Button({
  variant = 'default',
  className,
  type = 'button',
  ...props
}: Omit<React.ComponentProps<typeof KitButton>, 'variant' | 'size'> & {
  variant?: ButtonVariant;
  type?: 'button' | 'submit' | 'reset';
}) {
  return (
    <KitButton
      type={type}
      variant={VARIANT[variant]}
      size="sm"
      className={cn(variant === 'danger' && 'border-bad/25', className)}
      {...props}
    />
  );
}

const FIELD =
  'h-[30px] rounded-md border border-input bg-panel-2 px-2.5 text-xs text-fg transition-colors placeholder:text-faint hover:border-line-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50';

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
  return <textarea className={cn(FIELD, 'mono h-auto w-full py-1.5', className)} {...props} />;
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
    <label className={cn('flex flex-col gap-1 text-[11px] font-medium text-dim', className)}>
      <span>{label}</span>
      {children}
      {hint !== undefined && <span className="text-[10px] font-normal text-faint">{hint}</span>}
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
          'relative h-[18px] w-8 rounded-full border transition-colors peer-disabled:opacity-40 peer-focus-visible:ring-3 peer-focus-visible:ring-ring/40',
          checked ? 'border-good/40 bg-good/25' : 'border-border bg-panel-3',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] size-3 rounded-full transition-all',
            checked ? 'left-[15px] bg-good' : 'left-[2px] bg-faint',
          )}
        />
      </span>
    </label>
  );
}
