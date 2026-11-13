---
'@adonis-agora/flags': minor
---

CLI parity with the console: everything the console (and the `flags_*` dev tools) can do is now an
ace command, running the console's own handlers — same validation, `authorize`, approvals and audit.

New commands: `flags:flag:show|enable|disable|rollout|variant|override|save|create|update|delete|evaluate`,
`flags:segments:list|save|delete`, `flags:layers:list|save|delete`, `flags:holdout:save`,
`flags:metrics:list|save|delete`, `flags:experiments:list|show|recompute`,
`flags:requests:list|approve|reject|cancel`, `flags:schedules:list|create|cancel`, `flags:audit:list`,
`flags:environments:list`, `flags:ops:status`. Every list/show takes `--json`; writes take `--env`,
`--note` and `--as`.

Breaking (0.x):

- `flags:requests [list|approve|reject|cancel] [id]` is replaced by `flags:requests:list`,
  `flags:requests:approve <id>`, `flags:requests:reject <id>` and `flags:requests:cancel <id>`.
- `flags:results <experiment> [--fresh]` is replaced by `flags:experiments:show <experiment>` and
  `flags:experiments:recompute <experiment>`.
- `flags:import`, `flags:promote` and `flags:forget` ask for confirmation; pass `--force` in scripts
  and CI (without a terminal they refuse otherwise). `flags:import` and `flags:promote` gain
  `--dry-run`.
- `flags:stale` validates like the console: `--unused-days` / `--static-days` must be at least 1.
  It gains `--env` and `--json`.
