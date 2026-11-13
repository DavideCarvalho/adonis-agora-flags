# @adonis-agora/flags-core

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

## 0.1.1

### Patch Changes

- [#2](https://github.com/DavideCarvalho/adonis-agora-flags/pull/2) [`6a28271`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/6a28271c96f51c0ff33882ee85191c517ccfdbe7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Mark the flags packages as an independent release line (`agora.versioning: 'independent'`), so `agora:doctor` no longer warns that 0.x flags is mixed with the 1.x Agora libs.

## 0.1.0

### Minor Changes

- [`c39f892`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/c39f892efba4efbb13a296978619939a6911adf5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First release: typed feature flags with targeting, percentage rollouts and a kill switch; experiments with exposures, conversions, SRM, CUPED and sequential tests; transports (db, Redis), sinks (Lucid, Parquet/DuckDB, ClickHouse, PostHog); flags created and edited from the console; a central control-plane with tenant apps, authkit tokens, a browser API and OFREP; authkit identities as subjects; an OpenFeature provider; React bindings that read from the Adonis backend or straight from the flags server.
