import type {
  AttributeCondition,
  Condition,
  Declaration,
  DefinitionSource,
  FlagDefinition,
  Serve,
  TargetingRule,
} from '../client/flags-client';
import {
  conditionValuesText,
  isSegmentCondition,
  newAttributeCondition,
  nextRuleId,
  parseConditionValues,
  parseVariantValue,
  renameVariant,
  splitPercents,
  toFixed,
  toSplit,
  variantText,
} from './flag-model';
import { Button, Field, Input, Select } from './ui/form';

/** A labelled block inside the editor. */
export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-line px-4 py-3 last:border-b-0">
      <h3 className="text-xs text-fg-2">{title}</h3>
      {hint !== undefined && <p className="mb-2 text-[11px] text-dim">{hint}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

function VariantSelect({
  value,
  variants,
  onChange,
  label,
}: {
  value: string;
  variants: string[];
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!variants.includes(value) && <option value={value}>{value || '(choose)'}</option>}
      {variants.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </Select>
  );
}

/** Variant names and values. Renaming a variant renames every reference to it. */
export function VariantsEditor({
  definition,
  declaration,
  onChange,
}: {
  definition: FlagDefinition;
  declaration: Declaration | null;
  onChange: (next: FlagDefinition) => void;
}) {
  const entries = Object.entries(definition.variants);
  const type = declaration?.type;
  return (
    <>
      {entries.map(([name, value], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with editable names; a name key would remount the input being typed into.
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Variant ${i + 1} name`}
            className="mono w-36"
            value={name}
            onChange={(e) => onChange(renameVariant(definition, name, e.target.value))}
          />
          <Input
            aria-label={`Variant ${name} value`}
            className="mono min-w-0 flex-1"
            value={variantText(value)}
            onChange={(e) =>
              onChange({
                ...definition,
                variants: {
                  ...definition.variants,
                  [name]: parseVariantValue(e.target.value, type),
                },
              })
            }
          />
          <Button
            variant="ghost"
            aria-label={`Remove variant ${name}`}
            disabled={entries.length <= 1}
            onClick={() => {
              const variants = { ...definition.variants };
              delete variants[name];
              onChange({ ...definition, variants });
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        onClick={() => {
          let n = entries.length + 1;
          while (Object.hasOwn(definition.variants, `variant_${n}`)) n += 1;
          const name =
            declaration?.variants?.find((v) => !Object.hasOwn(definition.variants, v)) ??
            `variant_${n}`;
          const value =
            type === 'string' ? name : type === 'number' ? 0 : type === 'boolean' ? false : null;
          onChange({ ...definition, variants: { ...definition.variants, [name]: value } });
        }}
      >
        Add variant
      </Button>
    </>
  );
}

/** A fixed variant or a weighted split (with `bucketBy`). */
export function ServeEditor({
  serve,
  variants,
  onChange,
  label,
}: {
  serve: Serve;
  variants: string[];
  onChange: (serve: Serve) => void;
  label: string;
}) {
  const mode = 'split' in serve ? 'split' : 'fixed';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Select
          aria-label={`${label} mode`}
          value={mode}
          onChange={(e) =>
            onChange(
              e.target.value === 'split' ? toSplit(serve, variants) : toFixed(serve, variants),
            )
          }
        >
          <option value="fixed">Serve one variant</option>
          <option value="split">Split by weight</option>
        </Select>
        {'variant' in serve && (
          <VariantSelect
            label={`${label} variant`}
            value={serve.variant}
            variants={variants}
            onChange={(variant) => onChange({ variant })}
          />
        )}
      </div>
      {'split' in serve && (
        <div className="space-y-1">
          {serve.split.map((arm, i) => {
            const percents = splitPercents(serve.split);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with editable names; a name key would remount the input being typed into.
              <div key={i} className="flex flex-wrap items-center gap-2">
                <VariantSelect
                  label={`${label} arm ${i + 1} variant`}
                  value={arm.variant}
                  variants={variants}
                  onChange={(variant) =>
                    onChange({
                      ...serve,
                      split: serve.split.map((a, j) => (j === i ? { ...a, variant } : a)),
                    })
                  }
                />
                <Input
                  aria-label={`${label} arm ${i + 1} weight`}
                  type="number"
                  min={0}
                  className="w-24"
                  value={arm.weight}
                  onChange={(e) =>
                    onChange({
                      ...serve,
                      split: serve.split.map((a, j) =>
                        j === i ? { ...a, weight: Number(e.target.value) } : a,
                      ),
                    })
                  }
                />
                <span className="mono w-16 text-[11px] text-dim">{percents[i]}%</span>
                <Button
                  variant="ghost"
                  disabled={serve.split.length <= 1}
                  onClick={() =>
                    onChange({ ...serve, split: serve.split.filter((_, j) => j !== i) })
                  }
                >
                  Remove
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() =>
                onChange({
                  ...serve,
                  split: [...serve.split, { variant: variants[0] ?? '', weight: 0 }],
                })
              }
            >
              Add arm
            </Button>
            <Input
              aria-label={`${label} bucket by`}
              placeholder="bucket by (default: targeting key)"
              className="w-64"
              value={serve.bucketBy ?? ''}
              onChange={(e) => {
                const { bucketBy: _drop, ...rest } = serve;
                onChange(e.target.value === '' ? rest : { ...rest, bucketBy: e.target.value });
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ConditionEditor({
  condition,
  operators,
  segments,
  onChange,
  onRemove,
  label,
}: {
  condition: Condition;
  operators: string[];
  segments: string[];
  onChange: (c: Condition) => void;
  onRemove: () => void;
  label: string;
}) {
  const segment = isSegmentCondition(condition);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line-soft p-2">
      <Select
        aria-label={`${label} kind`}
        value={segment ? 'segment' : 'attribute'}
        onChange={(e) =>
          onChange(
            e.target.value === 'segment'
              ? { segment: segments[0] ?? '', ...(condition.negate ? { negate: true } : {}) }
              : newAttributeCondition(),
          )
        }
      >
        <option value="attribute">Attribute</option>
        <option value="segment">Segment</option>
      </Select>
      {segment ? (
        <Select
          aria-label={`${label} segment`}
          value={condition.segment}
          onChange={(e) => onChange({ ...condition, segment: e.target.value })}
        >
          {!segments.includes(condition.segment) && (
            <option value={condition.segment}>{condition.segment || '(choose)'}</option>
          )}
          {segments.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      ) : (
        <AttributeFields
          condition={condition}
          operators={operators}
          onChange={onChange}
          label={label}
        />
      )}
      <label className="inline-flex items-center gap-1 text-[11px] text-dim">
        <input
          type="checkbox"
          checked={condition.negate === true}
          onChange={(e) => {
            const { negate: _drop, ...rest } = condition;
            onChange(e.target.checked ? { ...rest, negate: true } : rest);
          }}
        />
        negate
      </label>
      <Button variant="ghost" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

export function AttributeFields({
  condition,
  operators,
  onChange,
  label,
}: {
  condition: AttributeCondition;
  operators: string[];
  onChange: (c: AttributeCondition) => void;
  label: string;
}) {
  return (
    <>
      <Input
        aria-label={`${label} attribute`}
        placeholder="attribute (e.g. email, plan, targetingKey)"
        className="mono w-48"
        value={condition.attribute}
        onChange={(e) => onChange({ ...condition, attribute: e.target.value })}
      />
      <Select
        aria-label={`${label} operator`}
        value={condition.op}
        onChange={(e) => {
          const op = e.target.value;
          const { values: _drop, ...rest } = condition;
          onChange(op === 'exists' ? { ...rest, op } : { ...condition, op });
        }}
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </Select>
      {condition.op !== 'exists' && (
        <Input
          aria-label={`${label} values`}
          placeholder="values, comma-separated"
          className="mono min-w-0 flex-1"
          defaultValue={conditionValuesText(condition.values)}
          onBlur={(e) =>
            onChange({ ...condition, values: parseConditionValues(e.target.value, condition.op) })
          }
        />
      )}
    </>
  );
}

/** Targeting rules, tried in order; the first whose conditions ALL match decides. */
export function RulesEditor({
  rules,
  variants,
  operators,
  segments,
  onChange,
}: {
  rules: TargetingRule[];
  variants: string[];
  operators: string[];
  segments: string[];
  onChange: (rules: TargetingRule[]) => void;
}) {
  const update = (i: number, rule: TargetingRule) =>
    onChange(rules.map((r, j) => (j === i ? rule : r)));
  const move = (i: number, by: number) => {
    const next = [...rules];
    const [rule] = next.splice(i, 1);
    if (rule) next.splice(i + by, 0, rule);
    onChange(next);
  };
  return (
    <>
      {rules.map((rule, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with editable names; a name key would remount the input being typed into.
          key={i}
          className="space-y-2 rounded-md border border-line p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[11px] text-dim">#{i + 1}</span>
            <Field label="Rule id" className="flex-row items-center gap-2">
              <Input
                aria-label={`Rule ${i + 1} id`}
                className="mono w-40"
                value={rule.id}
                onChange={(e) => update(i, { ...rule, id: e.target.value })}
              />
            </Field>
            <span className="ml-auto flex gap-1">
              <Button variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>
                Up
              </Button>
              <Button variant="ghost" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>
                Down
              </Button>
              <Button variant="danger" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                Delete rule
              </Button>
            </span>
          </div>
          <p className="text-[11px] text-dim">When all of these match:</p>
          {rule.conditions.map((condition, j) => (
            <ConditionEditor
              // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with editable names; a name key would remount the input being typed into.
              key={j}
              label={`Rule ${i + 1} condition ${j + 1}`}
              condition={condition}
              operators={operators}
              segments={segments}
              onChange={(c) =>
                update(i, { ...rule, conditions: rule.conditions.map((x, k) => (k === j ? c : x)) })
              }
              onRemove={() =>
                update(i, { ...rule, conditions: rule.conditions.filter((_, k) => k !== j) })
              }
            />
          ))}
          <Button
            onClick={() =>
              update(i, { ...rule, conditions: [...rule.conditions, newAttributeCondition()] })
            }
          >
            Add condition
          </Button>
          <p className="text-[11px] text-dim">Serve:</p>
          <ServeEditor
            label={`Rule ${i + 1} serve`}
            serve={rule.serve}
            variants={variants}
            onChange={(serve) => update(i, { ...rule, serve })}
          />
        </div>
      ))}
      <Button
        onClick={() =>
          onChange([
            ...rules,
            {
              id: nextRuleId(rules),
              conditions: [newAttributeCondition()],
              serve: { variant: variants[0] ?? '' },
            },
          ])
        }
      >
        Add rule
      </Button>
    </>
  );
}

/** Exact targeting key → variant, checked before every rule. */
export function OverridesEditor({
  overrides,
  variants,
  onChange,
}: {
  overrides: Record<string, string>;
  variants: string[];
  onChange: (overrides: Record<string, string>) => void;
}) {
  const entries = Object.entries(overrides);
  return (
    <>
      {entries.map(([subject, variant], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with editable names; a name key would remount the input being typed into.
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Override ${i + 1} subject`}
            className="mono w-56"
            value={subject}
            onChange={(e) => {
              const next = Object.fromEntries(
                entries.map(([s, v]) => (s === subject ? [e.target.value, v] : [s, v])),
              );
              onChange(next);
            }}
          />
          <VariantSelect
            label={`Override ${i + 1} variant`}
            value={variant}
            variants={variants}
            onChange={(v) => onChange({ ...overrides, [subject]: v })}
          />
          <Button
            variant="ghost"
            onClick={() => onChange(Object.fromEntries(entries.filter(([s]) => s !== subject)))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        onClick={() => {
          let n = entries.length + 1;
          while (Object.hasOwn(overrides, `subject-${n}`)) n += 1;
          onChange({ ...overrides, [`subject-${n}`]: variants[0] ?? '' });
        }}
      >
        Add override
      </Button>
    </>
  );
}

/** Other flags that must resolve to a variant first. */
export function PrerequisitesEditor({
  prerequisites,
  flags,
  onChange,
}: {
  prerequisites: Array<{ flag: string; variant: string }>;
  flags: Record<string, string[]>;
  onChange: (next: Array<{ flag: string; variant: string }>) => void;
}) {
  const keys = Object.keys(flags).sort();
  return (
    <>
      {prerequisites.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with editable names; a name key would remount the input being typed into.
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={`Prerequisite ${i + 1} flag`}
            value={p.flag}
            onChange={(e) =>
              onChange(
                prerequisites.map((x, j) =>
                  j === i ? { flag: e.target.value, variant: flags[e.target.value]?.[0] ?? '' } : x,
                ),
              )
            }
          >
            {!keys.includes(p.flag) && <option value={p.flag}>{p.flag || '(choose)'}</option>}
            {keys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <span className="text-[11px] text-dim">must serve</span>
          <VariantSelect
            label={`Prerequisite ${i + 1} variant`}
            value={p.variant}
            variants={flags[p.flag] ?? []}
            onChange={(variant) =>
              onChange(prerequisites.map((x, j) => (j === i ? { ...x, variant } : x)))
            }
          />
          <Button variant="ghost" onClick={() => onChange(prerequisites.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <Button
        disabled={keys.length === 0}
        onClick={() => {
          const flag = keys[0] ?? '';
          onChange([...prerequisites, { flag, variant: flags[flag]?.[0] ?? '' }]);
        }}
      >
        Add prerequisite
      </Button>
    </>
  );
}

/**
 * Marks the flag as an experiment: exposures, a mutual-exclusion layer, the holdout opt-out, and
 * the analysis (metrics, guardrails, control, confidence) the worker computes results with.
 */
export function ExperimentEditor({
  definition,
  layers,
  metrics = [],
  configExperiment = null,
  onChange,
}: {
  definition: FlagDefinition;
  layers: string[];
  metrics?: Array<{ name: string; source: DefinitionSource }>;
  configExperiment?: string | null;
  onChange: (next: FlagDefinition) => void;
}) {
  const experiment = definition.experiment;
  return (
    <>
      <label className="inline-flex items-center gap-2 text-xs text-fg-2">
        <input
          type="checkbox"
          checked={experiment !== undefined}
          onChange={(e) => {
            if (e.target.checked) onChange({ ...definition, experiment: {} });
            else {
              const { experiment: _drop, ...rest } = definition;
              onChange(rest);
            }
          }}
        />
        This flag is an experiment (split assignments are recorded as exposures)
      </label>
      {experiment !== undefined && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Experiment key" hint="Defaults to the flag key">
            <Input
              aria-label="Experiment key"
              className="mono w-48"
              value={experiment.key ?? ''}
              onChange={(e) =>
                onChange({ ...definition, experiment: { ...experiment, key: e.target.value } })
              }
            />
          </Field>
          <Field label="Layer" hint="Experiments in one layer never share a subject">
            <Select
              aria-label="Layer"
              value={experiment.layer ?? ''}
              onChange={(e) =>
                onChange({ ...definition, experiment: { ...experiment, layer: e.target.value } })
              }
            >
              <option value="">No layer</option>
              {layers.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <label className="inline-flex items-center gap-2 pb-1 text-xs text-fg-2">
            <input
              type="checkbox"
              checked={experiment.holdout !== false}
              onChange={(e) =>
                onChange({
                  ...definition,
                  experiment: { ...experiment, holdout: e.target.checked },
                })
              }
            />
            Honour the global holdout
          </label>
        </div>
      )}
      {experiment !== undefined && (
        <ExperimentAnalysis
          definition={definition}
          metrics={metrics}
          configExperiment={configExperiment}
          onChange={onChange}
        />
      )}
    </>
  );
}

type Experiment = NonNullable<FlagDefinition['experiment']>;

function ExperimentAnalysis({
  definition,
  metrics,
  configExperiment,
  onChange,
}: {
  definition: FlagDefinition;
  metrics: Array<{ name: string; source: DefinitionSource }>;
  configExperiment: string | null;
  onChange: (next: FlagDefinition) => void;
}) {
  const experiment: Experiment = definition.experiment ?? {};
  if (configExperiment !== null) {
    return (
      <p className="text-[11px] text-dim">
        Analysed by experiment <span className="mono">{configExperiment}</span> in config/flags.ts,
        which takes precedence over the metrics picked here.
      </p>
    );
  }
  type Patch = { [K in keyof Experiment]?: Experiment[K] | undefined };
  const set = (patch: Patch) => {
    const merged: Patch = { ...experiment, ...patch };
    for (const field of Object.keys(merged) as Array<keyof Experiment>) {
      if (merged[field] === undefined) delete merged[field];
    }
    const next = merged as Experiment;
    onChange({ ...definition, experiment: next });
  };
  const toggle = (list: 'metrics' | 'guardrails', name: string, on: boolean) => {
    const current = experiment[list] ?? [];
    const next = on ? [...current, name] : current.filter((n) => n !== name);
    // A metric either decides the experiment or guards it, not both.
    const other = list === 'metrics' ? 'guardrails' : 'metrics';
    const rest = (experiment[other] ?? []).filter((n) => n !== name);
    set({
      [list]: next.length > 0 ? next : undefined,
      ...(on ? { [other]: rest.length > 0 ? rest : undefined } : {}),
    } as Patch);
  };
  const confidence = experiment.confidence;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-dim">
        Analysis — the metrics that decide this experiment and the guardrails that must not regress.
      </p>
      {metrics.length === 0 ? (
        <p className="text-[11px] text-dim">No metrics yet. Create one on the Metrics screen.</p>
      ) : (
        <table className="text-xs">
          <thead>
            <tr className="text-[11px] text-dim">
              <th className="pr-4 text-left font-normal">Metric</th>
              <th className="pr-4 font-normal">Decides</th>
              <th className="font-normal">Guardrail</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.name}>
                <td className="mono pr-4 text-fg">
                  {m.name}
                  {m.source === 'config' && (
                    <span className="ml-1 text-[10px] text-dim">config</span>
                  )}
                </td>
                <td className="pr-4 text-center">
                  <input
                    type="checkbox"
                    aria-label={`${m.name} decides`}
                    checked={(experiment.metrics ?? []).includes(m.name)}
                    onChange={(e) => toggle('metrics', m.name, e.target.checked)}
                  />
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    aria-label={`${m.name} guardrail`}
                    checked={(experiment.guardrails ?? []).includes(m.name)}
                    onChange={(e) => toggle('guardrails', m.name, e.target.checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Control variant" hint="Defaults to the off variant">
          <Select
            aria-label="Control variant"
            value={experiment.control ?? ''}
            onChange={(e) => set({ control: e.target.value || undefined })}
          >
            <option value="">Off variant ({definition.offVariant})</option>
            {Object.keys(definition.variants).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Confidence (%)" hint="Default 95">
          <Input
            aria-label="Confidence"
            type="number"
            min={50}
            max={99.9}
            step={0.1}
            className="w-24"
            value={confidence === undefined ? '' : String(Math.round(confidence * 1000) / 10)}
            onChange={(e) =>
              set({ confidence: e.target.value === '' ? undefined : Number(e.target.value) / 100 })
            }
          />
        </Field>
      </div>
    </div>
  );
}
