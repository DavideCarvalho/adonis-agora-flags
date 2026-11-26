---
"@adonis-agora/flags": minor
---

Security: federated console commands are now authenticated, and a tenant's code-declared `client: true` only reaches that tenant's browsers (GHSA-3cxh-4mvf-3mhp, backported to 0.x).

**Breaking: `consoleCommands` now requires a shared secret.** Every command and answer on the Redis channel is authenticated with HMAC-SHA256. A command without a valid MAC, older than 60 seconds, or already run is dropped; the console ignores answers it cannot authenticate; malformed messages are dropped and logged.

- In the app that answers the console (`config/flags.ts`): `consoleCommands: { secret: env.get('FLAGS_CONSOLE_SECRET'), prefix, connection, actions }`. `consoleCommands: true` is no longer accepted. The secret must be at least 16 characters (for example `openssl rand -base64 32`), as a string or an AdonisJS `Secret`.
- In the console app (`config/flags_dashboard.ts`): each `apps` entry needs the same value as `controlPlane.secret`. A `RedisConsoleChannel` passed directly needs `secret` too.
- Without a secret, `defineConfig` throws (`consoleCommands.secret is required`) and the console refuses its `apps` entry at boot (`controlPlane.secret is required`). Upgrade the console app and the apps it shows together.

Browser API: a `client: true` declared in a tenant's code is honored only for that tenant's own browsers. Flags marked `client: true` in the console or in the serving app's own code still reach every app's browsers.
