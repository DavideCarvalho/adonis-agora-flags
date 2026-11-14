---
'@adonis-agora/flags': minor
'@adonis-agora/flags-dashboard': minor
---

The console shows what the code owns, the way the authkit console shows settings locked by `defineConfig()`. Flags declared in code carry a **defined in code** lock with a line saying where to change them. Metrics and experiments from `config/flags.ts` carry a **config** lock.

When the code overrides something the console stored, the console now says so. Before, it hid the console's copy without a word. This covers a flag created in the console and declared in code since, a console metric with the name of a config metric, and metrics picked for a flag whose experiment config defines. The fields that differ are listed, with a button to remove the ignored copy.

New: `DELETE /api/flags/:key/declaration`, the `flags:flag:drop-declaration` command, and the `flags_remove_console_declaration` and `flags_delete_metric` MCP tools. `DELETE /api/metrics/:key` now also removes the console copy of a metric config defines, which used to answer 409. `GET /api/flags` and `GET /api/metrics` report the overridden copy as `overriddenConsole`.
