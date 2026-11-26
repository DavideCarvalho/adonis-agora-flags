import { useEffect, useState } from 'react';
import { ComboMultiSelect, ComboSelect } from '../agora-kit/blocks/combo-field';
import { api, type Declaration } from '../client/flags-client';
import { useFlagFacets } from './catalogs';
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
  const facets = useFlagFacets(environment);
  const initial = () => ({
    description: declaration.description ?? '',
    owner: declaration.owner ?? '',
    expiresAt: declaration.expiresAt ?? '',
    tags: declaration.tags ?? [],
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
      tags: form.tags,
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
          <ComboSelect
            aria-label="Owner"
            options={facets.owners}
            loading={facets.loading}
            creatable
            value={form.owner === '' ? null : form.owner}
            onValueChange={(owner) => setForm({ ...form, owner: owner ?? '' })}
            placeholder="team or person"
          />
        </Field>
        <Field label="Expires">
          <Input
            type="date"
            value={form.expiresAt}
            onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
          />
        </Field>
        <Field label="Tags">
          <ComboMultiSelect
            aria-label="Tags"
            options={facets.tags}
            loading={facets.loading}
            creatable
            value={form.tags}
            onValueChange={(tags) => setForm({ ...form, tags })}
            placeholder="Pick or type a tag"
          />
        </Field>
        <div className="flex items-end pb-1">
          <Toggle
            label="Send to the browser (client)"
            checked={form.client}
            onChange={(client) => setForm({ ...form, client })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
          <Button type="submit" disabled={save.blocked}>
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
