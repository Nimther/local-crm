---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 0
total_count: 1
last_updated: 2026-08-10T16:45:27.906Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 12 | lint-warning | apps/worker/src/__tests__/graceful-shutdown.test.ts |  | Pre-existing require-await lint errors from plan 12-08 (4 in graceful-shutdown.test.ts, 7 in shared-error-listener.test.ts); out of scope for 12-10, discovered while running repo-wide lint | open |  | 2026-08-10T16:45:27.906Z |  |

````json
[
  {
    "id": 1,
    "kind": "lint-warning",
    "phase": "12",
    "file": "apps/worker/src/__tests__/graceful-shutdown.test.ts",
    "line": null,
    "description": "Pre-existing require-await lint errors from plan 12-08 (4 in graceful-shutdown.test.ts, 7 in shared-error-listener.test.ts); out of scope for 12-10, discovered while running repo-wide lint",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-10T16:45:27.906Z",
    "resolved_at": null
  }
]
````
