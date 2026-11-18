---
"@adonis-agora/flags": patch
---

Accept wildcard capabilities on service tokens. The control-plane (HTTP endpoints and every tenant transport) now matches a token's `capabilities` with the Agora-wide rule, exported as `capabilityAllows(granted, required)`: a `*` segment matches one segment and a trailing `*` covers the rest, so `flags:*` grants every flags capability and `*` grants everything. A token that already holds `flags:*` or `*` (previously ignored, so refused with `403`) now gets every flags capability.
