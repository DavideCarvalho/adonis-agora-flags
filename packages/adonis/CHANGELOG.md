# @adonis-agora/flags

## 0.14.4

### Patch Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-flags/pull/26) [`ed3bab4`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/ed3bab42615e0a788522e20f81ba4aa57161bc42) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: tag, owner, key, segment, prerequisite flag, layer and layer-experiment fields are now autocomplete comboboxes (the kit's new `ComboSelect` / `ComboMultiSelect`). Tags and owners suggest the ones already in use across the flags and still take new values; the audit log's key filter suggests the keys of the entity picked.

## 0.14.3

### Patch Changes

- [#24](https://github.com/DavideCarvalho/adonis-agora-flags/pull/24) [`9a7abd9`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/9a7abd97dc33846afcb7459bf755655175672733) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept wildcard capabilities on service tokens. The control-plane (HTTP endpoints and every tenant transport) now matches a token's `capabilities` with the Agora-wide rule, exported as `capabilityAllows(granted, required)`: a `*` segment matches one segment and a trailing `*` covers the rest, so `flags:*` grants every flags capability and `*` grants everything. A token that already holds `flags:*` or `*` (previously ignored, so refused with `403`) now gets every flags capability.

## 0.14.2

### Patch Changes

- [#25](https://github.com/DavideCarvalho/adonis-agora-flags/pull/25) [`b02ca2a`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/b02ca2a342e952a274531bd3784964f2e9e8b17c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ⌘K: arrow keys now visibly move the selection. The highlighted item was styled with a bare `data-selected:` (cmdk marks every item `true` or `false`) and with the dialog's own surface color, so moving looked like nothing happened.

## 0.14.1

### Patch Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-flags/pull/23) [`1eac6b7`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/1eac6b720b8a21bf31da5959cb4abd0f47a06a21) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ships the console with its filters in the URL (copy the link to share a filtered view). The console is bundled into this package at build time, so it needs its own release to reach apps.

## 0.14.0

### Minor Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-flags/pull/21) [`0c6d948`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/0c6d948f95897cdebd9568caf208c2c2b5417513) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Control-plane attribution and a lazy `tenant.url`. The control plane now publishes the exposures and tracks it ingests from tenants (and from tenants' browsers) on `agora:flags:<event>`, with the envelope's `app` set to the tenant's partition (`@adonis-agora/diagnostics` 1.0.0-rc.6+). A tenant no longer publishes those itself, so nothing is recorded twice; set `diagnostics: 'local'` on the tenant to keep publishing them locally. A tenant's evaluations stay local, now stamped with `app`. Standalone apps are unchanged. `tenant.url` (and `tenantTransports.http({ url })`) also takes a function, such as `controlPlaneUrl()` from `@adonis-agora/authkit-client`: it is resolved before the first request and refreshed after a connection error or a 404. `agora:doctor --deep` gains `flags.control-plane-url`.

## 0.13.0

### Minor Changes

- [#20](https://github.com/DavideCarvalho/adonis-agora-flags/pull/20) [`b943fa6`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/b943fa63b193405285517491b1adf14c25212910) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tenant ↔ control-plane transports. `tenant.transport` (and `tenant.watch` for the ruleset) pick how an app talks to its flags server: `tenantTransports.http()` (the default, unchanged, now with `fetch` and `timeoutMs`), `.queue()`, `.bullmq()`, `.redis()` or `.durable()`. List the same driver in `controlPlane.transports` on the flags server. Every message carries the tenant token and an id: the control-plane verifies each one, takes the partition, environment and capabilities from the token, dedupes, bounds sizes (`controlPlane.maxMessageBytes`) and dead-letters poison messages (`controlPlane.onDeadLetter`). Browsers, browser tokens and OFREP stay on HTTP; the control-plane keeps its HTTP routes whatever the drivers. `tenant.url` is now needed only for HTTP and for frontends. New `@adonis-agora/flags/doctor` entry: `agora:doctor --deep` checks the broker is reachable. Snapshot writes no longer race when two ruleset updates land together.

## 0.12.1

### Patch Changes

- [#19](https://github.com/DavideCarvalho/adonis-agora-flags/pull/19) [`163f252`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/163f25242ebb3ba499b7511e26e79daf51adc097) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ships the current console: chart tooltips (TanStack Charts) and ⌘K navigation to pages and consoles. The console is bundled into this package, so the dashboard-only release did not reach apps.

## 0.12.0

### Minor Changes

- [#16](https://github.com/DavideCarvalho/adonis-agora-flags/pull/16) [`6ed0000`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/6ed0000c4b112a13b91368937d3e7dd1790528cf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - See one app on a central server. The control-plane console gets an **App** picker in its header: experiment results, exposures, unused flags and the connected apps show one app's numbers, or every app's together. The console API and the `flags_*` MCP tools take the same `app`. A console `authorize` can answer `{ allowed: true, apps: ['shop'] }` to limit a person to some apps; any other app answers `403`. Evaluation counts are now kept per app too, in a new `flags_app_usage` table created at boot. With `autoCreateSchema: false`, add a migration that calls `createFlagsTables` again: it only creates what is missing.

## 0.11.0

### Minor Changes

- [#15](https://github.com/DavideCarvalho/adonis-agora-flags/pull/15) [`0ddf31f`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/0ddf31f8ae5034b5df3b8b5a6b190f28a1901e8d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tenant auth follows the Agora topology convention, so one authkit setup serves flags, durable and config, and the flags server can run apart from authkit-server.
  
  - `verifyTenant` is a top-level option of `config/flags.ts` (no longer under `controlPlane`) and takes a function, an object with `verify()` (a class instance), or a lazy import of a class. It returns `{ partition, environment?, capabilities }` from the token. A config with `controlPlane.verifyTenant` fails at boot with a message pointing at the new place.
  - With authkit, use `authkitTenantVerifier({ issuer, resource: 'urn:agora:flags' })` on the control-plane and `authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:flags' })` on tenants, both from `@adonis-agora/authkit-client` (an authkit service-tenant client per app; the partition comes from the token's `partition` claim, the token endpoint from discovery).
  - Every control-plane endpoint checks its capability in the token: `flags:ruleset:read`, `flags:events:write`, `flags:declarations:write`, `flags:ofrep:evaluate`. A token without `capabilities` gets 403.
  - Removed: `verifiers.authkit`, `verifiers.sharedSecret`, `tokens.clientCredentials`, `tokens.static`. Without authkit, use `sharedSecretVerifier({ partitions: { app: secret } })` and the secret as `tenant.token`.
  - `tenant.token` takes a string, a function returning a token, or an object with `get()`.
  - `userVerifiers.authkit({ issuer, audience })` verifies through authkit-client's `identityFromAccessToken` (keys from discovery; needs authkit-client 1.0.0-rc.7+). `jwksUri` is gone.
  - New exports: `FLAGS_RESOURCE`, `sharedSecretVerifier`, `TenantVerifierOption`, `TenantVerifierContract`, `TenantVerifierRequest`, `TenantTokenSource`.

## 0.10.1

### Patch Changes

- [#14](https://github.com/DavideCarvalho/adonis-agora-flags/pull/14) [`ee58980`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/ee589803a5b0d175b6501e593f269c966216d526) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The flag editor says when the stored targeting serves one value to everyone that is not the code default (a console-created flag declared in code later), and offers **Return to the code default**, which removes the flag from the ruleset.

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
