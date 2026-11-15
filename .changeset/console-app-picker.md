---
"@adonis-agora/flags": minor
"@adonis-agora/flags-dashboard": minor
---

See one app on a central server. The control-plane console gets an **App** picker in its header: experiment results, exposures, unused flags and the connected apps show one app's numbers, or every app's together. The console API and the `flags_*` MCP tools take the same `app`. A console `authorize` can answer `{ allowed: true, apps: ['shop'] }` to limit a person to some apps; any other app answers `403`. Evaluation counts are now kept per app too, in a new `flags_app_usage` table created at boot. With `autoCreateSchema: false`, add a migration that calls `createFlagsTables` again: it only creates what is missing.
