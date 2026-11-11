import type { DeclarationInput } from '../client/flags-client';

/** The "New flag" form, as typed by a person. */
export interface NewFlagForm {
  key: string;
  type: DeclarationInput['type'];
  /** Raw text: `true`/`false`, a number, a string, or JSON — parsed per type. */
  defaultValue: string;
  /** Comma-separated variant names (string flags). */
  variants: string;
  description: string;
  owner: string;
  expiresAt: string;
  tags: string;
  client: boolean;
}

export const EMPTY_NEW_FLAG: NewFlagForm = {
  key: '',
  type: 'boolean',
  defaultValue: 'false',
  variants: '',
  description: '',
  owner: '',
  expiresAt: '',
  tags: '',
  client: false,
};

const list = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/**
 * Turns the form into a declaration, or explains what is wrong. Pure, so the screen and its spec
 * agree; the server validates again.
 */
export function toDeclaration(
  form: NewFlagForm,
): { ok: true; key: string; declaration: DeclarationInput } | { ok: false; error: string } {
  const key = form.key.trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) {
    return { ok: false, error: 'Key: letters, digits, ".", "_" or "-".' };
  }
  let value: DeclarationInput['default'];
  const raw = form.defaultValue.trim();
  if (form.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false')
      return { ok: false, error: 'Default must be true or false.' };
    value = raw === 'true';
  } else if (form.type === 'number') {
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) return { ok: false, error: 'Default must be a number.' };
    value = n;
  } else if (form.type === 'json') {
    try {
      value = JSON.parse(raw === '' ? 'null' : raw);
    } catch {
      return { ok: false, error: 'Default must be valid JSON.' };
    }
  } else {
    value = raw;
  }
  const variants = form.type === 'string' ? list(form.variants) : [];
  if (variants.length > 0 && !variants.includes(String(value))) {
    return { ok: false, error: 'The default must be one of the variants.' };
  }
  const tags = list(form.tags);
  return {
    ok: true,
    key,
    declaration: {
      type: form.type,
      default: value,
      ...(variants.length > 0 ? { variants } : {}),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      ...(form.owner.trim() ? { owner: form.owner.trim() } : {}),
      ...(form.expiresAt ? { expiresAt: form.expiresAt } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(form.client ? { client: true } : {}),
    },
  };
}

/** A sensible default value when the type changes. */
export function defaultFor(type: DeclarationInput['type']): string {
  if (type === 'boolean') return 'false';
  if (type === 'number') return '0';
  if (type === 'json') return '{}';
  return '';
}
