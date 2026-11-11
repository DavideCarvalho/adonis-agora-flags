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

## Common mistakes

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
