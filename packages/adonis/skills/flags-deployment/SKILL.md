---
name: flags-deployment
description: >-
  Deploy @adonis-agora/flags: role (all | api | worker), dispatcher (auto |
  durable | in-process), node ace flags:work [--once], transports (db, redis)
  and sinks, retentionDays and partitionEvents, approvals and authorize with
  authz, the console (config/flags_dashboard.ts, authorize, actor), and the
  central topology: topology 'control-plane' with verifyTenant
  (verifiers.authkit / sharedSecret), topology 'tenant' with tokens.
  clientCredentials and snapshotPath, and OFREP. Use for "run flags work in a
  separate worker", "share flags across apps", "approval required for
  production", or "tenant keeps serving defaults".
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
// flags server
topology: 'control-plane',
controlPlane: { verifyTenant: verifiers.authkit({ issuer: env.get('AUTHKIT_ISSUER') }) },

// each app
topology: 'tenant',
tenant: {
  url: env.get('FLAGS_URL'),
  partition: 'streaming',
  token: tokens.clientCredentials({ tokenUrl, clientId, clientSecret }),
  snapshotPath: 'storage/flags/ruleset.json',
},
```

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
  verifyUser: userVerifiers.authkit({ issuer: env.get('AUTHKIT_ISSUER'), audience: 'flags' }),
},

// each app with a frontend
browser: {},
```

Tenants fetch their signing key from the control-plane over the tenant
connection (needs the `flags:events:write` scope); keys derive from the
control-plane's `browser.secret` (default `APP_KEY`), per app and environment.

## Common mistakes

### HIGH — Trusting browser-sent attributes

`remoteFlags({ attributes })` are merged *under* the token's identity: they can
never change who the user is, but anyone can send any value. Never gate access
on a rule over them; security-relevant attributes come from the `attributes`
resolver in `config/flags.ts`, which the token endpoint signs into the token.

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

### MEDIUM — `role: 'worker'` on a tenant

Refused at boot: tenants have no relay; the control-plane fans events out.
