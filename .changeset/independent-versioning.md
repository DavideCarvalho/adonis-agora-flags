---
'@adonis-agora/flags': patch
'@adonis-agora/flags-core': patch
'@adonis-agora/flags-dashboard': patch
'@adonis-agora/flags-react': patch
---

Mark the flags packages as an independent release line (`agora.versioning: 'independent'`), so `agora:doctor` no longer warns that 0.x flags is mixed with the 1.x Agora libs.
