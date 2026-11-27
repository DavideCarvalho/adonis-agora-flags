---
"@adonis-agora/flags": minor
---

Zero-config tenant topology: with `@adonis-agora/authkit-client` configured (its `service`), `defineConfig({ topology: 'tenant', flags })` is enough. `tenant.url`, `tenant.token` and `tenant.partition` come from the `authkit.client` binding's `tenantOf('urn:agora:flags')` (detected structurally, no dependency on authkit-client); anything set in `tenant` wins, field by field, and `tenant: { auto: false }` turns the detection off. Missing fields fail a web server's boot with the fields and both fixes, and `agora:doctor` reports where each came from (`tenant url: authkit-client (auto), token: authkit-client (auto), partition: explicit`).
