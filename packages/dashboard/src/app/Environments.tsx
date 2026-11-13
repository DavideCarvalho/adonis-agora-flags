import { useState } from 'react';
import { api } from '../client/flags-client';
import { Notice, useEnv, useWrite } from './env';
import { ErrorBox, Panel } from './shell';
import { Button, Field, Input, Select, TextArea } from './ui/form';

/** Download a JSON value as a file (no server round trip beyond the read). */
function download(name: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export, import and promote: moving a whole ruleset between environments. */
export function Environments() {
  const { environment, meta } = useEnv();
  const environments = meta?.environments ?? [environment];
  const [exportError, setExportError] = useState<unknown>(null);
  const [json, setJson] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [from, setFrom] = useState(environments.find((e) => e !== environment) ?? environment);
  const [to, setTo] = useState(environment);

  const importIt = useWrite((ruleset: unknown) =>
    api.importRuleset(environment, ruleset, note || undefined),
  );
  const promoteIt = useWrite(() => api.promote(from, to, note || undefined));

  return (
    <div className="space-y-4">
      <Panel
        title="Export"
        subtitle={`Download ${environment}'s ruleset as JSON (flags, segments, layers, holdout).`}
      >
        <div className="flex flex-wrap items-center gap-2 p-4">
          <Button
            onClick={async () => {
              try {
                setExportError(null);
                download(`flags-${environment}.json`, await api.exportRuleset(environment));
              } catch (error) {
                setExportError(error);
              }
            }}
          >
            Download {environment}.json
          </Button>
          {exportError !== null && <ErrorBox error={exportError} />}
        </div>
      </Panel>

      <Panel
        title="Import"
        subtitle={`Replaces EVERY flag, segment and layer in ${environment} with the file's.`}
      >
        <div className="space-y-2 p-4">
          <Input
            aria-label="Ruleset file"
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setJson(await file.text());
            }}
          />
          <TextArea
            aria-label="Ruleset JSON"
            rows={8}
            placeholder='{ "flags": { … } }'
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Import note"
              placeholder="Why (optional)"
              className="w-64"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="danger"
              disabled={json.trim() === '' || importIt.isPending}
              onClick={() => {
                try {
                  const parsed: unknown = JSON.parse(json);
                  setParseError(null);
                  importIt.mutate(parsed);
                } catch {
                  setParseError('That is not valid JSON.');
                }
              }}
            >
              Import into {environment}
            </Button>
          </div>
          {parseError !== null && <p className="text-xs text-bad">{parseError}</p>}
          {importIt.isError && <ErrorBox error={importIt.error} />}
          <Notice text={importIt.notice} />
        </div>
      </Panel>

      <Panel
        title="Promote"
        subtitle="Copy one environment's ruleset over another's (staging → production). Approvals of the target apply."
      >
        <div className="flex flex-wrap items-end gap-2 p-4">
          <Field label="From">
            <Select
              aria-label="Promote from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            >
              {environments.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="To">
            <Input
              aria-label="Promote to"
              list="flags-environments"
              className="w-40"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <datalist id="flags-environments">
              {environments.map((e) => (
                <option key={e} value={e} />
              ))}
            </datalist>
          </Field>
          <Button
            variant="danger"
            disabled={from === to || to === '' || promoteIt.isPending}
            onClick={() => promoteIt.mutate(undefined)}
          >
            Promote {from} → {to}
          </Button>
        </div>
        <div className="px-4 pb-4">
          {promoteIt.isError && <ErrorBox error={promoteIt.error} />}
          <Notice text={promoteIt.notice} />
        </div>
      </Panel>
    </div>
  );
}
