---
"@adonis-agora/flags": patch
---

The tenant boot error now reads like the other Agora libs: `[@adonis-agora/flags] topology 'tenant' needs tenant.url, tenant.token, tenant.partition. …` (each field named in full, the authkit-client cause before the period), and the `flags.tenant-source` doctor line ends with a period.
