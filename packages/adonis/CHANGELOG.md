# @adonis-agora/flags

## 0.2.0

### Minor Changes

- [`1eeff6b`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/1eeff6bb78ce688e109dc9b58dab56a64fdc0b13) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `schema` in `config/flags.ts`: keep every table in its own Postgres schema (MySQL: database), created at boot. Every query names it, so nothing depends on `search_path` and it is safe behind PgBouncer in transaction mode. `createFlagsTables`/`dropFlagsTables` take `schema` too. A `schema` the database cannot honour (SQLite) now fails the boot instead of falling back to memory.

## 0.1.0

### Minor Changes

- [`c39f892`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/c39f892efba4efbb13a296978619939a6911adf5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First release: typed feature flags with targeting, percentage rollouts and a kill switch; experiments with exposures, conversions, SRM, CUPED and sequential tests; transports (db, Redis), sinks (Lucid, Parquet/DuckDB, ClickHouse, PostHog); flags created and edited from the console; a central control-plane with tenant apps, authkit tokens, a browser API and OFREP; authkit identities as subjects; an OpenFeature provider; React bindings that read from the Adonis backend or straight from the flags server.

### Patch Changes

- Updated dependencies [[`c39f892`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/c39f892efba4efbb13a296978619939a6911adf5)]:
  - @adonis-agora/flags-core@0.1.0
