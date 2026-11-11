import { useState } from 'react';
import { api } from '../client/flags-client';
import { Notice, useEnv, useWrite } from './env';
import { defaultFor, EMPTY_NEW_FLAG, type NewFlagForm, toDeclaration } from './new-flag';
import { ErrorBox } from './shell';
import { Button, Field, Input, Select, Toggle } from './ui/form';

/**
 * Creates a flag without touching code: its type, default and metadata are stored with the
 * ruleset, so every process serves the default from the moment it is saved. `node ace flags:types`
 * types it in the app afterwards.
 */
export function NewFlag({
  onCreated,
  onCancel,
}: {
  onCreated: (key: string) => void;
  onCancel: () => void;
}) {
  const { environment } = useEnv();
  const [form, setForm] = useState<NewFlagForm>(EMPTY_NEW_FLAG);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof NewFlagForm>(field: K, value: NewFlagForm[K]) =>
    setForm((current) => ({ ...current, [field]: value }));
  const create = useWrite(
    (input: { key: string; declaration: Parameters<typeof api.createFlag>[2] }) =>
      api.createFlag(environment, input.key, input.declaration),
  );

  const submit = () => {
    const parsed = toDeclaration(form);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    create.mutate(
      { key: parsed.key, declaration: parsed.declaration },
      {
        onSuccess: (result) => {
          if (result.status === 'applied') onCreated(parsed.key);
        },
      },
    );
  };

  return (
    <form
      aria-label="New flag"
      className="grid gap-3 border-b border-line bg-panel-2/40 px-4 py-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field label="Key" hint="Letters, digits, . _ -">
        <Input
          autoFocus
          value={form.key}
          onChange={(e) => set('key', e.target.value)}
          placeholder="promo_banner"
          className="mono"
        />
      </Field>
      <Field label="Type">
        <Select
          value={form.type}
          onChange={(e) => {
            const type = e.target.value as NewFlagForm['type'];
            setForm((current) => ({ ...current, type, defaultValue: defaultFor(type) }));
          }}
        >
          <option value="boolean">boolean (on/off)</option>
          <option value="string">string (variants)</option>
          <option value="number">number</option>
          <option value="json">json</option>
        </Select>
      </Field>
      <Field
        label="Default"
        hint="Served when nothing else answers (and to everyone until you target it)"
      >
        {form.type === 'boolean' ? (
          <Select value={form.defaultValue} onChange={(e) => set('defaultValue', e.target.value)}>
            <option value="false">false</option>
            <option value="true">true</option>
          </Select>
        ) : (
          <Input
            value={form.defaultValue}
            onChange={(e) => set('defaultValue', e.target.value)}
            className="mono"
          />
        )}
      </Field>
      {form.type === 'string' && (
        <Field
          label="Variants"
          hint="Comma-separated; the default must be one of them"
          className="sm:col-span-3"
        >
          <Input
            value={form.variants}
            onChange={(e) => set('variants', e.target.value)}
            placeholder="control, one_page"
            className="mono"
          />
        </Field>
      )}
      <Field label="Description" className="sm:col-span-2">
        <Input value={form.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <Field label="Owner">
        <Input
          value={form.owner}
          onChange={(e) => set('owner', e.target.value)}
          placeholder="team or person"
        />
      </Field>
      <Field label="Expires" hint="Listed as stale after this date">
        <Input
          type="date"
          value={form.expiresAt}
          onChange={(e) => set('expiresAt', e.target.value)}
        />
      </Field>
      <Field label="Tags" hint="Comma-separated">
        <Input value={form.tags} onChange={(e) => set('tags', e.target.value)} />
      </Field>
      <div className="flex items-end pb-1">
        <Toggle
          label="Send to the browser (client)"
          checked={form.client}
          onChange={(client) => set('client', client)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create flag'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {error !== null && (
          <p role="alert" className="text-[11px] text-rose-300">
            {error}
          </p>
        )}
        <Notice text={create.notice} />
      </div>
      {create.isError && (
        <div className="sm:col-span-3">
          <ErrorBox error={create.error} />
        </div>
      )}
    </form>
  );
}
