# Deferred Items — Phase 04

Out-of-scope discoveries found during plan execution, logged per the executor's
scope-boundary rule (not fixed, not part of the originating plan's task scope).

## 04-19: pre-existing SEND-05 test/env coupling break (unrelated to CR-01)

- **Found during:** 04-19 Task 1 verification (`npm test -w @mega-crm/worker`)
- **Symptom:** `send-dispatch-idempotency.test.ts` > "SEND-05/SUBS-03: a sendable
  contact is decrypted, gated, sent, and recorded as sent" fails:
  `expected '<http://localhost:4000/unsubscribe/...>' to match
  /^<https:\/\/api\.test\.local\/unsubscribe\/.+>$/`
- **Root cause:** `apps/worker/vitest.config.ts` loads the repo-root `.env` and
  falls back to `PUBLIC_APP_URL ?? "https://api.test.local"` — a fallback, not
  an override. The repo's `.env` now has a real `PUBLIC_APP_URL=http://localhost:4000`
  populated (part of the operational prerequisite tracked in STATE.md
  Blockers/Concerns for the deferred human-verification UAT), so the `??`
  fallback never triggers in this environment and the test's hardcoded
  `https://api.test.local` expectation no longer matches.
- **Reproduced without this plan's changes:** confirmed via `git stash` — the
  same test fails identically on the pre-04-19 tree. Not caused by Task 1 or
  Task 2 of this plan.
- **Scope boundary:** `apps/worker/vitest.config.ts` and this pre-existing
  assertion are outside 04-19's `files_modified` list and outside the CR-01
  gap this plan closes. Per the executor's scope-boundary rule, logged here
  rather than fixed inline.
- **Suggested fix (for a future plan):** make the vitest env block force an
  override for test-only values it needs deterministic (e.g.
  `PUBLIC_APP_URL: "https://api.test.local"` unconditionally, or read a
  distinct `TEST_PUBLIC_APP_URL` var), mirroring the `TEST_DATABASE_URL` /
  `TEST_REDIS_URL` convention already used in the same file for exactly this
  reason.
- **Impact on this plan's own new/modified tests:** none — the new CR-01
  regression test added in Task 1 asserts only the token/URL *shape*
  (`/^<.+\/unsubscribe\/.+>$/`), not the base URL, so it passes regardless of
  which `PUBLIC_APP_URL` value is active.
