---
"@adonis-agora/flags": patch
---

`flags:set` on a control plane (the Hub) now finds a flag that only a tenant declared: `FlagsAdmin.definition()` falls back to the declarations apps pushed to the control plane (new `FlagsAdmin.declarationOf(key)`), so `flags:set`, the console and every admin action work on it without `flags:flag:create` first. The `bullmq` peer range is now `^5.0.0 || ^6.0.0` (the bullmq tenant transport is tested against bullmq 6 and a real Redis). `node ace configure @adonis-agora/flags --topology=tenant` writes the one-line tenant config with the explicit `tenant` block as a comment. The tenant boot error now points at `config/authkit_client.ts`, where authkit-client's `service` lives (it said `config/authkit.ts`).
