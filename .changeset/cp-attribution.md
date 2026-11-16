---
"@adonis-agora/flags": minor
---

Control-plane attribution and a lazy `tenant.url`. The control plane now publishes the exposures and tracks it ingests from tenants (and from tenants' browsers) on `agora:flags:<event>`, with the envelope's `app` set to the tenant's partition (`@adonis-agora/diagnostics` 1.0.0-rc.6+). A tenant no longer publishes those itself, so nothing is recorded twice; set `diagnostics: 'local'` on the tenant to keep publishing them locally. A tenant's evaluations stay local, now stamped with `app`. Standalone apps are unchanged. `tenant.url` (and `tenantTransports.http({ url })`) also takes a function, such as `controlPlaneUrl()` from `@adonis-agora/authkit-client`: it is resolved before the first request and refreshed after a connection error or a 404. `agora:doctor --deep` gains `flags.control-plane-url`.
