---
"@adonis-agora/flags": patch
---

Stores, transports, sinks and analytics backends now describe the infrastructure they use (`Symbol.for('@adonis-agora/stack')`), and the `defineConfig` result describes the defaults it falls back to, so telescope's Architecture page shows "flags: exposures → ClickHouse" without any app code.
