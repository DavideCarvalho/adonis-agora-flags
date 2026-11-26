---
'@adonis-agora/flags': patch
---

The browser API again serves the `client: true` flags the control plane's own code declares to every app's browsers (its operator's, like a console declaration); only a tenant's reported declarations stay scoped to that tenant's browsers. A tenant that boots before its control plane now keeps retrying to publish its declarations until they land.
