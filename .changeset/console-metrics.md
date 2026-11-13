---
"@adonis-agora/flags-core": minor
"@adonis-agora/flags": minor
"@adonis-agora/flags-dashboard": minor
---

Metrics and experiment analysis can be created in the console with no deploy.

- New **Metrics** screen. It creates, edits and deletes metrics (conversion, count, sum, with window, CUPED and direction) and shows which experiments use each one. Metrics from `config/flags.ts` are listed read-only.
- The flag editor's **Experiment** section picks the metrics that decide the experiment, its guardrails, the control variant and the confidence.
- Console metrics are stored per environment in the ruleset (`ruleset.metrics`, entity `metric`). They go through approvals, the audit trail, export/import and promote.
- An experiment's analysis lives on the flag (`experiment.metrics`, `guardrails`, `control`, `confidence`).
- The worker and the console merge config and console definitions. On a name clash, the config wins.
- Validation rejects references to unknown metrics, an unknown control variant and a confidence outside (0, 1).
- New console API: `GET /api/metrics`, `PUT /api/metrics/:key`, `DELETE /api/metrics/:key`.

Feature flags join the developer MCP endpoint of `@adonis-agora/agent` (`/mcp/agora`). With its `mcp_provider` registered, the console registers `flags_*` tools behind the console's own `authorize`.

- Read tools: list and inspect flags, evaluate a context, segments, metrics, experiments and results, change requests, the history, stale flags and ops.
- Action tools, when the app allows actions: kill switch, rollout, variant, override, save flag, segment or metric, recompute, and approve or reject change requests.
- Actions go through `FlagsAdmin`, so approvals and the history apply.
- New `anyAuthorize(...)` combines console checks, for example a token for MCP clients or a signed-in admin.
