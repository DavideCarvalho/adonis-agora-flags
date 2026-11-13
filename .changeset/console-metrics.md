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
