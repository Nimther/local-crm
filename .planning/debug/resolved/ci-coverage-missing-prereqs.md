---
status: resolved
trigger: "GitHub Actions PR #9: required test check fails after Phase 14 changes"
created: 2026-08-14T14:00:00+05:00
updated: 2026-08-14T15:05:00+05:00
symptoms_prefilled: true
goal: find_and_fix
---

## Current Focus

hypothesis: "CONFIRMED AND FIXED — the aggregate coverage lane assumed a prebuilt worker and machine-local test secrets that a clean CI checkout did not have"
test: "Complete aggregate coverage plus threshold, ratchet, TypeScript and lint gates"
expecting: "All gates pass without relying on the developer .env for the affected values"
next_action: "commit and push the resolved debug session, then monitor PR #9 checks"

## Symptoms

expected: "The required GitHub Actions test job passes from a clean checkout after npm ci."
actual: "Four test files fail: the production-compose and stop-grace tests cannot import apps/worker/dist/shutdown-budget.js; suppression migration tests have no KMS_LOCAL_KEK; erasure-enqueue-crash imports API code without the API project's boot-required test values."
errors: "Cannot find module apps/worker/dist/shutdown-budget.js; KMS_LOCAL_KEK must be set; Invalid environment configuration -- BETTER_AUTH_SECRET/BETTER_AUTH_URL/WEB_URL/PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM/OPERATOR_ALERT_EMAIL missing."
reproduction: "On PR #9, run npm run coverage in the CI test job after npm ci and docker compose up, without a developer .env and without first building apps/worker."
started: "First surfaced in GitHub Actions run 31788905186 after Phase 14 UAT/security commits were pushed."

## Eliminated

- hypothesis: "Application behavior or Droplet configuration is broken"
  evidence: "All failures happen during test collection/prerequisite resolution on a clean GitHub runner, before the affected application behaviors execute."
  timestamp: 2026-08-14T14:00:00+05:00

## Evidence

- timestamp: 2026-08-14T14:00:00+05:00
  checked: "GitHub Actions test job 94731058828 log"
  found: "9 failed and 1772 passed; every failure is explained by one of the three missing prerequisites."
  implication: "This is a deterministic CI contract gap, not a flaky test."

- timestamp: 2026-08-14T14:00:00+05:00
  checked: "root package.json and project Vitest configs"
  found: "coverage has no precoverage build; packages/db has no test env; apps/worker test env lacks the API values required by its test-only API import."
  implication: "Each fix has a narrow owner and no production secret is needed."

- timestamp: 2026-08-14T15:05:00+05:00
  checked: "targeted regression tests and complete aggregate coverage run"
  found: "production-compose 25/25, stop-grace 3/3, suppression migration 13/13, erasure enqueue 1/1; aggregate 224 files and 1784 tests passed with 87.14% statement coverage."
  implication: "All three CI prerequisite gaps are closed without weakening or skipping tests."

- timestamp: 2026-08-14T15:05:00+05:00
  checked: "coverage gate, coverage ratchet, all workspace builds and eslint"
  found: "all passed; coverage line ratio 0.8847 exceeds threshold 0.8126."
  implication: "The focused fix also satisfies the remaining required local gates."

## Resolution

root_cause: "The aggregate coverage command was not self-contained. Local and earlier UAT runs inherited apps/worker/dist and values from the developer environment, while the clean CI runner correctly exposed those hidden prerequisites."
fix: "Added precoverage worker build; added deterministic test-only API values to the worker Vitest project; added deterministic test-only local KMS values to the DB Vitest project."
verification: "224/224 test files passed (1784 tests, 1 skipped); coverage gate and ratchet passed; all workspace builds and eslint passed."
files_changed:
  - package.json
  - apps/worker/vitest.config.ts
  - packages/db/vitest.config.ts
