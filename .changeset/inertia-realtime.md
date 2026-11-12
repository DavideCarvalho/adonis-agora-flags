---
'@adonis-agora/flags-react': patch
---

`InertiaFlagsProvider` takes `realtime={{ transmit }}`: it reloads the flags prop whenever the ruleset changes, so a kill switch reaches an open page without a visit.
