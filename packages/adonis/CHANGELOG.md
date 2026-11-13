# @adonis-agora/flags

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
