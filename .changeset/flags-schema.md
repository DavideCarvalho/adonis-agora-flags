---
'@adonis-agora/flags': minor
---

`schema` in `config/flags.ts`: keep every table in its own Postgres schema (MySQL: database), created at boot. Every query names it, so nothing depends on `search_path` and it is safe behind PgBouncer in transaction mode. `createFlagsTables`/`dropFlagsTables` take `schema` too. A `schema` the database cannot honour (SQLite) now fails the boot instead of falling back to memory.
