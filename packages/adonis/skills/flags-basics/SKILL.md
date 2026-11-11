---
name: flags-basics
description: >-
  Set up @adonis-agora/flags in an AdonisJS 7 app and read feature flags: node
  ace configure, declaring typed flags in config/flags.ts with flag.boolean /
  flag.string({ variants }) / flag.number / flag.json, the FlagsList module
  augmentation with InferFlags, ctx.flags.enabled / value / variant / details,
  the flags service (flags.for(user)), the `flag` route-guard middleware, the
  Edge @flag tag, client: true flags for the browser, flags:set (on, off,
  kill, 25%, variant), and fakeFlags / createTestFlags for tests. Use for
  "add a feature flag", "roll out to 10% of users", "hide a route behind a
  flag", "flag is always the default", or "test code that reads a flag".
metadata:
  type: core
  library: "@adonis-agora/flags"
  library_version: "0.1.0"
  framework: adonisjs
license: MIT
sources:
  - 'DavideCarvalho/adonis-agora-flags:docs/getting-started.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/declaring-flags.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/reading-flags.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/targeting.mdx'
  - 'DavideCarvalho/adonis-agora-flags:docs/testing.mdx'
---

# @adonis-agora/flags — declaring and reading flags

Flags are declared in code (key, type, default); who gets what lives in the
database and changes without a deploy. Evaluation is in memory: reading a flag
never waits on I/O and never throws — on any problem the declared default is
served.

## Setup

```sh
node ace add @adonis-agora/flags
```

```ts
// config/flags.ts
import { defineConfig, flag, type InferFlags } from '@adonis-agora/flags'

const flagsConfig = defineConfig({
  flags: {
    new_player: flag.boolean({ default: false, owner: 'video-team', expiresAt: '2027-03-31' }),
    checkout: flag.string({ default: 'control', variants: ['control', 'one_page'] }),
    max_uploads: flag.number({ default: 10 }),
  },
})
export default flagsConfig

declare module '@adonis-agora/flags/types' {
  interface FlagsList extends InferFlags<typeof flagsConfig> {}
}
```

Flags are usually created in the console (`/flags` → New flag: key, type, default, variants,
owner); their declaration travels with the ruleset. `node ace flags:types` writes
`types/flags.d.ts` so console flags are typed (and turns on strict keys). Declaring in
`config/flags.ts`, as above, is the alternative; code wins when both exist.

## Core patterns

### Pattern 1 — read a flag in a controller

```ts no-check
async show({ flags, inertia }: HttpContext) {
  if (await flags.enabled('new_player')) return inertia.render('player/new')
  return inertia.render('player/classic')
}
```

`ctx.flags` evaluates for the authkit identity when `@adonis-agora/authkit-client`
is installed (targetingKey = `sub`; attributes `email`, `emailDomain`,
`globalRoles`, `orgId`, `orgSlug`, `orgRole`), else `ctx.auth.user`.
`identity` in the config replaces all of it with one `FlagsIdentityProvider`
(`subject`, `actor`, `authorizeConsole`, `can`): `identities.authkit()`,
`identities.adonisAuth({ guard, canOpenConsole: (user, ctx) =>
ctx.bouncer.allows(manageFlags) })`, or a class implementing the interface.
Outside HTTP:

```ts
import flags from '@adonis-agora/flags/services/main'
await flags.for(user).value('max_uploads')
```

### Pattern 2 — targeting attributes from server state

```ts no-check
// config/flags.ts
attributes: async (subject) => {
  const user = await User.find(subject.id)
  return { plan: user?.plan, orgId: user?.organizationId }
},
```

### Pattern 3 — guard a route

```ts
router.get('/beta', [BetaController]).use(middleware.flag({ flag: 'new_player' }))
```

Answers 404 when the flag says no.

### Pattern 4 — change a flag

```sh
node ace flags:set new_player 10%   # rollout; raising it only adds people
node ace flags:set new_player on
node ace flags:set new_player kill  # kill switch: off for everyone
```

### Pattern 5 — tests

```ts
import { fakeFlags } from '@adonis-agora/flags/testing'
test('new player', async ({ client, cleanup }) => {
  cleanup(fakeFlags({ new_player: true }))
})
```

## Common mistakes

### HIGH — Expecting `setEnabled(true)` / `unkill` to turn a boolean flag on

`enabled` is the kill switch. Turning targeting back on does not serve `on`.
Use `flags:set <flag> on` (`admin.turnOn`).

### HIGH — Sending flags to the browser with `ctx.flags.all()` and getting `{}`

Only flags declared with `client: true` are included, so internal names never
leak. Declare the flag with `client: true`.

### MEDIUM — Reading targeting attributes from the request

`attributes` must come from server state. A query string or header lets users
pick their own variant.

### MEDIUM — Forgetting the `declare module` block

Without it keys are plain strings: typos compile and values are untyped.
