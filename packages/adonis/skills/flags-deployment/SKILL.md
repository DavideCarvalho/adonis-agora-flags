---
name: flags-deployment
description: >-
  Deploy @adonis-agora/flags: role (all | api | worker), dispatcher (auto |
  durable | in-process), node ace flags:work [--once], transports (db, redis, queue)
  and sinks, retentionDays and partitionEvents, approvals and authorize with
  authz, the console (config/flags_dashboard.ts, authorize, actor), and the
  central topology: topology 'control-plane' with a top-level verifyTenant
  (authkitTenantVerifier from @adonis-agora/authkit-client, or
  sharedSecretVerifier), topology 'tenant' (zero config with authkit-client's
  service, else tenant url/token/partition with authkitTenantToken or a shared
  secret) and snapshotPath, and OFREP. Use for "run flags work in a
  separate worker", "share flags across apps", "approval required for
  production", "tenant keeps serving defaults", or "show another app's own
  flags in this console" (federated console: apps + consoleCommands).
metadata:
  type: core
  library: "@adonis-agora/flags"
  library_version: "0.1.0"
  framework: adonisjs
license: MIT
sources:
  - 'DavideCarvalho/adonis-agora-flags:docs/deployment.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/central-server.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/operations.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/console.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/federated-console.mdx'
---

# @adonis-agora/flags — deployment

## Core patterns

### Pattern 1 — background work in a worker

```ts no-check
// config/flags.ts
role: env.get('FLAGS_ROLE', 'all'),
```

Web processes run with `FLAGS_ROLE=api`; one process runs `node ace flags:work`
(or `--once` from cron). With `@adonis-agora/durable` registered, `dispatcher:
'auto'` runs it as durable workflows instead.

### Pattern 2 — approvals for production

```ts no-check
approvals: { environments: ['production'] },
authorize: async (actor, action, { environment }) => /* authz check */ true,
```

### Pattern 3 — one flags server, many apps

```ts no-check
import { authkitTenantToken, authkitTenantVerifier } from '@adonis-agora/authkit-client'

// flags server
topology: 'control-plane',
verifyTenant: authkitTenantVerifier({
  issuer: env.get('AUTHKIT_ISSUER'),
  resource: 'urn:agora:flags',
}),

// each app, with @adonis-agora/authkit-client's `service` configured: nothing else
topology: 'tenant',

// each app, explicit form (no authkit-client `service`; any token function or a shared secret works too)
topology: 'tenant',
tenant: {
  url: env.get('FLAGS_URL'),
  partition: 'streaming',
  token: authkitTenantToken({
    issuer: env.get('AUTHKIT_ISSUER'),
    clientId: env.get('AGORA_TENANT_CLIENT_ID'),
    clientSecret: env.get('AGORA_TENANT_CLIENT_SECRET'),
    resource: 'urn:agora:flags',
  }),
  snapshotPath: 'storage/flags/ruleset.json',
},
```

With authkit-client's `service` (`name`, `clientId`, `clientSecret`) configured, `tenant.url`,
`tenant.token` and `tenant.partition` come from its `tenantOf('urn:agora:flags')` (structural:
the `authkit.client` binding); any field set in `tenant` wins, `tenant: { auto: false }` turns it
off. Missing fields with neither fail a web server's boot naming them; `agora:doctor` prints
`tenant url: authkit-client (auto), token: …, partition: explicit`.

Without authkit: `verifyTenant: sharedSecretVerifier({ partitions: { streaming: env.get('FLAGS_SECRET_STREAMING') } })`
on the server and `token: env.get('FLAGS_SECRET_STREAMING')` on the app.

Set by hand, `tenant.url` may be lazy: `controlPlaneUrl({ issuer, resource: 'urn:agora:flags' })` from
`@adonis-agora/authkit-client` (resolved before the first request, refreshed on a
connection error or 404). Diagnostics events are published once: the tenant publishes
evaluations (`app` = partition); the control plane publishes the tenant's exposures and
tracks (`app` = partition) and the tenant does not, unless `diagnostics: 'local'`.

Frontends that do not render through Inertia (SPA, static site) read client
flags with `remoteFlags({ endpoint: '/_flags/token' })` from
`@adonis-agora/flags-react`. Set `browser: {}` in the app's config — it mounts
`GET /_flags/token`, which signs the same subject as `ctx.flags` (authkit
identity, else `subject` resolver, else anonymous) — and on the control-plane:

```ts no-check
// flags server
browser: {
  corsOrigins: ['https://app.example.com'],
  // optional: mobile apps holding their own authkit access token (PKCE)
  verifyUser: userVerifiers.authkit({
    issuer: env.get('AUTHKIT_ISSUER'),
    audience: 'https://flags.example.com',
  }),
},

// each app with a frontend
browser: {},
```

Tenants fetch their signing key from the control-plane over the tenant
connection (needs the `flags:events:write` capability); keys derive from the
control-plane's `browser.secret` (default `APP_KEY`), per app and environment.

### Pattern 4 — one console, apps that keep their own flags (federated)

```ts
// console app: config/flags_dashboard.ts
import env from '#start/env'
import { defineConfig } from '@adonis-agora/flags/dashboard'

export default defineConfig({
  apps: {
    'entre-textos': {
      label: 'Entre Textos',
      store: { connection: 'pg', schema: 'flags_entretextos' }, // read-only (GRANT SELECT)
      // Authenticated, always: secret / token + publicKey / crypto (see below).
      controlPlane: {
        connection: 'main',
        prefix: 'entretextos',
        secret: env.get('ENTRETEXTOS_CONSOLE_SECRET'),
      },
    },
  },
})
```

```ts
// the other app: config/flags.ts (standalone or control-plane, never a tenant)
import env from '#start/env'
import { defineConfig } from '@adonis-agora/flags'

export default defineConfig({
  flags: {},
  consoleCommands: {
    prefix: 'entretextos',
    connection: 'main',
    secret: env.get('ENTRETEXTOS_CONSOLE_SECRET'), // same value as the console's
    actions: true, // changes are opt-in (default false)
  },
})
```

Reads come from the app's tables; every change is sent over the shared Redis
and run once by the app itself (its approvals and audit apply). `?app=<key>`
picks the app; `authorize` returning `apps` limits who sees it.

The channel is always authenticated, by one of these modes (the app accepts
every mode it can resolve):

- **crypto (automatic)**: with `@adonis-agora/crypto` booted in both apps there
  is nothing to configure. Commands are sealed with the crypto key
  `console-flags` of the owning app's partition (`apps.<key>.partition`,
  default the key); no grant on the app side, and `crypto:seal:console-*` on
  the console's crypto client when crypto is a separate app.
- **authkit app-call token (automatic)**: with authkit-client's `service`
  configured, the console attaches an app-call token for the app; grant the
  console's service client `flags:console:*` (or narrower) on that app in
  authkit. Without crypto the token is sealed to the key the app publishes in
  authkit's key directory (purpose `console:flags`), so `publicKey` is
  optional.
- **shared `secret`** (no authkit, no crypto): the same value on both sides.

Bring your own: console `controlPlane.token` (any token function) +
`publicKey` from `node ace flags:console-key`, app
`consoleCommands.verifyTenant` (any verifier), or an explicit `crypto: { cipher,
key? }` (own KMS). `crypto: false` / `token: false` / `verifyTenant: false` turn
the automatic modes off.

App side, `consoleCommands.actions` defaults to `false`: reads are answered,
changes answer 403 until set to `true`. A console entry defaults to
`actions: true`; `actions: false` makes it browse-only.
Commands always carry the viewer's capabilities
(`flags:console:read|write|approve`, from `authorize` → `capabilities`;
`flags:console:*` covers all three); the app refuses one without them
(`capabilities-required`). A side that cannot authenticate fails its boot in
the web process; `node ace agora:doctor` shows the resolved mode
(`flags.console-commands`). Never take the app's key from Redis.

## Common mistakes

### HIGH — Trusting browser-sent attributes

`remoteFlags({ attributes })` are merged *under* the token's identity: they can
never change who the user is, but anyone can send any value. Never gate access
on a rule over them; security-relevant attributes come from the `attributes`
resolver in `config/flags.ts`, which the token endpoint signs into the token.

### HIGH — `verifyTenant` under `controlPlane`

`verifyTenant` is a top-level option of `config/flags.ts`; `controlPlane` only
holds `prefix`, `ofrep` and `corsOrigins`. A config with
`controlPlane: { verifyTenant }` fails at boot. Tenant tokens carry `partition`
and `capabilities` claims (an authkit service-tenant client for the resource
`urn:agora:flags`); the partition never comes from `client_id` or the request.
Capabilities accept `*` wildcards: `flags:*` grants every flags capability.

### HIGH — CSRF refusing the flags API

With `@adonisjs/shield`, browsers calling the flags API and tenants posting
events are refused (redirect/403) unless config/shield.ts has
`exceptRoutes: (ctx) => flagsCsrfExceptions(ctx.request.url())`.

### HIGH — `browser` only on the tenant

The tenant's token endpoint fetches its key from the control-plane: without
`browser` there, it answers 503 and the log says so.

### HIGH — Console with approvals but no `actor`

Anonymous console users are refused in approval environments (two anonymous
people would be the same actor). Set `actor` in `config/flags_dashboard.ts` or
sign people in.

### HIGH — No `snapshotPath` on tenants

A tenant that boots while the control-plane is down serves code defaults
until it reconnects.

### MEDIUM — Enabling `partitionEvents` after the first boot

The event table is created on first boot; switching to partitioning later
needs a manual migration.

### MEDIUM — `search_path` to keep the tables apart

A connection with `searchPath` (or `SET search_path`) leaks into other clients
behind PgBouncer in transaction mode. Use `schema: 'flags'` in
`config/flags.ts`: every query names the schema. Set it before the first boot.

### HIGH — `LISTEN` behind PgBouncer in transaction mode

The held `LISTEN` connection does not survive transaction pooling: other
replicas silently miss instant updates. Set `refresh: { notify: false }`;
they poll every `refresh.intervalMs` (default 5 s).

### MEDIUM — `role: 'worker'` on a tenant

Refused at boot: tenants have no relay; the control-plane fans events out.
