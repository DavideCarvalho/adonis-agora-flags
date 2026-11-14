# @adonis-agora/flags

## 0.10.0

### Minor Changes

- [#13](https://github.com/DavideCarvalho/adonis-agora-flags/pull/13) [`240101a`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/240101a07f319c793f0c346a77306528da7e32d9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console shows what the code owns, the way the authkit console shows settings locked by `defineConfig()`. Flags declared in code carry a **defined in code** lock with a line saying where to change them. Metrics and experiments from `config/flags.ts` carry a **config** lock.
  
  When the code overrides something the console stored, the console now says so. Before, it hid the console's copy without a word. This covers a flag created in the console and declared in code since, a console metric with the name of a config metric, and metrics picked for a flag whose experiment config defines. The fields that differ are listed, with a button to remove the ignored copy.
  
  New: `DELETE /api/flags/:key/declaration`, the `flags:flag:drop-declaration` command, and the `flags_remove_console_declaration` and `flags_delete_metric` MCP tools. `DELETE /api/metrics/:key` now also removes the console copy of a metric config defines, which used to answer 409. `GET /api/flags` and `GET /api/metrics` report the overridden copy as `overriddenConsole`.

## 0.9.2

### Patch Changes

- [#12](https://github.com/DavideCarvalho/adonis-agora-flags/pull/12) [`268aa78`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/268aa78aa868b3ce5fe512d7edf079288897bd85) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console sidebar matches the old authkit admin console exactly (Agora console kit): nav rows are 32px with no gap between them, section labels and the brand/switcher header use authkit's spacing, the footer role shows as sent (no forced uppercase), and the theme toggle sits left-aligned with a 13px icon next to a 26px sign-out button.

## 0.9.1

### Patch Changes

- [#11](https://github.com/DavideCarvalho/adonis-agora-flags/pull/11) [`4a58ffa`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/4a58ffa041a9664b83b73ea58424e70dbd08bdb7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console's access-denied page uses the console's own accent (emerald `#34d399`) by default, like the rest of the console.

## 0.9.0

### Minor Changes

- [#8](https://github.com/DavideCarvalho/adonis-agora-flags/pull/8) [`a9aef51`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/a9aef5190f0bfb7827e3b471629e627e5390a6f8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Server: the `agora.consoles` registry accepts the `flags` and `cms` icon keys, so those consoles show their own tile instead of `generic`. Console: the console switcher shows the CMS console with its own orange tile and glyph, and the kit gains a 16px `DocumentIcon`; the collapsible nav section toggle has a test pinning its focus ring (Agora console kit round 3).

## 0.8.0

### Minor Changes

- [#7](https://github.com/DavideCarvalho/adonis-agora-flags/pull/7) [`2366ff8`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/2366ff817cc190adcdc0b7a2040845341def7087) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ⌘K shows its loading state: a spinner in the search box while a request is in flight, skeleton rows until the first answer, earlier hits kept but dimmed during a re-search, "Nothing found" only after an empty answer, and a quiet "didn't answer" line with Retry when the search fails. Synced with the shared console kit (DataTable `rowClassName`/`subRow`, ⌘K console-local `commands`, collapsible nav sections).

## 0.7.1

### Patch Changes

- [#6](https://github.com/DavideCarvalho/adonis-agora-flags/pull/6) [`27b1331`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/27b13317ea60aab9f0a19e0705a9d9bec3b8763d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console footer: the signed-in user's role now shows when no `viewer` hook is set. The structural read of `ctx.auth.user` takes `role`, `roles` (strings, `{ name }` or authz `{ role }` rows) and `globalRoles`, plus the global roles of authkit's per-request identity on `ctx.authkit` (read structurally, 250 ms cap). One role is shown: an admin-like one first, else the first.

## 0.7.0

### Minor Changes

- [#5](https://github.com/DavideCarvalho/adonis-agora-flags/pull/5) [`658d482`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/658d4823b5d707f5cb281a36ccf86495a4acd5f1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - CLI parity with the console: everything the console (and the `flags_*` dev tools) can do is now an
  ace command, running the console's own handlers — same validation, `authorize`, approvals and audit.
  
  New commands: `flags:flag:show|enable|disable|rollout|variant|override|save|create|update|delete|evaluate`,
  `flags:segments:list|save|delete`, `flags:layers:list|save|delete`, `flags:holdout:save`,
  `flags:metrics:list|save|delete`, `flags:experiments:list|show|recompute`,
  `flags:requests:list|approve|reject|cancel`, `flags:schedules:list|create|cancel`, `flags:audit:list`,
  `flags:environments:list`, `flags:ops:status`. Every list/show takes `--json`; writes take `--env`,
  `--note` and `--as`.
  
  Breaking (0.x):
  
  - `flags:requests [list|approve|reject|cancel] [id]` is replaced by `flags:requests:list`,
    `flags:requests:approve <id>`, `flags:requests:reject <id>` and `flags:requests:cancel <id>`.
  - `flags:results <experiment> [--fresh]` is replaced by `flags:experiments:show <experiment>` and
    `flags:experiments:recompute <experiment>`.
  - `flags:import`, `flags:promote` and `flags:forget` ask for confirmation; pass `--force` in scripts
    and CI (without a terminal they refuse otherwise). `flags:import` and `flags:promote` gain
    `--dry-run`.
  - `flags:stale` validates like the console: `--unused-days` / `--static-days` must be at least 1.
    It gains `--env` and `--json`.

## 0.6.0

### Minor Changes

- [#4](https://github.com/DavideCarvalho/adonis-agora-flags/pull/4) [`f9cda32`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/f9cda323a23c82834d3c90eb5c7b2d46660f7f76) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console is rebuilt on the Agora console kit: the same shell as every other Agora console (authkit's look, emerald accent, Sora + JetBrains Mono bundled, no Google Fonts), a sidebar grouped into Flags, Experiments, Governance and Config, the environment picker in the top bar, metric cards on Flags and Experiments, skeletons and per-region error states, a light theme, and a drawer sidebar on phones.
  
  The flags console now joins the app's `agora.consoles` registry (id `flags`, icon `flags`): other Agora consoles list it in their switcher and search its flags and segments, and it gets the console switcher and ⌘K search itself (`GET <path>/api/consoles`, `GET <path>/api/consoles/search?q=`). The sidebar footer shows who is signed in and offers sign-out: new `viewer(ctx)` and `signOut` options in `config/flags_dashboard.ts`, defaulting to `ctx.auth.user` and the sign-out authkit announces.

## 0.5.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/adonis-agora-flags/pull/3) [`1564a54`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/1564a54b54a136986af3cfbf4005069f6495f197) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console's JSON lists speak the `@adonis-agora/filter` list format.
  
  - `GET /api/audit`, `/api/change-requests` and `/api/schedules` take `filter[field]=value` (`filter[entity]`, `filter[key]`; `filter[status]`; `filter[flag]`, `filter[status]`) and `first`, and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The history pages with `after=<meta.nextCursor>`. An unknown filter field or value, or a `sort` other than the list's own order, answers `400`.
  - `GET /api/change-requests` with no `filter[status]` lists every status.
  - The catalogs (`/api/flags`, `/api/segments`, `/api/layers`, `/api/metrics`, `/api/experiments`, `/api/stale`) return their rows under `data`.
  - `limit`, `before`, and the flat `?entity=`, `?key=`, `?status=`, `?flag=` params are gone.

## 0.4.1

### Patch Changes

- [`9112596`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/9112596d6ae549142e35a6a3ccf2a65c6bcc5712) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Every `flags_list_*` MCP tool now takes `page` and `limit` and returns `{ items, next }`, the paging `@adonis-agora/filter`'s dev tools use. `flags_list_segments`, `flags_list_metrics`, `flags_list_experiments` and `flags_list_stale` used to return their whole list and refused `limit`. `flags_list_audit` and `flags_list_change_requests` returned `entries` and `requests` with no `next`.

## 0.4.0

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

### Patch Changes

- Updated dependencies [[`fd012d8`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/fd012d81f1b6768fd0c6ffa83db6d2a8ad553325)]:
  - @adonis-agora/flags-core@0.2.0

## 0.3.0

### Minor Changes

- [`f3862cc`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/f3862cc198b8ee3c95fa5bf198393c9384eb78b7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Publish through `@adonis-agora/diagnostics`. Evaluations, exposures, tracks and the new `change` event (ruleset changes, with the actor) now go through diagnostics' `emit` on `agora:flags:<event>`. Its OpenTelemetry bridge, telescope and `onDiagnostic('flags', …)` see them. Before, flags published raw payloads straight on `node:diagnostics_channel`, which diagnostics never registered. Subscribers on `agora:flags:*` now receive the diagnostics envelope, with the old object in `payload`. Without diagnostics installed nothing is published. `enrichers.otel()` claims evaluations, so they are not recorded twice on the span. New exports: `FLAGS_DIAGNOSTIC_EVENTS`, `FlagsChange` and `FlagsDiagnosticEvent`.

- [`454421a`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/454421aabae3fb33f5dec5543316bfe942e688f8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `transports.queue()`: deliver events as `@adonisjs/queue` jobs (new optional peer, `>=0.7.0 <1.0.0`). Each batch becomes one job per sink, run by `node ace queue:work` with the queue's retries and backoff, so a failing sink retries on its own. No relay and no replay (`flags:replay`), not transactional. The console's Ops page shows the sinks as delivered by the transport's jobs instead of "no relay".

## 0.2.2

### Patch Changes

- [#2](https://github.com/DavideCarvalho/adonis-agora-flags/pull/2) [`6a28271`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/6a28271c96f51c0ff33882ee85191c517ccfdbe7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Mark the flags packages as an independent release line (`agora.versioning: 'independent'`), so `agora:doctor` no longer warns that 0.x flags is mixed with the 1.x Agora libs.
- Updated dependencies [[`6a28271`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/6a28271c96f51c0ff33882ee85191c517ccfdbe7)]:
  - @adonis-agora/flags-core@0.1.1

## 0.2.1

### Patch Changes

- [`b54aed8`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/b54aed804ef0f8a88ccfa89ec032917fac55aa8c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `flags:list` shows the type and default of flags created in the console (they were listed as `undeclared`). Docs: turn off `refresh.notify` behind PgBouncer in transaction mode.

## 0.2.0

### Minor Changes

- [`1eeff6b`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/1eeff6bb78ce688e109dc9b58dab56a64fdc0b13) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `schema` in `config/flags.ts`: keep every table in its own Postgres schema (MySQL: database), created at boot. Every query names it, so nothing depends on `search_path` and it is safe behind PgBouncer in transaction mode. `createFlagsTables`/`dropFlagsTables` take `schema` too. A `schema` the database cannot honour (SQLite) now fails the boot instead of falling back to memory.

## 0.1.0

### Minor Changes

- [`c39f892`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/c39f892efba4efbb13a296978619939a6911adf5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First release: typed feature flags with targeting, percentage rollouts and a kill switch; experiments with exposures, conversions, SRM, CUPED and sequential tests; transports (db, Redis), sinks (Lucid, Parquet/DuckDB, ClickHouse, PostHog); flags created and edited from the console; a central control-plane with tenant apps, authkit tokens, a browser API and OFREP; authkit identities as subjects; an OpenFeature provider; React bindings that read from the Adonis backend or straight from the flags server.

### Patch Changes

- Updated dependencies [[`c39f892`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/c39f892efba4efbb13a296978619939a6911adf5)]:
  - @adonis-agora/flags-core@0.1.0
