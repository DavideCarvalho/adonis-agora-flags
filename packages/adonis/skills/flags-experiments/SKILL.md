---
name: flags-experiments
description: >-
  Run A/B experiments with @adonis-agora/flags: metric.conversion / count /
  sum with windowMs and cupedMs, experiments config with metrics and
  guardrails, marking a flag as an experiment with a split, exposures
  recorded by ctx.flags.variant(), flags.track(name, { value, client: trx })
  inside business transactions, flags:results, SRM, sequential p-values,
  CUPED, sticky assignment, layers and the global holdout, environments that
  never mix data, and the analytics backends (lucid, duckdb + parquet sink,
  clickhouse). Use for "A/B test this page", "measure conversion", "why does
  my experiment show sample ratio mismatch", "results are empty", or "move
  analytics to ClickHouse".
metadata:
  type: core
  library: "@adonis-agora/flags"
  library_version: "0.1.0"
  framework: adonisjs
license: MIT
sources:
  - 'DavideCarvalho/adonis-agora-flags:docs/experiments.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/events-and-analytics.mdx'
---

# @adonis-agora/flags — experiments

An experiment is a flag with a split, marked as an experiment. Reading its
variant records an exposure (once per subject per experiment); `track()`
records conversions; the worker computes results per environment.

## Setup

```ts
// config/flags.ts
import { defineConfig, flag, metric } from '@adonis-agora/flags'

export default defineConfig({
  flags: { checkout: flag.string({ default: 'control', variants: ['control', 'one_page'] }) },
  metrics: {
    purchase: metric.conversion('purchase'),
    revenue: metric.sum('purchase', { cupedMs: 14 * 24 * 3600 * 1000 }),
    refunds: metric.count('refund', { direction: 'decrease' }),
  },
  experiments: { checkout: { metrics: ['purchase', 'revenue'], guardrails: ['refunds'] } },
})
```

In the console, give `checkout` a 50/50 split and mark it as an experiment.

## Core patterns

### Pattern 1 — assign and convert

```ts
const variant = await ctx.flags.variant('checkout') // records the exposure

await db.transaction(async (trx) => {
  const order = await Order.create(data, { client: trx })
  await ctx.flags.track('purchase', { value: order.total, client: trx }) // commits with the order
})
```

### Pattern 2 — read results

```sh
node ace flags:results checkout --fresh
```

Trust nothing while SRM is flagged. Peek freely with the sequential p-value;
the fixed-horizon one is only valid at the planned end.

### Pattern 3 — scale analytics

```ts no-check
sinks: { warehouse: sinks.lucid(), archive: sinks.parquet({ path: 'storage/flags' }) },
analytics: analytics.duckdb({ path: 'storage/flags' }),
```

## Common mistakes

### CRITICAL — Changing split weights mid-experiment without `sticky: true`

Subjects move between variants and are counted in both. Enable `sticky: true`
(needs the lucid sink) or restart the experiment.

### HIGH — Reading the variant only in the browser

`ctx.flags.all()` does not record exposures. Read the variant with
`ctx.flags.variant()` in the controller that renders the page.

### HIGH — Tracking outside the transaction of the business write

A rolled-back order would still count as a purchase. Pass `client: trx` (only
the `db` transport is transactional).

### MEDIUM — Expecting staging traffic in production results

Events carry their environment. Add `resultsEnvironments: ['production', 'staging']`
to compute both.
