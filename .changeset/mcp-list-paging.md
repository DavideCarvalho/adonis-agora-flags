---
'@adonis-agora/flags': patch
---

Every `flags_list_*` MCP tool now takes `page` and `limit` and returns `{ items, next }`, the paging `@adonis-agora/filter`'s dev tools use. `flags_list_segments`, `flags_list_metrics`, `flags_list_experiments` and `flags_list_stale` used to return their whole list and refused `limit`. `flags_list_audit` and `flags_list_change_requests` returned `entries` and `requests` with no `next`.
