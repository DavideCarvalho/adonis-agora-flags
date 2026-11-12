# Flags example app

A real AdonisJS 7 app using `@adonis-agora/flags` the way users do: SQLite through Lucid,
`@adonisjs/auth` sessions, Bouncer abilities, Shield (CSRF), Edge views, and the identity provider
from the "Authentication" guide (`app/flags/identity.ts`).

It installs the packages from the tarballs `pnpm pack` produces, not from the workspace, so it
catches what unit tests cannot: missing files in the package, the main entry, `node ace configure`.

```sh
pnpm e2e        # from the repository root: build, pack, install, typecheck, test, configure
```

The suite (`tests/functional`) drives the app over real HTTP:

- `standalone.spec.ts` — anonymous defaults, the console behind auth + Bouncer, production changes
  for admins only, targeting from the app's own data, the route guard and `@flag` in Edge, the
  token endpoint and the flags API, exposures and conversions reaching the warehouse tables;
- `central.spec.ts` — the same app started twice, as a control-plane and a tenant: a change in the
  central console reaches the tenant, the tenant's events reach the center, and the tenant's
  browser token works against the central flags API;
- `commands.spec.ts` — `flags:set`, `flags:list` and `flags:types` against the running app.

`FLAGS_TOPOLOGY=control-plane|tenant` switches `config/flags.ts` between the three topologies.
