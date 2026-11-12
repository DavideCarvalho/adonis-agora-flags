# @adonis-agora/flags-react

## 0.1.1

### Patch Changes

- [`0a0f152`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/0a0f1529205895820d3d8372aed936c5db46ee2a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `InertiaFlagsProvider` takes `realtime={{ transmit }}`: it reloads the flags prop whenever the ruleset changes, so a kill switch reaches an open page without a visit.

## 0.1.0

### Minor Changes

- [`c39f892`](https://github.com/DavideCarvalho/adonis-agora-flags/commit/c39f892efba4efbb13a296978619939a6911adf5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First release: typed feature flags with targeting, percentage rollouts and a kill switch; experiments with exposures, conversions, SRM, CUPED and sequential tests; transports (db, Redis), sinks (Lucid, Parquet/DuckDB, ClickHouse, PostHog); flags created and edited from the console; a central control-plane with tenant apps, authkit tokens, a browser API and OFREP; authkit identities as subjects; an OpenFeature provider; React bindings that read from the Adonis backend or straight from the flags server.
