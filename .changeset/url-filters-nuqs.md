---
"@adonis-agora/flags-dashboard": minor
---

Console filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and back/forward step through it: the flag list's search, tag, owner and view, the Approvals status, the Activity entity, key and page, and the Hygiene thresholds. They sit in the hash's query next to `env` (`#/flags?env=staging&show=stale`); a value at its default is left out, so existing links open as before, and switching environment keeps the screen's filters.
