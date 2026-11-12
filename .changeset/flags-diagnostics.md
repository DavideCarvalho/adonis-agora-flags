---
'@adonis-agora/flags': minor
---

Publish through `@adonis-agora/diagnostics`. Evaluations, exposures, tracks and the new `change` event (ruleset changes, with the actor) now go through diagnostics' `emit` on `agora:flags:<event>`. Its OpenTelemetry bridge, telescope and `onDiagnostic('flags', …)` see them. Before, flags published raw payloads straight on `node:diagnostics_channel`, which diagnostics never registered. Subscribers on `agora:flags:*` now receive the diagnostics envelope, with the old object in `payload`. Without diagnostics installed nothing is published. `enrichers.otel()` claims evaluations, so they are not recorded twice on the span. New exports: `FLAGS_DIAGNOSTIC_EVENTS`, `FlagsChange` and `FlagsDiagnosticEvent`.
