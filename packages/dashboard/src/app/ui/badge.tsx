import type { ComponentProps } from 'react';
import { cn } from '../../agora-kit/lib/utils';
import { Badge as KitBadge } from '../../agora-kit/ui/badge';

/**
 * A non-interactive label chip, on the kit's badge (authkit's 18px mono pill). The variant names
 * are the ones the screens already use:
 *
 * - `outline` — a neutral tag (a flag tag, an owner);
 * - `provider` / `type` — provenance and kind (`experiment`, `console`);
 * - `danger` — something that needs acting on (a stale reason);
 * - `status` — colourless on purpose: the hue comes from the caller's `s-<status>` class in
 *   `index.css`, the single place status colour is defined.
 */
const VARIANT = {
  outline: 'neutral',
  provider: 'info',
  type: 'violet',
  danger: 'destructive',
  status: 'bare',
} as const;

export function Badge({
  variant = 'outline',
  className,
  ...props
}: Omit<ComponentProps<'span'>, 'ref'> & { variant?: keyof typeof VARIANT | null | undefined }) {
  return <KitBadge variant={VARIANT[variant ?? 'outline']} className={cn(className)} {...props} />;
}
