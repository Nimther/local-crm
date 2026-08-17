# Deferred Items — Phase 15

Out-of-scope discoveries found during plan execution, logged per the executor's
SCOPE BOUNDARY rule (only auto-fix issues directly caused by the current task's
changes; everything else is recorded here, not fixed).

## Plan 15-22 (gap closure, G-15-4)

- **`npm run lint` fails on two pre-existing errors unrelated to this plan's
  files**, discovered while running Task 3's own `<verify>` command:
  - `apps/web/src/lib/sentry.ts:98,99,121` — `@typescript-eslint/no-unsafe-assignment`
    / `@typescript-eslint/no-unsafe-member-access` on `import.meta.env` access
    (last touched by plan 15-11, `336da68`).
  - `apps/worker/src/__tests__/correlation-tracer.test.ts:231` —
    `@typescript-eslint/require-await` on an async `sendMail` stub with no
    `await` inside (last touched by plan 15-19, `b22e045`).
  - Neither file was created or modified by plan 15-22; `npx eslint
    scripts/validate-alloy-config.mjs scripts/__tests__/validate-alloy-config.test.mjs
    --max-warnings=0` passes cleanly with zero errors. Not fixed here per the
    executor's scope boundary — flagged for the phase's own lint/cleanup pass
    or the plans that introduced them.

## Post-merge test gate, gaps-only run (2026-08-17)

- **`sentry.test.ts` "with no DSN configured" tests (api + worker) are fragile
  against ambient machine env.** They fail on any machine whose
  `~/.config/mega-crm/.env` defines `SENTRY_DSN_API`/`SENTRY_DSN_WORKER`
  (added there during the 2026-08-16 phase-15 UAT session), because the vitest
  configs load that file and `initSentry({})` falls back to `env.SENTRY_DSN_*`.
  Verified: both files pass 4/4 and 6/6 with the same env file minus the two
  SENTRY lines; CI is unaffected (no env file). Not caused by any phase-15 plan's
  code. Suggested hardening for a cleanup pass: have these tests explicitly clear
  `SENTRY_DSN_API`/`SENTRY_DSN_WORKER` (e.g. `vi.stubEnv`) so they assert the
  no-DSN path regardless of the developer's local UAT configuration.
