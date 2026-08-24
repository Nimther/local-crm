---
status: testing
phase: 22-workspace-quiesce-physical-purge
source: [22-VERIFICATION.md]
started: 2026-08-24T12:08:37Z
updated: 2026-08-24T12:08:37Z
---

## Current Test

number: 1
name: Pre-deploy dead-letter backlog review
expected: |
  Before the first production deploy of the dead-letter retention sweep, run the census query
  from plan 22-12's <human-check> against production:

    SELECT count(*), min(failed_at),
           count(*) FILTER (WHERE acknowledged_at IS NULL)
    FROM dead_letter_jobs
    WHERE failed_at < now() - interval '30 days';

  Confirm the row count and the unacknowledged share are what you expect. Rows older than
  DEAD_LETTER_RETENTION_DAYS (default 30) accumulated since Phase 12 will be permanently
  deleted by the first purge tick after deploy. If unacknowledged old failures are still
  under investigation, acknowledge or export them first — acknowledgement does not extend
  a row's life. This confirms data safety of an already-tested implementation; the design
  decision itself (option (b), retention timer, no workspace_id column) is already recorded
  in plan 22-12's frontmatter.
awaiting: user response

## Tests

### 1. Pre-deploy dead-letter backlog review
expected: Production dead_letter_jobs census reviewed; operator confirms the first sweep's permanent deletion of rows older than the retention window is acceptable (or old rows are acknowledged/exported first).
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
