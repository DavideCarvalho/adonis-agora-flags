---
'@adonis-agora/flags': minor
'@adonis-agora/flags-dashboard': minor
---

Security: the federated console channel is authenticated (found in an internal security audit; same contract as every Agora lib).

**Breaking:** commands are always authenticated, and a side that cannot authenticate fails its boot (web environment only; ace commands never fail):

- **Together with `@adonis-agora/crypto`: nothing to configure.** When crypto is booted in the app (found under `'agora.crypto'`, never imported), commands are sealed with its key `console-flags` (`aes256-gcm`) of the owning app's partition (`apps.<key>.partition`, default the key). The key is created where possible (crypto embedded; or a tenant token with `crypto:keys:manage:console-*`), else the app logs the `node ace crypto:keys:create` line to run. No grant on the app side (an app opens its own `console-*` keys); with crypto in a separate app, the console's `crypto:seal:console-*` (the console asks the crypto server to encrypt with the app's key). A key missing on a crypto tenant is one info line: the crypto server provisions it on the console's first command.
- **authkit's key directory**: in token mode the app publishes its APP_KEY-derived command public key under `console:flags` at boot; a console without `controlPlane.publicKey` seals to it (an explicit `publicKey` wins). With the app-call token, authkit without crypto is zero config too.
- **authkit's calls between apps** (`'authkit.client'`): the console adds its app-call token for the app, the app verifies it with `appCallerVerifier().verifyToken`. Its capabilities cap the command; its audience binds it to the app (no partition check). Combines with crypto.
- Explicit modes, used as given (no automatic crypto on top): `crypto: { cipher, key?, owns? }` (`owns` for another KMS's ciphertext), `token` + `publicKey` / `verifyTenant` (sealed to a key derived from `APP_KEY`; `node ace flags:console-key` prints its public half; a control plane falls back to its own `verifyTenant`), or the same `secret` (16+ characters) on both sides.
- `crypto: false`, `token: false` (console) and `verifyTenant: false` (app) turn the automatic modes off.
- The app with `consoleCommands` and no mode fails its boot as a web server (elsewhere it is logged); the console fails its boot for an `apps` entry with no mode unless `actions: false` (browse-only). A crypto key that cannot be created never fails the boot: one actionable line is logged and creation is retried on first use.
- The APP_KEY-sealed token mode stays available next to crypto when a verifier and an `APP_KEY` exist; only an explicit `verifyTenant` (or `false`) replaces the automatic verifiers.

**Breaking:** the console always sends the viewer's capabilities (`flags:console:read`, `:write`, `:approve`; from `authorize` → `{ allowed: true, capabilities, access? }` narrowed to that set, else all three) and the app refuses a command without them (`403`, code `capabilities-required`). In token mode the effective set is the token's ∩ the viewer's. Upgrade the console app and the owning apps together.

**Breaking:** a viewer whose `authorize` narrows (`capabilities`, or `access: 'read'`) cannot change the console's own app either (`403` "the viewer lacks flags:console:write"), in the JSON API and the MCP tools; the console page disables what the viewer cannot do. `authorize` without capabilities keeps full access.

`console_authorize.ts` follows the shared shape `{ allowed, apps?, tenants?, capabilities?, access? }`; `anyAuthorize` now keeps the deciding authorizer's `capabilities` (and `apps` / `tenants`) instead of dropping them.

**Breaking:** `consoleCommands.actions` defaults to `false`: set `actions: true` where another console should change this app's flags.

Commands over a minute old are refused, a replayed command does not run twice, and answers are authenticated in every mode, so a forged answer is ignored. Writes can no longer be sent under made-up actors by anyone who can publish on Redis, which also closes filing and approving a change request as two forged people.

Security: the browser API (`/v1/client/evaluate`, exposures) only honors a tenant's code-declared `client: true` for that tenant's own browsers. Before, a tenant could declare `client: true` for a key it does not own and every app's browsers in the environment got that flag's value.

Boot errors are a `ConsoleAuthConfigError` and point at `node ace agora:doctor`; boot logs name each mode (`crypto (auto, key console-flags)`, `token (…; sealed to key <8-char id>)`, `secret`) and end with `; actions on|off`; the app's public key is only logged as a short id. A garbage message on the channel is dropped and logged once per reason (`refused a command (<reason>)`). A tenant app opens its ruleset stream only in processes that serve, so ace commands exit.

Mixed Hubs: with crypto and authkit's key directory, the console picks each app's mode at its first command (token when the app publishes a key, else crypto; cached 5 minutes). In crypto mode a failing app-call token no longer blocks the command (crypto-only, one warning with the grant to add). The APP_KEY is read from `app.appKey`, `config/encryption.ts` or `APP_KEY`. The app-side boot error mentions authkit. A crypto app no longer publishes its token key. The key check uses crypto's `hasKey` when available (no audit noise).

New: `ConsoleAuthConfigError`, `CONSOLE_SCOPES`, `flags:console-key`, `consoleCommandKeys`, `apps.<key>.partition`, `capabilities` in the console's `authorize` answer, and the `flags.console-commands` / `flags.console-commands-key` (deep) doctor checks.
