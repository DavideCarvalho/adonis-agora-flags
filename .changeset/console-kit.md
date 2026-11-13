---
"@adonis-agora/flags": minor
"@adonis-agora/flags-dashboard": minor
---

The console is rebuilt on the Agora console kit: the same shell as every other Agora console (authkit's look, emerald accent, Sora + JetBrains Mono bundled, no Google Fonts), a sidebar grouped into Flags, Experiments, Governance and Config, the environment picker in the top bar, metric cards on Flags and Experiments, skeletons and per-region error states, a light theme, and a drawer sidebar on phones.

The flags console now joins the app's `agora.consoles` registry (id `flags`, icon `flags`): other Agora consoles list it in their switcher and search its flags and segments, and it gets the console switcher and ⌘K search itself (`GET <path>/api/consoles`, `GET <path>/api/consoles/search?q=`). The sidebar footer shows who is signed in and offers sign-out: new `viewer(ctx)` and `signOut` options in `config/flags_dashboard.ts`, defaulting to `ctx.auth.user` and the sign-out authkit announces.
