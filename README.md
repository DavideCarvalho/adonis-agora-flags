# adonis-flags

Feature flags, A/B experiments and their analysis for AdonisJS — on the database you already have.

- **Typed flags in code**, targeting in your database: percentage rollouts, rules, segments, overrides, prerequisites, kill switch.
- **In-memory evaluation** everywhere; changes propagate in milliseconds (Postgres `LISTEN/NOTIFY`, SSE for connected apps).
- **Experiments with real statistics**: exposures and conversions through a transactional event log, SRM checks, CUPED, always-valid sequential tests, guardrails, layers and a global holdout.
- **Grows with you**: Postgres/MySQL/SQLite → Parquet + DuckDB → ClickHouse, plus PostHog; a central flags server for many apps, authenticated with authkit.
- **Speaks OpenFeature**, including OFREP.

| Package | |
|---|---|
| [`@adonis-agora/flags`](packages/adonis) | AdonisJS provider, config, commands, middleware |
| [`@adonis-agora/flags-react`](packages/react) | `useFlag`, `<Flag>`, live updates |
| [`@adonis-agora/flags-dashboard`](packages/dashboard) | The console |
| [`@adonis-agora/flags-core`](packages/core) | Evaluation engine and statistics, framework-free |

Docs: [`docs/`](docs) (published on the Agora site). Design record: [DESIGN.md](DESIGN.md).

## Development

```sh
pnpm install
pnpm build && pnpm test
pnpm --filter @adonis-agora/flags test:integration   # Postgres, Redis and ClickHouse in Docker
```
