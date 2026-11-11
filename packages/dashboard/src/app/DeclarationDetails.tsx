import { useEffect, useState } from 'react';
import { api, type Declaration } from '../client/flags-client';
import { Notice, useEnv, useWrite } from './env';
import { ErrorBox, Panel } from './shell';
import { Button, Field, Input, Toggle } from './ui/form';

/**
 * The description, owner, expiry, tags and browser exposure of a flag created in the console.
 * Code-declared flags show these read-only in the header: they change in `config/flags.ts`. The
 * type is fixed once created (code reading the flag depends on it).
 */
export function DeclarationDetails({
  flagKey,
  declaration,
}: {
  flagKey: string;
  declaration: Declaration;
}) {
  const { environment } = useEnv();
  const initial = () => ({
    description: declaration.description ?? '',
    owner: declaration.owner ?? '',
    expiresAt: declaration.expiresAt ?? '',
    tags: (declaration.tags ?? []).join(', '),
    client: declaration.client === true,
  });
  const [form, setForm] = useState(initial);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the stored declaration changes.
  useEffect(() => setForm(initial()), [declaration]);
  const save = useWrite(() =>
    api.updateDeclaration(environment, flagKey, {
      description: form.description.trim(),
      owner: form.owner.trim(),
      ...(form.expiresAt ? { expiresAt: form.expiresAt } : {}),
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      client: form.client,
    }),
  );

  return (
    <Panel
      title="Details"
      subtitle="Created in the console. Run `node ace flags:types` in the app to type it."
    >
      <form
        aria-label="Flag details"
        className="grid gap-3 px-4 py-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Field label="Description" className="sm:col-span-2">
          <Input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <Field label="Owner">
          <Input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
        </Field>
        <Field label="Expires">
          <Input
            type="date"
            value={form.expiresAt}
            onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
          />
        </Field>
        <Field label="Tags" hint="Comma-separated">
          <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        </Field>
        <div className="flex items-end pb-1">
          <Toggle
            label="Send to the browser (client)"
            checked={form.client}
            onChange={(client) => setForm({ ...form, client })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
          <Button type="submit" disabled={save.isPending}>
            Save details
          </Button>
          <Notice text={save.notice} />
        </div>
        {save.isError && (
          <div className="sm:col-span-3">
            <ErrorBox error={save.error} />
          </div>
        )}
      </form>
    </Panel>
  );
}
