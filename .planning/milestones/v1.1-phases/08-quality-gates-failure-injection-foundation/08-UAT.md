---
status: complete
phase: 08-quality-gates-failure-injection-foundation
source: 08-01-SUMMARY.md, 08-02-SUMMARY.md, 08-03-SUMMARY.md, 08-04-SUMMARY.md, 08-05-SUMMARY.md, 08-06-SUMMARY.md, 08-07-SUMMARY.md, 08-08-SUMMARY.md, 08-09-SUMMARY.md, 08-10-SUMMARY.md, 08-11-SUMMARY.md, 08-12-SUMMARY.md, 08-13-SUMMARY.md, 08-14-SUMMARY.md, 08-15-SUMMARY.md, 08-16-SUMMARY.md, 08-17-SUMMARY.md, 08-18-SUMMARY.md
started: 2026-08-06T10:33:20Z
updated: 2026-08-06T10:46:33Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server/service. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch (npm run dev). Server boots without errors, migrations/seed complete, and a basic check (health endpoint or homepage load) returns live data.
result: pass

### 2. Branch Protection Blocks Red PR (08-01 D5)
expected: On GitHub, a PR with a failing required check (static/test/failure-injection) shows merge blocked — even for admins. Once checks go green, the merge button unblocks.
result: pass

### 3. Redis Config Applied in Compose (08-04 D5)
expected: docker-compose.yml's redis service starts redis-server with an explicit command: pointing at docker/redis.conf mounted read-only. On a CI runner (or any machine with Docker), the four-directive Redis assertion script passes against the composed service.
result: pass

### 4. SPECIFICATION.md Redis Sections Accurate (08-04 D6)
expected: SPECIFICATION.md §1.3 and §5.3 correctly describe the Redis configuration as built: both application paths (compose override and throwaway harness) and an explicit note of what stays unverifiable locally.
result: pass

### 5. Lint Exception Registry Justified (08-07 D5)
expected: docs/lint-rule-exceptions.md lists every repo-wide eslint disable with its occurrence count and a reason that actually justifies the exception; none of the entries is an async type-aware rule.
result: pass

### 6. Type-Aware Fixes Didn't Break UI (08-07 D6)
expected: The contacts list and segment summary pages render and read correctly — the memoization and String(unknown) fixes changed rendering code paths that the automated suite does not assert.
result: pass

### 7. Failure-Injection Baseline Correctly Scoped (08-08 D6)
expected: The failure-injection assertions describe today's system: the 'reconciling' status appears only in comments as a flagged Phase 11 change, never pre-empted in an expect(). The recorded baseline is the right one for Phase 11 to change against.
result: pass

### 8. E2E Without Provisioned DB Aborts (08-10 D6)
expected: Starting the E2E server lane without the Playwright globalSetup having provisioned a database aborts at boot (Zod refuses a missing DSN) instead of silently reaching the dev database.
result: pass

### 9. Worker Serial Execution Under Aggregation (08-11 D5)
expected: apps/worker keeps fileParallelism:false when run through the aggregated coverage command — flow-run-advance-integration shows no intermittent failures across aggregated runs.
result: pass

### 10. Failure-Mode Checklist Accurate (08-13 D4)
expected: The written checklist of the five audit-named failure modes maps to real script names and file paths, and each recorded outcome still describes what its test actually asserts. It is kept separate from the coverage number.
result: pass

### 11. Coverage Gate State Is the Expected One (08-14 D5)
expected: The coverage gate runs against the real aggregated report and reports the real number. After 08-16's added tests, the gate is green with the recorded threshold untouched — any red here would be a new regression, not the previously expected shortfall.
result: pass

### 12. Secrets File Out of Working Root (08-15 D6)
expected: The secrets/env file is physically outside the repository working root (agent verified only by listing, never by reading). npm run dev and the test lane work with no configuration file in the working root.
result: pass

### 13. RLS Baseline Recorded Executably (08-16 D6)
expected: The pre-Phase-10 RLS posture is pinned by an executable artifact (test/script) so that Phase 10's change to it must be deliberate. The recorded posture matches what the code does today.
result: pass

### 14. Docs Don't Present Planned as Current (08-17 D5)
expected: ARCHITECTURE.md and CONVENTIONS.md reserve present tense for behaviour backed by cited files; forward-looking content is confined to a labelled section in each document — no sentence describes planned behaviour as current.
result: pass

### 15. Fail-closed DSN guard rejects unset, empty, identical, loopback-aliased and wrong-prefix test DSNs, and accepts a correctly provisioned one
expected: Fail-closed DSN guard rejects unset, empty, identical, loopback-aliased and wrong-prefix test DSNs, and accepts a correctly provisioned one
result: pass
source: automated
coverage_id: 08-01-D1

### 16. Guard aborts a real vitest run before any test is collected when the test DSN is unusable
expected: Guard aborts a real vitest run before any test is collected when the test DSN is unusable
result: pass
source: automated
coverage_id: 08-01-D2

### 17. Guard has no bypass surface — no opt-out parameter, no environment read
expected: Guard has no bypass surface — no opt-out parameter, no environment read
result: pass
source: automated
coverage_id: 08-01-D3

### 18. CI job `test` runs on a real runner: live Postgres+Redis via docker compose, ephemeral DB, monorepo typecheck, worker suite
expected: CI job `test` runs on a real runner: live Postgres+Redis via docker compose, ephemeral DB, monorepo typecheck, worker suite
result: pass
source: automated
coverage_id: 08-01-D4

### 19. DSN guard enforces both SPEC R4 conditions across all acceptance rows, including IPv6 loopback and default-port normalization
expected: DSN guard enforces both SPEC R4 conditions across all acceptance rows, including IPv6 loopback and default-port normalization
result: pass
source: automated
coverage_id: 08-02-D1

### 20. dropEphemeralDatabase refuses every non-test name before opening a connection or interpolating SQL
expected: dropEphemeralDatabase refuses every non-test name before opening a connection or interpolating SQL
result: pass
source: automated
coverage_id: 08-02-D2

### 21. Ephemeral database is created, reachable under the non-superuser mega_crm_app role, and dropped
expected: Ephemeral database is created, reachable under the non-superuser mega_crm_app role, and dropped
result: pass
source: automated
coverage_id: 08-02-D3

### 22. Worker suite provisions its own database with no TEST_DATABASE_URL from the caller, and tears it down on success AND on failure
expected: Worker suite provisions its own database with no TEST_DATABASE_URL from the caller, and tears it down on success AND on failure
result: pass
source: automated
coverage_id: 08-02-D4

### 23. A single violation of an enabled type-aware rule makes eslint exit 1
expected: A single violation of an enabled type-aware rule makes eslint exit 1
result: pass
source: automated
coverage_id: 08-03-D1

### 24. A forgotten .only is a lint error and cannot be auto-erased by --fix
expected: A forgotten .only is a lint error and cannot be auto-erased by --fix
result: pass
source: automated
coverage_id: 08-03-D2

### 25. An ignores-glob typo that collapses the checked-file count fails the gate
expected: An ignores-glob typo that collapses the checked-file count fails the gate
result: pass
source: automated
coverage_id: 08-03-D3

### 26. No source file hides behind an unnamed blanket eslint-disable
expected: No source file hides behind an unnamed blanket eslint-disable
result: pass
source: automated
coverage_id: 08-03-D4

### 27. Type-aware rules are active across the monorepo without parser errors
expected: Type-aware rules are active across the monorepo without parser errors
result: pass
source: automated
coverage_id: 08-03-D5

### 28. Four-directive assertion against a live server, run as the same script in every environment with REDIS_URL supplied from outside
expected: Four-directive assertion against a live server, run as the same script in every environment with REDIS_URL supplied from outside
result: pass
source: automated
coverage_id: 08-04-D1

### 29. Fail-first proof: the assertion rejects an unconfigured redis-server, observed before docker/redis.conf existed and re-proven on every run
expected: Fail-first proof: the assertion rejects an unconfigured redis-server, observed before docker/redis.conf existed and re-proven on every run
result: pass
source: automated
coverage_id: 08-04-D2

### 30. An unverifiable Redis is a failure, never a skip — unreachable server and unset REDIS_URL both exit non-zero
expected: An unverifiable Redis is a failure, never a skip — unreachable server and unset REDIS_URL both exit non-zero
result: pass
source: automated
coverage_id: 08-04-D3

### 31. Throwaway redis-server harness on a reserved port with a temp data dir, guaranteed teardown, never touching the system Redis on 6379
expected: Throwaway redis-server harness on a reserved port with a temp data dir, guaranteed teardown, never touching the system Redis on 6379
result: pass
source: automated
coverage_id: 08-04-D4

### 32. Linter fails a file that adds an enum value with ALTER TYPE ... ADD VALUE and uses that literal in the same file
expected: Linter fails a file that adds an enum value with ALTER TYPE ... ADD VALUE and uses that literal in the same file
result: pass
source: automated
coverage_id: 08-05-D1

### 33. Linter fails unmarked destructive DDL, reporting each violation's own line number
expected: Linter fails unmarked destructive DDL, reporting each violation's own line number
result: pass
source: automated
coverage_id: 08-05-D2

### 34. The marker suppresses only the statement below it, and only with a non-empty reason
expected: The marker suppresses only the statement below it, and only with a non-empty reason
result: pass
source: automated
coverage_id: 08-05-D3

### 35. Linter exits 0 across all 38 existing migrations, none of them edited
expected: Linter exits 0 across all 38 existing migrations, none of them edited
result: pass
source: automated
coverage_id: 08-05-D4

### 36. One migration-applying fixture; three copies become shims retaining only workspace-specific helpers
expected: One migration-applying fixture; three copies become shims retaining only workspace-specific helpers
result: pass
source: automated
coverage_id: 08-06-D1

### 37. No path from the fixture to the dev database; the guard runs before any pool is returned
expected: No path from the fixture to the dev database; the guard runs before any pool is returned
result: pass
source: automated
coverage_id: 08-06-D2

### 38. All three DB-touching workspaces provision their own ephemeral database and tear it down
expected: All three DB-touching workspaces provision their own ephemeral database and tear it down
result: pass
source: automated
coverage_id: 08-06-D3

### 39. Two workspaces running concurrently get physically distinct databases and cannot see each other's rows
expected: Two workspaces running concurrently get physically distinct databases and cannot see each other's rows
result: pass
source: automated
coverage_id: 08-06-D4

### 40. `npm run lint` exits 0 across the whole repository at --max-warnings=0
expected: `npm run lint` exits 0 across the whole repository at --max-warnings=0
result: pass
source: automated
coverage_id: 08-07-D1

### 41. The zero was not reached by shrinking the checked set — file count held above the recorded floor and above 08-03's measurement
expected: The zero was not reached by shrinking the checked set — file count held above the recorded floor and above 08-03's measurement
result: pass
source: automated
coverage_id: 08-07-D2

### 42. No behaviour regression from the cleanup — full workspace suite unchanged
expected: No behaviour regression from the cleanup — full workspace suite unchanged
result: pass
source: automated
coverage_id: 08-07-D3

### 43. No file-level blanket suppression, and every line-scoped directive added names a rule and gives a reason
expected: No file-level blanket suppression, and every line-scoped directive added names a rule and gives a reason
result: pass
source: automated
coverage_id: 08-07-D4

### 44. `npm run failure:429` reproduces a SendGrid rate limit and proves the dispatch claim is released rather than stranded
expected: `npm run failure:429` reproduces a SendGrid rate limit and proves the dispatch claim is released rather than stranded
result: pass
source: automated
coverage_id: 08-08-D1

### 45. `npm run failure:timeout` reproduces an aborted send: stranded dispatching claim, redelivery intercepted with zero further send attempts, terminal failed, one row
expected: `npm run failure:timeout` reproduces an aborted send: stranded dispatching claim, redelivery intercepted with zero further send attempts, terminal failed, one row
result: pass
source: automated
coverage_id: 08-08-D2

### 46. `npm run failure:reset` reproduces the same chain for a socket reset, distinguishable from the timeout scenario by error identity
expected: `npm run failure:reset` reproduces the same chain for a socket reset, distinguishable from the timeout scenario by error identity
result: pass
source: automated
coverage_id: 08-08-D3

### 47. No scenario reaches the real SendGrid endpoint or sends mail; each asserts its injected function's call count rather than trusting absence
expected: No scenario reaches the real SendGrid endpoint or sends mail; each asserts its injected function's call count rather than trusting absence
result: pass
source: automated
coverage_id: 08-08-D4

### 48. Shared fixtures extracted without regressing the suite that used to own them
expected: Shared fixtures extracted without regressing the suite that used to own them
result: pass
source: automated
coverage_id: 08-08-D5

### 49. The full migration chain applies to a guaranteed-empty database, and produces the schema rather than merely not throwing
expected: The full migration chain applies to a guaranteed-empty database, and produces the schema rather than merely not throwing
result: pass
source: automated
coverage_id: 08-09-D1

### 50. Every tenant-scoped table ends the chain with RLS both ENABLED and FORCED; partitions are protected at their parent
expected: Every tenant-scoped table ends the chain with RLS both ENABLED and FORCED; partitions are protected at their parent
result: pass
source: automated
coverage_id: 08-09-D2

### 51. The incremental chain applies over a database already holding rows, preserving every seeded row
expected: The incremental chain applies over a database already holding rows, preserving every seeded row
result: pass
source: automated
coverage_id: 08-09-D3

### 52. Neither run can pass vacuously — run B asserts ≥1 migration applied after the checkpoint and asserts the seeds actually landed before concluding anything from them
expected: Neither run can pass vacuously — run B asserts ≥1 migration applied after the checkpoint and asserts the seeds actually landed before concluding anything from them
result: pass
source: automated
coverage_id: 08-09-D4

### 53. A NOT NULL column with no DEFAULT is proven to be rejected against a populated table
expected: A NOT NULL column with no DEFAULT is proven to be rejected against a populated table
result: pass
source: automated
coverage_id: 08-09-D5

### 54. Filename ordering is defended at its source — listMigrationFiles throws on a non-zero-padded name
expected: Filename ordering is defended at its source — listMigrationFiles throws on a non-zero-padded name
result: pass
source: automated
coverage_id: 08-09-D6

### 55. One migration-application mechanism shared by the fixture and both tests, with no regression to the suites that used the old loop
expected: One migration-application mechanism shared by the fixture and both tests, with no regression to the suites that used the old loop
result: pass
source: automated
coverage_id: 08-09-D7

### 56. The Playwright E2E lane provisions and drops its own ephemeral database through the same functions the vitest suites use
expected: The Playwright E2E lane provisions and drops its own ephemeral database through the same functions the vitest suites use
result: pass
source: automated
coverage_id: 08-10-D1

### 57. An already-running dev stack cannot be reused — the run refuses rather than attaching
expected: An already-running dev stack cannot be reused — the run refuses rather than attaching
result: pass
source: automated
coverage_id: 08-10-D2

### 58. The E2E servers receive no developer configuration — dev:e2e carries no --env-file and the plain dev scripts are untouched
expected: The E2E servers receive no developer configuration — dev:e2e carries no --env-file and the plain dev scripts are untouched
result: pass
source: automated
coverage_id: 08-10-D3

### 59. The run announces which connection string it used, with the password redacted
expected: The run announces which connection string it used, with the password redacted
result: pass
source: automated
coverage_id: 08-10-D4

### 60. No guard, naming or provisioning logic is reimplemented on the Playwright side
expected: No guard, naming or provisioning logic is reimplemented on the Playwright side
result: pass
source: automated
coverage_id: 08-10-D5

### 61. One aggregated run over the backend scope produces one coverage report with one denominator
expected: One aggregated run over the backend scope produces one coverage report with one denominator
result: pass
source: automated
coverage_id: 08-11-D1

### 62. Packages executed but untested appear with real coverage instead of 0%, and apps/web is absent
expected: Packages executed but untested appear with real coverage instead of 0%, and apps/web is absent
result: pass
source: automated
coverage_id: 08-11-D2

### 63. A project whose tests fail fails the whole aggregated run, so no workspace can drop out of the denominator
expected: A project whose tests fail fails the whole aggregated run, so no workspace can drop out of the denominator
result: pass
source: automated
coverage_id: 08-11-D3

### 64. The threshold is the measurement plus a deliberate increment, recorded as an unrounded fraction with its provenance
expected: The threshold is the measurement plus a deliberate increment, recorded as an unrounded fraction with its provenance
result: pass
source: automated
coverage_id: 08-11-D4

### 65. A real separate OS process running the real processSendJob against live services is killed with SIGKILL, not simulated in-process
expected: A real separate OS process running the real processSendJob against live services is killed with SIGKILL, not simulated in-process
result: pass
source: automated
coverage_id: 08-12-D1

### 66. The kill lands inside the claim-committed-but-not-recorded window, driven by an IPC marker rather than a timer or a poll
expected: The kill lands inside the claim-committed-but-not-recorded window, driven by an IPC marker rather than a timer or a poll
result: pass
source: automated
coverage_id: 08-12-D2

### 67. A restart does not re-send: zero further send attempts and no duplicate row
expected: A restart does not re-send: zero further send attempts and no duplicate row
result: pass
source: automated
coverage_id: 08-12-D3

### 68. The scenario is deterministic, not flaky
expected: The scenario is deterministic, not flaky
result: pass
source: automated
coverage_id: 08-12-D4

### 69. The spawn/kill helper is domain-free and adds no dependency on an app workspace
expected: The spawn/kill helper is domain-free and adds no dependency on an app workspace
result: pass
source: automated
coverage_id: 08-12-D5

### 70. No scenario reaches the real SendGrid endpoint; the real queue runtime is never booted
expected: No scenario reaches the real SendGrid endpoint; the real queue runtime is never booted
result: pass
source: automated
coverage_id: 08-12-D6

### 71. Jobs enqueued before a real Redis restart are still waiting after it, and are processed afterwards
expected: Jobs enqueued before a real Redis restart are still waiting after it, and are processed afterwards
result: pass
source: automated
coverage_id: 08-13-D1

### 72. The survival assertion discriminates — the same sequence without the versioned config loses every job
expected: The survival assertion discriminates — the same sequence without the versioned config loses every job
result: pass
source: automated
coverage_id: 08-13-D2

### 73. All five audit-named failure modes run individually and green
expected: All five audit-named failure modes run individually and green
result: pass
source: automated
coverage_id: 08-13-D3

### 74. The 08-11 regression that broke standalone runs of the two config-less packages is fixed
expected: The 08-11 regression that broke standalone runs of the two config-less packages is fixed
result: pass
source: automated
coverage_id: 08-13-D5

### 75. A run exactly at the threshold passes; one line below fails; one line above passes
expected: A run exactly at the threshold passes; one line below fails; one line above passes
result: pass
source: automated
coverage_id: 08-14-D1

### 76. The comparison is the unrounded fraction — 0.84996 fails a 0.85 threshold instead of rounding into a pass
expected: The comparison is the unrounded fraction — 0.84996 fails a 0.85 threshold instead of rounding into a pass
result: pass
source: automated
coverage_id: 08-14-D2

### 77. A report with an empty denominator fails rather than producing NaN
expected: A report with an empty denominator fails rather than producing NaN
result: pass
source: automated
coverage_id: 08-14-D3

### 78. Lowering the recorded threshold is a failing check with no margin, and the introducing-commit case passes cleanly
expected: Lowering the recorded threshold is a failing check with no margin, and the introducing-commit case passes cleanly
result: pass
source: automated
coverage_id: 08-14-D4

### 79. The configuration location is decided in one function, honouring MEGA_CRM_ENV_FILE and defaulting outside the repository
expected: The configuration location is decided in one function, honouring MEGA_CRM_ENV_FILE and defaulting outside the repository
result: pass
source: automated
coverage_id: 08-15-D1

### 80. Every load point calls the resolver; no hardcoded path to the working root survives
expected: Every load point calls the resolver; no hardcoded path to the working root survives
result: pass
source: automated
coverage_id: 08-15-D2

### 81. Neither dev script passes --env-file; both entrypoints load in code early enough for the boot-time schema
expected: Neither dev script passes --env-file; both entrypoints load in code early enough for the boot-time schema
result: pass
source: automated
coverage_id: 08-15-D3

### 82. npm run dev and the full test lane work with no configuration file in the working root
expected: npm run dev and the full test lane work with no configuration file in the working root
result: pass
source: automated
coverage_id: 08-15-D4

### 83. The hygiene check fails on a tree where the blacklisted files are back, and is proven fail-first
expected: The hygiene check fails on a tree where the blacklisted files are back, and is proven fail-first
result: pass
source: automated
coverage_id: 08-15-D5

### 84. Envelope encryption has its own tests: round-trip, non-determinism, and rejection of tampered tag, ciphertext and wrapped key
expected: Envelope encryption has its own tests: round-trip, non-determinism, and rejection of tampered tag, ciphertext and wrapped key
result: pass
source: automated
coverage_id: 08-16-D1

### 85. A payload sealed for one workspace does not decrypt under another's identity
expected: A payload sealed for one workspace does not decrypt under another's identity
result: pass
source: automated
coverage_id: 08-16-D2

### 86. A row inserted under workspace A is invisible to a select under workspace B — asserted directly for the first time
expected: A row inserted under workspace A is invisible to a select under workspace B — asserted directly for the first time
result: pass
source: automated
coverage_id: 08-16-D3

### 87. The tenant context fails closed with no tenant set, does not leak between scopes, and rolls back on a throw
expected: The tenant context fails closed with no tenant set, does not leak between scopes, and rolls back on a throw
result: pass
source: automated
coverage_id: 08-16-D4

### 88. The coverage gate passes, reached by adding tests with the recorded threshold untouched
expected: The coverage gate passes, reached by adding tests with the recorded threshold untouched
result: pass
source: automated
coverage_id: 08-16-D5

### 89. ARCHITECTURE.md covers all five named blocks with exactly one diagram and defers as-built facts
expected: ARCHITECTURE.md covers all five named blocks with exactly one diagram and defers as-built facts
result: pass
source: automated
coverage_id: 08-17-D1

### 90. CONVENTIONS.md records only conventions backed by a real repository file
expected: CONVENTIONS.md records only conventions backed by a real repository file
result: pass
source: automated
coverage_id: 08-17-D2

### 91. The expand/contract marker syntax quoted in the document is what the linter actually accepts
expected: The expand/contract marker syntax quoted in the document is what the linter actually accepts
result: pass
source: automated
coverage_id: 08-17-D3

### 92. The documentation-update rule covers three documents with concrete per-document triggers, and both placeholders are gone
expected: The documentation-update rule covers three documents with concrete per-document triggers, and both placeholders are gone
result: pass
source: automated
coverage_id: 08-17-D4

### 93. Four jobs exist with the required ids, every invoked npm script exists, every action pinned to a full SHA, no sleep
expected: Four jobs exist with the required ids, every invoked npm script exists, every action pinned to a full SHA, no sleep
result: pass
source: automated
coverage_id: 08-18-D1

### 94. All four jobs run green on a real push, with per-job durations recorded
expected: All four jobs run green on a real push, with per-job durations recorded
result: pass
source: automated
coverage_id: 08-18-D2

### 95. Branch protection requires exactly static, test and failure-injection with administrator enforcement on and no bypass
expected: Branch protection requires exactly static, test and failure-injection with administrator enforcement on and no bypass
result: pass
source: automated
coverage_id: 08-18-D3

### 96. A pull request carrying a failing test, a type error and a lint violation cannot be merged
expected: A pull request carrying a failing test, a type error and a lint violation cannot be merged
result: pass
source: automated
coverage_id: 08-18-D4

### 97. A coverage drop below the recorded threshold blocks the pull request
expected: A coverage drop below the recorded threshold blocks the pull request
result: pass
source: automated
coverage_id: 08-18-D5

### 98. The e2e job runs without blocking the merge
expected: The e2e job runs without blocking the merge
result: pass
source: automated
coverage_id: 08-18-D6

### 99. The E2E lane's server runs against the ephemeral database, not the developer's
expected: The E2E lane's server runs against the ephemeral database, not the developer's
result: pass
source: automated
coverage_id: 08-18-D7

### 100. .planning/config.json is on the phase-branch model with no other key changed
expected: .planning/config.json is on the phase-branch model with no other key changed
result: pass
source: automated
coverage_id: 08-18-D8

## Summary

total: 100
passed: 100
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none yet]
