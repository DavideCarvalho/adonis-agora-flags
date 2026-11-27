# @adonis-agora/flags-dashboard

## 1.0.0

### Major Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-flags/pull/34) [`698c07c`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/698c07cbd1d8ca6557cedeba91b19aa007936c70) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: flags joins the rest of the Agora libraries on the 1.x line. No API changes from 0.15.

### Minor Changes

- [`1c65bcf`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/1c65bcf10da2faad35c116482f07f0b060c310ce) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: the federated console channel is authenticated (found in an internal security audit; same contract as every Agora lib).
  
  **Breaking:** commands are always authenticated, and a side that cannot authenticate fails its boot (web environment only; ace commands never fail):
  
  - **Together with `@adonis-agora/crypto`: nothing to configure.** When crypto is booted in the app (found under `'agora.crypto'`, never imported), commands are sealed with its key `console-flags` (`aes256-gcm`) of the owning app's partition (`apps.<key>.partition`, default the key). The key is created where possible (crypto embedded; or a tenant token with `crypto:keys:manage:console-*`), else the app logs the `node ace crypto:keys:create` line to run. No grant on the app side (an app opens its own `console-*` keys); with crypto in a separate app, the console's `crypto:seal:console-*` (the console asks the crypto server to encrypt with the app's key). A key missing on a crypto tenant is one info line: the crypto server provisions it on the console's first command.
  - **authkit's key directory**: in token mode the app publishes its APP_KEY-derived command public key under `console:flags` at boot; a console without `controlPlane.publicKey` seals to it (an explicit `publicKey` wins). With the app-call token, authkit without crypto is zero config too.
  - **authkit's calls between apps** (`'authkit.client'`): the console adds its app-call token for the app, the app verifies it with `appCallerVerifier().verifyToken`. Its capabilities cap the command; its audience binds it to the app (no partition check). Combines with crypto.
  - Explicit modes, used as given (no automatic crypto on top): `crypto: { cipher, key?, owns? }` (`owns` for another KMS's ciphertext), `token` + `publicKey` / `verifyTenant` (sealed to a key derived from `APP_KEY`; `node ace flags:console-key` prints its public half; a control plane falls back to its own `verifyTenant`), or the same `secret` (16+ characters) on both sides.
  - `crypto: false`, `token: false` (console) and `verifyTenant: false` (app) turn the automatic modes off.
  - The app with `consoleCommands` and no mode fails its boot as a web server (elsewhere it is logged); the console fails its boot for an `apps` entry with no mode unless `actions: false` (browse-only). A crypto key that cannot be created never fails the boot: one actionable line is logged and creation is retried on first use.
  - The APP_KEY-sealed token mode stays available next to crypto when a verifier and an `APP_KEY` exist; only an explicit `verifyTenant` (or `false`) replaces the automatic verifiers.
  
  **Breaking:** the console always sends the viewer's capabilities (`flags:console:read`, `:write`, `:approve`; from `authorize` → `{ allowed: true, capabilities, access? }` narrowed to that set, else all three) and the app refuses a command without them (`403`, code `capabilities-required`). In token mode the effective set is the token's ∩ the viewer's. Upgrade the console app and the owning apps together.
  
  **Breaking:** a viewer whose `authorize` narrows (`capabilities`, or `access: 'read'`) cannot change the console's own app either (`403` "the viewer lacks flags:console:write"), in the JSON API and the MCP tools; the console page disables what the viewer cannot do. `authorize` without capabilities keeps full access.
  
  `console_authorize.ts` follows the shared shape `{ allowed, apps?, tenants?, capabilities?, access? }`; `anyAuthorize` now keeps the deciding authorizer's `capabilities` (and `apps` / `tenants`) instead of dropping them.
  
  **Breaking:** `consoleCommands.actions` defaults to `false`: set `actions: true` where another console should change this app's flags.
  
  Commands over a minute old are refused, a replayed command does not run twice, and answers are authenticated in every mode, so a forged answer is ignored. Writes can no longer be sent under made-up actors by anyone who can publish on Redis, which also closes filing and approving a change request as two forged people.
  
  Security: the browser API (`/v1/client/evaluate`, exposures) only honors a tenant's code-declared `client: true` for that tenant's own browsers. Before, a tenant could declare `client: true` for a key it does not own and every app's browsers in the environment got that flag's value.
  
  Boot errors are a `ConsoleAuthConfigError` and point at `node ace agora:doctor`; boot logs name each mode (`crypto (auto, key console-flags)`, `token (…; sealed to key <8-char id>)`, `secret`) and end with `; actions on|off`; the app's public key is only logged as a short id. A garbage message on the channel is dropped and logged once per reason (`refused a command (<reason>)`). A tenant app opens its ruleset stream only in processes that serve, so ace commands exit.
  
  Mixed Hubs: with crypto and authkit's key directory, the console picks each app's mode at its first command (token when the app publishes a key, else crypto; cached 5 minutes). In crypto mode a failing app-call token no longer blocks the command (crypto-only, one warning with the grant to add). The APP_KEY is read from `app.appKey`, `config/encryption.ts` or `APP_KEY`. The app-side boot error mentions authkit. A crypto app no longer publishes its token key. The key check uses crypto's `hasKey` when available (no audit noise).
  
  New: `ConsoleAuthConfigError`, `CONSOLE_SCOPES`, `flags:console-key`, `consoleCommandKeys`, `apps.<key>.partition`, `capabilities` in the console's `authorize` answer, and the `flags.console-commands` / `flags.console-commands-key` (deep) doctor checks.

- [#35](https://github.com/DavideCarvalho/adonis-agora-flags/pull/35) [`d6c7517`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/d6c7517c9f61324e27610812737b5f868819a3ae) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console shows when things were created and changed: an "Updated" column on the flags list, "Created" on scheduled changes, and created / updated dates on a flag's detail, each segment, layer, console metric, the global holdout and change requests (`—` when unknown, the full timestamp on hover).

## 1.0.0-rc.2

### Minor Changes

- [`1c65bcf`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/1c65bcf10da2faad35c116482f07f0b060c310ce) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: the federated console channel is authenticated (found in an internal security audit; same contract as every Agora lib).
  
  **Breaking:** commands are always authenticated, and a side that cannot authenticate fails its boot (web environment only; ace commands never fail):
  
  - **Together with `@adonis-agora/crypto`: nothing to configure.** When crypto is booted in the app (found under `'agora.crypto'`, never imported), commands are sealed with its key `console-flags` (`aes256-gcm`) of the owning app's partition (`apps.<key>.partition`, default the key). The key is created where possible (crypto embedded; or a tenant token with `crypto:keys:manage:console-*`), else the app logs the `node ace crypto:keys:create` line to run. No grant on the app side (an app opens its own `console-*` keys); with crypto in a separate app, the console's `crypto:seal:console-*` (the console asks the crypto server to encrypt with the app's key). A key missing on a crypto tenant is one info line: the crypto server provisions it on the console's first command.
  - **authkit's key directory**: in token mode the app publishes its APP_KEY-derived command public key under `console:flags` at boot; a console without `controlPlane.publicKey` seals to it (an explicit `publicKey` wins). With the app-call token, authkit without crypto is zero config too.
  - **authkit's calls between apps** (`'authkit.client'`): the console adds its app-call token for the app, the app verifies it with `appCallerVerifier().verifyToken`. Its capabilities cap the command; its audience binds it to the app (no partition check). Combines with crypto.
  - Explicit modes, used as given (no automatic crypto on top): `crypto: { cipher, key?, owns? }` (`owns` for another KMS's ciphertext), `token` + `publicKey` / `verifyTenant` (sealed to a key derived from `APP_KEY`; `node ace flags:console-key` prints its public half; a control plane falls back to its own `verifyTenant`), or the same `secret` (16+ characters) on both sides.
  - `crypto: false`, `token: false` (console) and `verifyTenant: false` (app) turn the automatic modes off.
  - The app with `consoleCommands` and no mode fails its boot as a web server (elsewhere it is logged); the console fails its boot for an `apps` entry with no mode unless `actions: false` (browse-only). A crypto key that cannot be created never fails the boot: one actionable line is logged and creation is retried on first use.
  - The APP_KEY-sealed token mode stays available next to crypto when a verifier and an `APP_KEY` exist; only an explicit `verifyTenant` (or `false`) replaces the automatic verifiers.
  
  **Breaking:** the console always sends the viewer's capabilities (`flags:console:read`, `:write`, `:approve`; from `authorize` → `{ allowed: true, capabilities, access? }` narrowed to that set, else all three) and the app refuses a command without them (`403`, code `capabilities-required`). In token mode the effective set is the token's ∩ the viewer's. Upgrade the console app and the owning apps together.
  
  **Breaking:** a viewer whose `authorize` narrows (`capabilities`, or `access: 'read'`) cannot change the console's own app either (`403` "the viewer lacks flags:console:write"), in the JSON API and the MCP tools; the console page disables what the viewer cannot do. `authorize` without capabilities keeps full access.
  
  `console_authorize.ts` follows the shared shape `{ allowed, apps?, tenants?, capabilities?, access? }`; `anyAuthorize` now keeps the deciding authorizer's `capabilities` (and `apps` / `tenants`) instead of dropping them.
  
  **Breaking:** `consoleCommands.actions` defaults to `false`: set `actions: true` where another console should change this app's flags.
  
  Commands over a minute old are refused, a replayed command does not run twice, and answers are authenticated in every mode, so a forged answer is ignored. Writes can no longer be sent under made-up actors by anyone who can publish on Redis, which also closes filing and approving a change request as two forged people.
  
  Security: the browser API (`/v1/client/evaluate`, exposures) only honors a tenant's code-declared `client: true` for that tenant's own browsers. Before, a tenant could declare `client: true` for a key it does not own and every app's browsers in the environment got that flag's value.
  
  Boot errors are a `ConsoleAuthConfigError` and point at `node ace agora:doctor`; boot logs name each mode (`crypto (auto, key console-flags)`, `token (…; sealed to key <8-char id>)`, `secret`) and end with `; actions on|off`; the app's public key is only logged as a short id. A garbage message on the channel is dropped and logged once per reason (`refused a command (<reason>)`). A tenant app opens its ruleset stream only in processes that serve, so ace commands exit.
  
  Mixed Hubs: with crypto and authkit's key directory, the console picks each app's mode at its first command (token when the app publishes a key, else crypto; cached 5 minutes). In crypto mode a failing app-call token no longer blocks the command (crypto-only, one warning with the grant to add). The APP_KEY is read from `app.appKey`, `config/encryption.ts` or `APP_KEY`. The app-side boot error mentions authkit. A crypto app no longer publishes its token key. The key check uses crypto's `hasKey` when available (no audit noise).
  
  New: `ConsoleAuthConfigError`, `CONSOLE_SCOPES`, `flags:console-key`, `consoleCommandKeys`, `apps.<key>.partition`, `capabilities` in the console's `authorize` answer, and the `flags.console-commands` / `flags.console-commands-key` (deep) doctor checks.

## 1.0.0-rc.1

### Minor Changes

- [#35](https://github.com/DavideCarvalho/adonis-agora-flags/pull/35) [`d6c7517`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/d6c7517c9f61324e27610812737b5f868819a3ae) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console shows when things were created and changed: an "Updated" column on the flags list, "Created" on scheduled changes, and created / updated dates on a flag's detail, each segment, layer, console metric, the global holdout and change requests (`—` when unknown, the full timestamp on hover).

## 1.0.0-rc.0

### Major Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-flags/pull/34) [`698c07c`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/698c07cbd1d8ca6557cedeba91b19aa007936c70) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: flags joins the rest of the Agora libraries on the 1.x line. No API changes from 0.15.

## 0.9.0

### Minor Changes

- [#33](https://github.com/DavideCarvalho/adonis-agora-flags/pull/33) [`cf576f4`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/cf576f4898ff81e01d8abf2e1d63065e4e931f6e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Federated console: an app that keeps its own flags (own store, local evaluation) can be shown and edited in another app's flags console. The console app lists it under `apps` in `config/flags_dashboard.ts` (`store: { connection, schema }`, `controlPlane: { connection, prefix }`); the app opts in with `consoleCommands` in `config/flags.ts`. Reads come from the app's tables (read-only); every change is a console command over the app's Redis that exactly one instance runs through its own admin, so its validation, approvals and audit log apply. New `GET /api/apps` (`{ local, apps: [{ id, label, mode, actions }], selected }`), and the App picker lists this app, control-plane tenants and federated apps (tagged `federated`, with the kit's notice).

## 0.8.5

### Patch Changes

- [#31](https://github.com/DavideCarvalho/adonis-agora-flags/pull/31) [`a4e1461`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/a4e14618b17ee0a497120fa108be1fc015c8c451) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - App picker: screen readers hear "App: shop" (not the two spans run together), search matches an option's hint, the highlight stays on a real option when the list shrinks, and focus returns to the button after a pick.

## 0.8.4

### Patch Changes

- [#30](https://github.com/DavideCarvalho/adonis-agora-flags/pull/30) [`37cf718`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/37cf7183aa48f3698c5ebc1d80a236ca8b2b52d1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The App picker uses the console kit's shared `ScopeMenu` / `ScopeChip`, the same searchable picker as telescope's ("All apps" first, a chip for someone limited to one app). Going to another console, a sidebar page or a ⌘K command keeps `?app=` / `?tenant=`.

## 0.8.3

### Patch Changes

- [#27](https://github.com/DavideCarvalho/adonis-agora-flags/pull/27) [`f08109a`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/f08109a32551cc18cf0545f00faf669fc9096e28) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: creatable comboboxes keep the typed text when you leave the field, and server-side suggestions no longer wipe what you are typing.

## 0.8.2

### Patch Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-flags/pull/26) [`ed3bab4`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/ed3bab42615e0a788522e20f81ba4aa57161bc42) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: tag, owner, key, segment, prerequisite flag, layer and layer-experiment fields are now autocomplete comboboxes (the kit's new `ComboSelect` / `ComboMultiSelect`). Tags and owners suggest the ones already in use across the flags and still take new values; the audit log's key filter suggests the keys of the entity picked.

## 0.8.1

### Patch Changes

- [#25](https://github.com/DavideCarvalho/adonis-agora-flags/pull/25) [`b02ca2a`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/b02ca2a342e952a274531bd3784964f2e9e8b17c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ⌘K: arrow keys now visibly move the selection. The highlighted item was styled with a bare `data-selected:` (cmdk marks every item `true` or `false`) and with the dialog's own surface color, so moving looked like nothing happened.

## 0.8.0

### Minor Changes

- [#22](https://github.com/DavideCarvalho/adonis-agora-flags/pull/22) [`14bab33`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/14bab3365c20b6d76d2174f20fbbcca61386cabd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and back/forward step through it: the flag list's search, tag, owner and view, the Approvals status, the Activity entity, key and page, and the Hygiene thresholds. They sit in the hash's query next to `env` (`#/flags?env=staging&show=stale`); a value at its default is left out, so existing links open as before, and switching environment keeps the screen's filters.

## 0.7.2

### Patch Changes

- [#18](https://github.com/DavideCarvalho/adonis-agora-flags/pull/18) [`41ab7e5`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/41ab7e5847a6439314106548156c035b58f574a5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - ⌘K now navigates: it lists every page of the console's sidebar and every other Agora console you can open ("Go to Workflows", found by "durable" too), matched case- and accent-insensitively, before the console's own commands and the cross-console search hits. ⌘K opens even without a search endpoint, and shows the pages and consoles before anything is typed.

## 0.7.1

### Patch Changes

- [#17](https://github.com/DavideCarvalho/adonis-agora-flags/pull/17) [`d739e36`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/d739e36a5bd547d5ec0ddb803322199254ebe89c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console kit gains charts on TanStack Charts (`agora-kit/charts`: TimeSeriesChart, BarChart, Sparkline, DonutChart) with a themed tooltip on hover and keyboard focus. No chart in this console uses it yet; nothing changes on screen and its JS bundle stays the same (the chart styles add a few lines of CSS).

## 0.7.0

### Minor Changes

- [#16](https://github.com/DavideCarvalho/adonis-agora-flags/pull/16) [`6ed0000`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/6ed0000c4b112a13b91368937d3e7dd1790528cf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - See one app on a central server. The control-plane console gets an **App** picker in its header: experiment results, exposures, unused flags and the connected apps show one app's numbers, or every app's together. The console API and the `flags_*` MCP tools take the same `app`. A console `authorize` can answer `{ allowed: true, apps: ['shop'] }` to limit a person to some apps; any other app answers `403`. Evaluation counts are now kept per app too, in a new `flags_app_usage` table created at boot. With `autoCreateSchema: false`, add a migration that calls `createFlagsTables` again: it only creates what is missing.

## 0.6.1

### Patch Changes

- [#14](https://github.com/DavideCarvalho/adonis-agora-flags/pull/14) [`ee58980`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/ee589803a5b0d175b6501e593f269c966216d526) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The flag editor says when the stored targeting serves one value to everyone that is not the code default (a console-created flag declared in code later), and offers **Return to the code default**, which removes the flag from the ruleset.

## 0.6.0

### Minor Changes

- [#13](https://github.com/DavideCarvalho/adonis-agora-flags/pull/13) [`240101a`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/240101a07f319c793f0c346a77306528da7e32d9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console shows what the code owns, the way the authkit console shows settings locked by `defineConfig()`. Flags declared in code carry a **defined in code** lock with a line saying where to change them. Metrics and experiments from `config/flags.ts` carry a **config** lock.
  
  When the code overrides something the console stored, the console now says so. Before, it hid the console's copy without a word. This covers a flag created in the console and declared in code since, a console metric with the name of a config metric, and metrics picked for a flag whose experiment config defines. The fields that differ are listed, with a button to remove the ignored copy.
  
  New: `DELETE /api/flags/:key/declaration`, the `flags:flag:drop-declaration` command, and the `flags_remove_console_declaration` and `flags_delete_metric` MCP tools. `DELETE /api/metrics/:key` now also removes the console copy of a metric config defines, which used to answer 409. `GET /api/flags` and `GET /api/metrics` report the overridden copy as `overriddenConsole`.

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
