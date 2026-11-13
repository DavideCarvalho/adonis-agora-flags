---
"@adonis-agora/flags": minor
"@adonis-agora/flags-dashboard": minor
---

The console's JSON lists speak the `@adonis-agora/filter` list format.

- `GET /api/audit`, `/api/change-requests` and `/api/schedules` take `filter[field]=value` (`filter[entity]`, `filter[key]`; `filter[status]`; `filter[flag]`, `filter[status]`) and `first`, and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The history pages with `after=<meta.nextCursor>`. An unknown filter field or value, or a `sort` other than the list's own order, answers `400`.
- `GET /api/change-requests` with no `filter[status]` lists every status.
- The catalogs (`/api/flags`, `/api/segments`, `/api/layers`, `/api/metrics`, `/api/experiments`, `/api/stale`) return their rows under `data`.
- `limit`, `before`, and the flat `?entity=`, `?key=`, `?status=`, `?flag=` params are gone.
