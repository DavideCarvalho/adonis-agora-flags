---
"@adonis-agora/flags": patch
---

The flags provider now registers its checks in the app's `agora.doctor` registry at boot, like the other Agora libs. Before, `node ace agora:doctor` reported flags as "installed but its provider is not registered" and ran none of its checks (so `flags.tenant-source` never showed where the tenant url, token and partition came from).
