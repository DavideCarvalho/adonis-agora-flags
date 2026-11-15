---
"@adonis-agora/flags": minor
---

Tenant ↔ control-plane transports. `tenant.transport` (and `tenant.watch` for the ruleset) pick how an app talks to its flags server: `tenantTransports.http()` (the default, unchanged, now with `fetch` and `timeoutMs`), `.queue()`, `.bullmq()`, `.redis()` or `.durable()`. List the same driver in `controlPlane.transports` on the flags server. Every message carries the tenant token and an id: the control-plane verifies each one, takes the partition, environment and capabilities from the token, dedupes, bounds sizes (`controlPlane.maxMessageBytes`) and dead-letters poison messages (`controlPlane.onDeadLetter`). Browsers, browser tokens and OFREP stay on HTTP; the control-plane keeps its HTTP routes whatever the drivers. `tenant.url` is now needed only for HTTP and for frontends. New `@adonis-agora/flags/doctor` entry: `agora:doctor --deep` checks the broker is reachable. Snapshot writes no longer race when two ruleset updates land together.
