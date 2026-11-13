import type {
  AttributeCondition,
  Condition,
  ConditionValue,
  Declaration,
  FlagDefinition,
  JsonValue,
  Serve,
} from '../client/flags-client';

/**
 * The editor's pure helpers: turning what is typed into ruleset JSON and back. Kept out of the
 * component so the conversions — the part that silently corrupts a flag when wrong — are tested.
 */

/** Read a variant value typed into a text box, by the type the code declares. */
export function parseVariantValue(text: string, type: Declaration['type'] | undefined): JsonValue {
  const trimmed = text.trim();
  if (type === 'string') return text;
  if (type === 'number') {
    const n = Number(trimmed);
    return trimmed !== '' && Number.isFinite(n) ? n : text;
  }
  if (type === 'boolean') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    return text;
  }
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return text;
  }
}

/** A variant value as the editor's text box shows it. */
export function variantText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

/** `"a, b"` → `['a', 'b']`; numbers for the numeric operators. */
export function parseConditionValues(text: string, op: string): ConditionValue[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      if (NUMERIC_OPS.has(op)) {
        const n = Number(part);
        return Number.isFinite(n) ? n : part;
      }
      if (part === 'true') return true;
      if (part === 'false') return false;
      return part;
    });
}

export function conditionValuesText(values: ConditionValue[] | undefined): string {
  return (values ?? []).map(String).join(', ');
}

export function isSegmentCondition(
  condition: Condition,
): condition is { segment: string; negate?: boolean } {
  return 'segment' in condition;
}

export function newAttributeCondition(): AttributeCondition {
  return { attribute: '', op: 'in', values: [] };
}

/** A rule id not used yet (`rule-1`, `rule-2`, …): ids are reported as `ruleId` and must be unique. */
export function nextRuleId(existing: Array<{ id: string }>): string {
  const used = new Set(existing.map((rule) => rule.id));
  let n = existing.length + 1;
  while (used.has(`rule-${n}`)) n += 1;
  return `rule-${n}`;
}

/** Split weights as percentages of their total (weights are relative). */
export function splitPercents(split: Array<{ weight: number }>): number[] {
  const total = split.reduce((sum, arm) => sum + Math.max(0, arm.weight), 0);
  return split.map((arm) =>
    total > 0 ? Math.round((Math.max(0, arm.weight) / total) * 10000) / 100 : 0,
  );
}

/** Switch a serve between fixed and split without losing the variant names. */
export function toSplit(serve: Serve, variants: string[]): Serve {
  if ('split' in serve) return serve;
  const names = variants.length > 0 ? variants : [serve.variant];
  return {
    split: names.map((variant) => ({ variant, weight: variant === serve.variant ? 100 : 0 })),
  };
}

export function toFixed(serve: Serve, variants: string[]): Serve {
  if ('variant' in serve) return serve;
  const heaviest = [...serve.split].sort((a, b) => b.weight - a.weight)[0];
  return { variant: heaviest?.variant ?? variants[0] ?? '' };
}

/** Rename a variant everywhere the definition names it (off variant, serves, overrides). */
export function renameVariant(
  definition: FlagDefinition,
  from: string,
  to: string,
): FlagDefinition {
  if (from === to) return definition;
  const swap = (name: string) => (name === from ? to : name);
  const serve = (s: Serve): Serve =>
    'variant' in s
      ? { variant: swap(s.variant) }
      : { ...s, split: s.split.map((arm) => ({ ...arm, variant: swap(arm.variant) })) };
  const variants: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(definition.variants)) variants[swap(name)] = value;
  return {
    ...definition,
    variants,
    offVariant: swap(definition.offVariant),
    fallthrough: serve(definition.fallthrough),
    ...(definition.rules
      ? { rules: definition.rules.map((rule) => ({ ...rule, serve: serve(rule.serve) })) }
      : {}),
    ...(definition.overrides
      ? {
          overrides: Object.fromEntries(
            Object.entries(definition.overrides).map(([k, v]) => [k, swap(v)]),
          ),
        }
      : {}),
  };
}

/** Drop empty optional parts so a save does not record `rules: []` noise in the audit trail. */
export function cleanDefinition(definition: FlagDefinition): FlagDefinition {
  const out: FlagDefinition = {
    variants: definition.variants,
    enabled: definition.enabled,
    offVariant: definition.offVariant,
    fallthrough: definition.fallthrough,
  };
  if (definition.rules && definition.rules.length > 0) out.rules = definition.rules;
  if (definition.overrides && Object.keys(definition.overrides).length > 0) {
    out.overrides = definition.overrides;
  }
  if (definition.prerequisites && definition.prerequisites.length > 0) {
    out.prerequisites = definition.prerequisites;
  }
  if (definition.salt) out.salt = definition.salt;
  if (definition.experiment) {
    const e: NonNullable<FlagDefinition['experiment']> = {};
    if (definition.experiment.key) e.key = definition.experiment.key;
    if (definition.experiment.layer) e.layer = definition.experiment.layer;
    if (definition.experiment.holdout === false) e.holdout = false;
    if (definition.experiment.metrics && definition.experiment.metrics.length > 0) {
      e.metrics = definition.experiment.metrics;
    }
    if (definition.experiment.guardrails && definition.experiment.guardrails.length > 0) {
      e.guardrails = definition.experiment.guardrails;
    }
    if (definition.experiment.control) e.control = definition.experiment.control;
    if (definition.experiment.confidence !== undefined) {
      e.confidence = definition.experiment.confidence;
    }
    out.experiment = e;
  }
  if (definition.tags && definition.tags.length > 0) out.tags = definition.tags;
  return out;
}

/** Whether a definition is a plain on/off flag (the quick-rollout control applies). */
export function isOnOff(definition: FlagDefinition): boolean {
  const names = Object.keys(definition.variants).sort();
  return names.length === 2 && names[0] === 'off' && names[1] === 'on';
}

/** Gradual-rollout steps every `hours` from `start`, reaching 100% (e.g. 10, 25, 50, 100). */
export function rolloutSteps(
  start: Date,
  percents: number[],
  hours: number,
): Array<{ at: string; percent: number }> {
  return percents.map((percent, i) => ({
    at: new Date(start.getTime() + i * hours * 3_600_000).toISOString(),
    percent,
  }));
}

/** `<input type="datetime-local">` value ↔ ISO. */
export function localInputToIso(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
