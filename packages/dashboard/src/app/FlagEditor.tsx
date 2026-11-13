import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type FlagDefinition,
  type FlagDetail,
  type Issue,
  type Serving,
} from '../client/flags-client';
import { DeclarationDetails } from './DeclarationDetails';
import {
  ExperimentEditor,
  OverridesEditor,
  PrerequisitesEditor,
  RulesEditor,
  Section,
  ServeEditor,
  VariantsEditor,
} from './editor-parts';
import { Notice, useEnv, useWrite } from './env';
import { EvaluateTester, HistoryPanel, SchedulesPanel } from './FlagTools';
import { cleanDefinition, isOnOff } from './flag-model';
import { describeServing, formatValue } from './serving';
import { ErrorBox, IssueList, Panel, QueryState } from './shell';
import { Badge } from './ui/badge';
import { Button, Field, Input, Toggle } from './ui/form';

/** One flag: load it, then edit a local draft that is validated live and saved as a whole. */
export function FlagEditor({ flagKey, onClose }: { flagKey: string; onClose: () => void }) {
  const { environment } = useEnv();
  const query = useQuery({
    queryKey: ['flag', environment, flagKey],
    queryFn: () => api.flag(environment, flagKey),
    // The draft is local; refetching underneath an open editor would only fight the person typing.
    refetchInterval: false,
  });
  // Kept here, not in the body: an applied save bumps the version, which remounts the body.
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onClose}>
        ← All flags
      </Button>
      <Notice text={notice} />
      <QueryState query={query} empty={false}>
        {query.data && (
          <EditorBody
            // A new environment or a saved version starts a fresh draft.
            key={`${environment}:${query.data.version}`}
            detail={query.data}
            onDeleted={onClose}
            onNotice={setNotice}
          />
        )}
      </QueryState>
    </div>
  );
}

/** Debounced server validation of the draft (`POST /api/preview`). */
function useLivePreview(environment: string, key: string, draft: FlagDefinition) {
  const [state, setState] = useState<{
    valid: boolean;
    issues: Issue[];
    serving: Serving | null;
  } | null>(null);
  const body = useMemo(() => JSON.stringify(draft), [draft]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api
        .preview(environment, { entity: 'flag', key, value: JSON.parse(body) })
        .then(
          (r) => live && setState({ valid: r.valid, issues: r.issues, serving: r.serving ?? null }),
        )
        .catch(
          (error: unknown) =>
            live &&
            setState({
              valid: false,
              issues: [
                { path: '', message: error instanceof Error ? error.message : 'preview failed' },
              ],
              serving: null,
            }),
        );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [environment, key, body]);
  return state;
}

function EditorBody({
  detail,
  onDeleted,
  onNotice,
}: {
  detail: FlagDetail;
  onDeleted: () => void;
  onNotice: (notice: string) => void;
}) {
  const { environment, meta } = useEnv();
  const [draft, setDraft] = useState<FlagDefinition>(() => structuredClone(detail.definition));
  const [note, setNote] = useState('');
  const clean = useMemo(() => cleanDefinition(draft), [draft]);
  const preview = useLivePreview(environment, detail.key, clean);
  const variants = Object.keys(draft.variants);
  const dirty =
    JSON.stringify(clean) !== JSON.stringify(detail.stored ? cleanDefinition(detail.stored) : null);

  const save = useWrite(
    () => api.saveFlag(environment, detail.key, clean, note || undefined),
    onNotice,
  );
  const remove = useWrite(
    () => api.deleteFlag(environment, detail.key, note || undefined),
    (text) => {
      onNotice(text);
    },
  );
  const declaration = detail.declaration;

  return (
    <div className="space-y-4">
      <Panel
        title={detail.key}
        subtitle={declaration?.description ?? (declaration ? undefined : 'Not declared')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Change note"
              placeholder="Why (optional, shown to approvers)"
              className="w-64"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={!dirty || save.isPending || preview?.valid === false}
              onClick={() => save.mutate(undefined)}
            >
              {detail.requiresApproval ? 'Request change' : 'Save'}
            </Button>
            {detail.stored && (
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(undefined)}
              >
                Remove from ruleset
              </Button>
            )}
          </div>
        }
      >
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line px-4 py-2 text-[11px] text-dim">
          <span>
            environment <span className="text-fg-2">{environment}</span>
          </span>
          {declaration ? (
            <>
              <span>
                type <span className="text-fg-2">{declaration.type}</span>
              </span>
              <span>
                {declaration.source === 'code' ? 'code default' : 'default'}{' '}
                <span className="mono text-fg-2">{formatValue(declaration.default)}</span>
              </span>
              {declaration.owner && (
                <span>
                  owner <span className="text-fg-2">{declaration.owner}</span>
                </span>
              )}
              {declaration.expiresAt && (
                <span>
                  expires <span className="text-fg-2">{declaration.expiresAt}</span>
                </span>
              )}
              {declaration.source === 'console' ? (
                <Badge>created in the console</Badge>
              ) : (
                <span>
                  declared in <span className="text-fg-2">{declaration.apps.join(', ')}</span>
                </span>
              )}
            </>
          ) : (
            <span className="text-warn">
              Nothing declares this flag (no code, no console declaration); evaluations get no
              default.
            </span>
          )}
          <span>
            serving now <span className="text-fg-2">{describeServing(detail.serving)}</span>
          </span>
          {!detail.stored && (
            <Badge variant="type">not in the ruleset yet — saving creates it</Badge>
          )}
        </div>
        {detail.requiresApproval && (
          <p className="border-b border-line px-4 py-2 text-[11px] text-warn">
            {environment} needs a second person: saving files a change request instead of applying
            it.
            {detail.pendingRequests.length > 0 &&
              ` ${detail.pendingRequests.length} request(s) for this flag are pending.`}
          </p>
        )}
        {(save.isError || remove.isError) && <ErrorBox error={save.error ?? remove.error} />}
        {remove.isSuccess && remove.data?.status === 'applied' && (
          <div className="px-4 py-2">
            <Button onClick={onDeleted}>Back to the list</Button>
          </div>
        )}

        <div aria-live="polite" className="border-b border-line px-4 py-2 text-[11px]">
          {preview === null ? (
            <span className="text-dim">Checking…</span>
          ) : preview.valid ? (
            <span className="text-good">
              Valid.
              {preview.serving ? ` Everyone else gets: ${describeServing(preview.serving)}.` : ''}
            </span>
          ) : (
            <div>
              <span className="text-bad">This draft would be refused:</span>
              <IssueList issues={preview.issues} />
            </div>
          )}
        </div>

        <Section
          title="Status"
          hint="Off serves the off variant to everyone, whatever the rules say."
        >
          <div className="flex flex-wrap items-center gap-4">
            <Toggle
              label="Enabled"
              checked={draft.enabled}
              onChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            <span className="text-xs text-dim">
              {draft.enabled ? 'Targeting is live' : 'Killed'}
            </span>
            <Field label="Off variant" className="flex-row items-center gap-2">
              <select
                aria-label="Off variant"
                className="h-[30px] rounded-md border border-input bg-panel-2 px-2.5 text-xs text-fg"
                value={draft.offVariant}
                onChange={(e) => setDraft({ ...draft, offVariant: e.target.value })}
              >
                {variants.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>

        <Section
          title="Variants"
          hint={declaration?.variants ? `Declared: ${declaration.variants.join(', ')}` : undefined}
        >
          <VariantsEditor definition={draft} declaration={declaration} onChange={setDraft} />
        </Section>

        <Section
          title="Overrides"
          hint="Exact targeting keys, checked before any rule (QA, one customer)."
        >
          <OverridesEditor
            overrides={draft.overrides ?? {}}
            variants={variants}
            onChange={(overrides) => setDraft({ ...draft, overrides })}
          />
        </Section>

        <Section
          title="Targeting rules"
          hint="Tried in order; the first rule whose conditions all match decides."
        >
          <RulesEditor
            rules={draft.rules ?? []}
            variants={variants}
            operators={meta?.operators ?? []}
            segments={detail.segments}
            onChange={(rules) => setDraft({ ...draft, rules })}
          />
        </Section>

        <Section title="Everyone else" hint="What is served when no override or rule matches.">
          <ServeEditor
            label="Fallthrough"
            serve={draft.fallthrough}
            variants={variants}
            onChange={(fallthrough) => setDraft({ ...draft, fallthrough })}
          />
        </Section>

        <Section
          title="Prerequisites"
          hint="Other flags that must serve a given variant first; otherwise the off variant is served."
        >
          <PrerequisitesEditor
            prerequisites={draft.prerequisites ?? []}
            flags={detail.flags}
            onChange={(prerequisites) => setDraft({ ...draft, prerequisites })}
          />
        </Section>

        <Section title="Experiment">
          <ExperimentEditor
            definition={draft}
            layers={detail.layers}
            metrics={detail.metrics ?? []}
            configExperiment={detail.configExperiment ?? null}
            onChange={setDraft}
          />
        </Section>

        <Section title="Labels">
          <div className="flex flex-wrap gap-3">
            <Field label="Tags (comma-separated)">
              <Input
                aria-label="Tags"
                className="w-64"
                defaultValue={(draft.tags ?? []).join(', ')}
                onBlur={(e) =>
                  setDraft({
                    ...draft,
                    tags: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter((t) => t !== ''),
                  })
                }
              />
            </Field>
            <Field label="Salt" hint="Changing it reshuffles every bucket">
              <Input
                aria-label="Salt"
                className="mono w-48"
                placeholder={detail.key}
                value={draft.salt ?? ''}
                onChange={(e) => setDraft({ ...draft, salt: e.target.value })}
              />
            </Field>
          </div>
        </Section>
      </Panel>

      {declaration?.source === 'console' && (
        <DeclarationDetails flagKey={detail.key} declaration={declaration} />
      )}

      <Panel
        title="Test a context"
        subtitle="Evaluates this draft, unsaved edits included. Records no exposure."
      >
        <div className="p-4">
          <EvaluateTester environment={environment} flagKey={detail.key} draft={clean} />
        </div>
      </Panel>

      <Panel
        title="Scheduled changes"
        subtitle="Run by the flags worker at the given time; approvals were checked when scheduled."
      >
        <div className="p-4">
          <SchedulesPanel
            environment={environment}
            flagKey={detail.key}
            schedules={detail.schedules}
            onOff={isOnOff(draft)}
          />
        </div>
      </Panel>

      <Panel title="History" subtitle={`Changes to ${detail.key} in ${environment}`}>
        <div className="p-4">
          <HistoryPanel entries={detail.audit} />
        </div>
      </Panel>
    </div>
  );
}
