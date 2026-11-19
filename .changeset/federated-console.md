---
'@adonis-agora/flags': minor
'@adonis-agora/flags-dashboard': minor
---

Federated console: an app that keeps its own flags (own store, local evaluation) can be shown and edited in another app's flags console. The console app lists it under `apps` in `config/flags_dashboard.ts` (`store: { connection, schema }`, `controlPlane: { connection, prefix }`); the app opts in with `consoleCommands` in `config/flags.ts`. Reads come from the app's tables (read-only); every change is a console command over the app's Redis that exactly one instance runs through its own admin, so its validation, approvals and audit log apply. New `GET /api/apps` (`{ local, apps: [{ id, label, mode, actions }], selected }`), and the App picker lists this app, control-plane tenants and federated apps (tagged `federated`, with the kit's notice).
