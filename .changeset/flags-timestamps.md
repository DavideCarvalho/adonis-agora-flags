---
"@adonis-agora/flags": minor
---

createdAt / updatedAt on every entity the flags tables keep. Stored flags, segments, layers, metrics and the holdout (`flags_entities.created_at`), environments (`flags_environments.created_at`), change requests (`updated_at`; `requested_at` is their creation), schedules and code declarations (`created_at` + `updated_at`) gain the columns; append-only tables (audit, events, tracks, exposures, usage counters, results) keep their single timestamp. Existing tables get the columns at boot as NULL-able (no rewrite, no backfill), and older rows read as unknown; with `autoCreateSchema: false`, add a migration calling `createFlagsTables` (`agora:doctor` reports missing columns as `flags.schema-columns`, and `missingFlagsColumns()` lists them).

The store contract gains optional `createdAt` / `updatedAt` on `ChangeRequest`, `ScheduledChange` and `DeclarationRow`, and an optional `entityTimestamps(environment)`; the built-in stores fill them. The console API adds `createdAt` / `updatedAt` (ISO 8601 or `null`) to flags (list and detail), segments, layers, console metrics, change requests and schedules, plus `holdoutStamps` on `/api/layers`. Bundles the console that shows them.
