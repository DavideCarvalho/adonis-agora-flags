# @adonis-agora/flags-dashboard

## 0.5.1

### Patch Changes

- [#12](https://github.com/DavideCarvalho/adonis-agora-flags/pull/12) [`268aa78`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/268aa78aa868b3ce5fe512d7edf079288897bd85) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console sidebar matches the old authkit admin console exactly (Agora console kit): nav rows are 32px with no gap between them, section labels and the brand/switcher header use authkit's spacing, the footer role shows as sent (no forced uppercase), and the theme toggle sits left-aligned with a 13px icon next to a 26px sign-out button.

## 0.5.0

### Minor Changes

- [#8](https://github.com/DavideCarvalho/adonis-agora-flags/pull/8) [`a9aef51`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/a9aef5190f0bfb7827e3b471629e627e5390a6f8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Server: the `agora.consoles` registry accepts the `flags` and `cms` icon keys, so those consoles show their own tile instead of `generic`. Console: the console switcher shows the CMS console with its own orange tile and glyph, and the kit gains a 16px `DocumentIcon`; the collapsible nav section toggle has a test pinning its focus ring (Agora console kit round 3).

## 0.4.0

### Minor Changes

- [#4](https://github.com/DavideCarvalho/adonis-agora-flags/pull/4) [`f9cda32`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/f9cda323a23c82834d3c90eb5c7b2d46660f7f76) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console is rebuilt on the Agora console kit: the same shell as every other Agora console (authkit's look, emerald accent, Sora + JetBrains Mono bundled, no Google Fonts), a sidebar grouped into Flags, Experiments, Governance and Config, the environment picker in the top bar, metric cards on Flags and Experiments, skeletons and per-region error states, a light theme, and a drawer sidebar on phones.
  
  The flags console now joins the app's `agora.consoles` registry (id `flags`, icon `flags`): other Agora consoles list it in their switcher and search its flags and segments, and it gets the console switcher and ⌘K search itself (`GET <path>/api/consoles`, `GET <path>/api/consoles/search?q=`). The sidebar footer shows who is signed in and offers sign-out: new `viewer(ctx)` and `signOut` options in `config/flags_dashboard.ts`, defaulting to `ctx.auth.user` and the sign-out authkit announces.

## 0.3.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/adonis-agora-flags/pull/3) [`1564a54`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/1564a54b54a136986af3cfbf4005069f6495f197) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console's JSON lists speak the `@adonis-agora/filter` list format.
  
  - `GET /api/audit`, `/api/change-requests` and `/api/schedules` take `filter[field]=value` (`filter[entity]`, `filter[key]`; `filter[status]`; `filter[flag]`, `filter[status]`) and `first`, and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The history pages with `after=<meta.nextCursor>`. An unknown filter field or value, or a `sort` other than the list's own order, answers `400`.
  - `GET /api/change-requests` with no `filter[status]` lists every status.
  - The catalogs (`/api/flags`, `/api/segments`, `/api/layers`, `/api/metrics`, `/api/experiments`, `/api/stale`) return their rows under `data`.
  - `limit`, `before`, and the flat `?entity=`, `?key=`, `?status=`, `?flag=` params are gone.

## 0.2.0

### Minor Changes

- [`fd012d8`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/fd012d81f1b6768fd0c6ffa83db6d2a8ad553325) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Metrics and experiment analysis can be created in the console with no deploy.
  
  - New **Metrics** screen. It creates, edits and deletes metrics (conversion, count, sum, with window, CUPED and direction) and shows which experiments use each one. Metrics from `config/flags.ts` are listed read-only.
  - The flag editor's **Experiment** section picks the metrics that decide the experiment, its guardrails, the control variant and the confidence.
  - Console metrics are stored per environment in the ruleset (`ruleset.metrics`, entity `metric`). They go through approvals, the audit trail, export/import and promote.
  - An experiment's analysis lives on the flag (`experiment.metrics`, `guardrails`, `control`, `confidence`).
  - The worker and the console merge config and console definitions. On a name clash, the config wins.
  - Validation rejects references to unknown metrics, an unknown control variant and a confidence outside (0, 1).
  - New console API: `GET /api/metrics`, `PUT /api/metrics/:key`, `DELETE /api/metrics/:key`.
  
  Feature flags join the developer MCP endpoint of `@adonis-agora/agent` (`/mcp/agora`). With its `mcp_provider` registered, the console registers `flags_*` tools behind the console's own `authorize`.
  
  - Read tools: list and inspect flags, evaluate a context, segments, metrics, experiments and results, change requests, the history, stale flags and ops.
  - Action tools, when the app allows actions: kill switch, rollout, variant, override, save flag, segment or metric, recompute, and approve or reject change requests.
  - Actions go through `FlagsAdmin`, so approvals and the history apply.
  - New `anyAuthorize(...)` combines console checks, for example a token for MCP clients or a signed-in admin.

## 0.1.2

### Patch Changes

- [`454421a`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/454421aabae3fb33f5dec5543316bfe942e688f8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `transports.queue()`: deliver events as `@adonisjs/queue` jobs (new optional peer, `>=0.7.0 <1.0.0`). Each batch becomes one job per sink, run by `node ace queue:work` with the queue's retries and backoff, so a failing sink retries on its own. No relay and no replay (`flags:replay`), not transactional. The console's Ops page shows the sinks as delivered by the transport's jobs instead of "no relay".

## 0.1.1

### Patch Changes

- [#2](https://github.com/DavideCarvalho/adonis-agora-flags/pull/2) [`6a28271`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/6a28271c96f51c0ff33882ee85191c517ccfdbe7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Mark the flags packages as an independent release line (`agora.versioning: 'independent'`), so `agora:doctor` no longer warns that 0.x flags is mixed with the 1.x Agora libs.

## 0.1.0

### Minor Changes

- [`c39f892`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/c39f892efba4efbb13a296978619939a6911adf5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First release: typed feature flags with targeting, percentage rollouts and a kill switch; experiments with exposures, conversions, SRM, CUPED and sequential tests; transports (db, Redis), sinks (Lucid, Parquet/DuckDB, ClickHouse, PostHog); flags created and edited from the console; a central control-plane with tenant apps, authkit tokens, a browser API and OFREP; authkit identities as subjects; an OpenFeature provider; React bindings that read from the Adonis backend or straight from the flags server.
