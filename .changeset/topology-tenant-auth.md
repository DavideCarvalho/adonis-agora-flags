---
'@adonis-agora/flags': minor
---

Tenant auth follows the Agora topology convention, so one authkit setup serves flags, durable and config, and the flags server can run apart from authkit-server.

- `verifyTenant` is a top-level option of `config/flags.ts` (no longer under `controlPlane`) and takes a function, an object with `verify()` (a class instance), or a lazy import of a class. It returns `{ partition, environment?, capabilities }` from the token. A config with `controlPlane.verifyTenant` fails at boot with a message pointing at the new place.
- With authkit, use `authkitTenantVerifier({ issuer, resource: 'urn:agora:flags' })` on the control-plane and `authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:flags' })` on tenants, both from `@adonis-agora/authkit-client` (an authkit service-tenant client per app; the partition comes from the token's `partition` claim, the token endpoint from discovery).
- Every control-plane endpoint checks its capability in the token: `flags:ruleset:read`, `flags:events:write`, `flags:declarations:write`, `flags:ofrep:evaluate`. A token without `capabilities` gets 403.
- Removed: `verifiers.authkit`, `verifiers.sharedSecret`, `tokens.clientCredentials`, `tokens.static`. Without authkit, use `sharedSecretVerifier({ partitions: { app: secret } })` and the secret as `tenant.token`.
- `tenant.token` takes a string, a function returning a token, or an object with `get()`.
- `userVerifiers.authkit({ issuer, audience })` verifies through authkit-client's `identityFromAccessToken` (keys from discovery; needs authkit-client 1.0.0-rc.7+). `jwksUri` is gone.
- New exports: `FLAGS_RESOURCE`, `sharedSecretVerifier`, `TenantVerifierOption`, `TenantVerifierContract`, `TenantVerifierRequest`, `TenantTokenSource`.
