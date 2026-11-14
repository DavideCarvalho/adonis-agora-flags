import type { ReactNode } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/form';

/**
 * What the code owns, shown the way the authkit console shows settings locked by `defineConfig()`:
 * a lock badge, a line saying the code wins and where to change it, and no edit controls.
 */

function LockGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={10}
      height={10}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </svg>
  );
}

/** The lock chip: `defined in code` (a flag declaration) or `config` (config/flags.ts). */
export function ConfigLockBadge({
  children = 'defined in code',
  title = 'Defined in config/flags.ts: managed in code, not editable here',
}: {
  children?: ReactNode;
  title?: string;
}) {
  return (
    <Badge variant="lock" title={title} className="gap-1">
      <LockGlyph />
      {children}
    </Badge>
  );
}

/** The line under a locked block: the code wins, and where to change it. */
export function ConfigLockNote({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-brand">{children}</p>;
}

export interface OverriddenField {
  label: string;
  /** What the console stored (ignored). */
  console: string;
  /** What applies: the code's. */
  code: string;
}

/**
 * Something the console stored that the code now overrides (created here, declared in code since).
 * It is ignored until removed; the fields that differ show what changed when the code took over.
 */
export function OverriddenNotice({
  what,
  fields,
  onRemove,
  removing,
  removeLabel,
}: {
  what: ReactNode;
  fields: OverriddenField[];
  onRemove: () => void;
  removing: boolean;
  removeLabel: string;
}) {
  const differing = fields.filter((f) => f.console !== f.code);
  return (
    <div role="note" className="space-y-2 border-b border-line bg-warn/5 px-4 py-3 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warn">overridden by code</Badge>
        <span className="text-fg-2">{what}</span>
      </div>
      {differing.length > 0 ? (
        <table className="text-[11px]">
          <thead>
            <tr className="text-left text-dim">
              <th className="pr-4 font-normal" />
              <th className="pr-4 font-normal">console (ignored)</th>
              <th className="font-normal">code (applies)</th>
            </tr>
          </thead>
          <tbody>
            {differing.map((f) => (
              <tr key={f.label}>
                <td className="pr-4 text-dim">{f.label}</td>
                <td className="mono pr-4 text-dim line-through">{f.console}</td>
                <td className="mono text-fg-2">{f.code}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-dim">Both say the same; removing the console copy changes nothing.</p>
      )}
      <Button variant="ghost" disabled={removing} onClick={onRemove}>
        {removeLabel}
      </Button>
    </div>
  );
}
