# Deferred Items — Phase 21 (per-contact DSR export)

## Plan 21-06

- **Pre-existing lint errors, out of scope**: `apps/web/src/lib/sentry.ts:98,99,121` — `@typescript-eslint/no-unsafe-assignment` / `no-unsafe-member-access` on `import.meta.env`. Present before this plan (last touched in Phase 15, commit `336da68`); not caused by any file this plan modifies. Not fixed here per the deviation-rules scope boundary (only auto-fix issues directly caused by the current task's changes).
