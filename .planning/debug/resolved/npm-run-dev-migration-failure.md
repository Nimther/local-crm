---
status: resolved
trigger: "Fix npm run dev migration failure. Migration 0057_send_events_dedup_rebase.sql contains the literal Drizzle delimiter \"--> statement-breakpoint\" inside a comment at line 49. Drizzle splits the migration there, causing statement 2 to start with a backtick and PostgreSQL error 42601: syntax error at or near \"`\". Reword the comment so it does not contain the literal delimiter, add a regression check if appropriate, then verify pending migrations 0055-0061 and npm run dev. The dev database is currently at migration 0054; send-event duplicates and suppression rows are both zero."
created: 2026-08-12
updated: 2026-08-12
---

## Symptoms

DATA_START
- **Expected behavior:** `npm run dev` applies pending migrations 0055–0061 cleanly and starts the dev environment.
- **Actual behavior:** Migration run fails while applying 0057_send_events_dedup_rebase.sql; dev database remains at migration 0054.
- **Error messages:** PostgreSQL error 42601: syntax error at or near "`" — statement 2 of the split migration starts with a backtick.
- **Timeline:** Fails now with pending migrations 0055–0061; DB is at 0054. Send-event duplicates and suppression rows are both zero.
- **Reproduction:** Run `npm run dev` with a dev database at migration 0054; Drizzle attempts to apply 0055–0061 and fails at 0057.
- **User-supplied diagnosis (verify before accepting):** 0057_send_events_dedup_rebase.sql contains the literal Drizzle statement delimiter "--> statement-breakpoint" inside a SQL comment at line 49. Drizzle's migrator splits the file on that literal, so the text after the comment becomes a bogus second statement beginning with a backtick.
- **Requested fix:** Reword the comment so it no longer contains the literal delimiter; add a regression check if appropriate; verify migrations 0055–0061 apply and `npm run dev` works.
DATA_END

## Current Focus

bug_class: Bohrbug — fully deterministic, content-derived. Same file bytes produce the same split on every run; no timing, concurrency, or environment dependence.
hypothesis: CONFIRMED — the literal string "--> statement-breakpoint" inside the backticked comment at line 49 of 0057_send_events_dedup_rebase.sql is split on by drizzle-orm's readMigrationFiles (plain String.split, no comment awareness), producing chunk 2 that begins with a backtick, which PostgreSQL rejects with 42601.
test: source-level trace of the migrator split path + empirical re-split of the real file
expecting: exactly 2 chunks, chunk 2 starting with "`"
next_action: none — RESOLVED. All 6 signals pass. Self-verifiable four (1 chunk; 27/27; 62 files no violations, exit 0; 0 delimiter occurrences in 0055-0061) plus the two once thought to need a human: 0055-0061 applied live and the journal reached 0061, and `npm run dev` started api/web/worker cleanly then shut down clean. NOTE: the "start the Docker daemon" instruction recorded here earlier was WRONG — there is no Docker on this machine; Postgres 17 is a Homebrew service and was reachable all along. Only the TDD-red acknowledgement remains outstanding, and it is informational: red was machine-verified twice but never user-confirmed (autonomous run, no AskUserQuestion), surfaced in the final report rather than blocking. Session archived and committed.

reasoning_checkpoint:
  hypothesis: "The literal `--> statement-breakpoint` inside the backticked code span in 0057's line-49 comment is consumed as a real delimiter by drizzle-orm's readMigrationFiles (a plain String.split over raw bytes, no comment awareness), splitting the file into 2 chunks; chunk 2 begins with the code span's closing backtick, which PostgreSQL rejects with 42601 syntax error at or near \"`\", aborting the migration transaction and leaving the dev DB at 0054."
  confirming_evidence:
    - "Direct read: line 49 is `-- \\`--> statement-breakpoint\\` convention gives no loop construct at all. The` — literal present inside a comment, mid-line, with prose after it."
    - "Direct source read of node_modules/drizzle-orm/migrator.js line 16: `query.split(\"--> statement-breakpoint\")` on raw file text, no comment/quote awareness; pg-core/dialect.js lines 60-71 then executes every chunk via tx.execute(sql.raw(stmt))."
    - "Traced the actual runtime path to that code: predev -> scripts/migrate-dev.mjs -> drizzle-kit migrate -> preparePostgresDB (pg driver) -> drizzle-orm/node-postgres/migrator -> readMigrationFiles. Not assumed from the package name."
    - "Empirical re-split of the real file with the identical call: exactly 2 chunks; chunk 1's literal first character is \"`\" — reproduces the reported 42601 at statement 2 precisely."
    - "0057 contains exactly ONE occurrence of the literal (grep -c = 1), so exactly one split point and one candidate origin for the backtick."
  falsification_test: "Splitting the real 0057 bytes on the literal yields either 1 chunk, or a chunk 2 whose first non-whitespace character is NOT a backtick. Either outcome refutes the hypothesis. Observed: 2 chunks, chunk 2 starts with \"`\" — not refuted. Post-fix inverse: after dropping the \"-->\", the same split must yield 1 chunk."
  fix_rationale: "Root cause is the presence of the delimiter literal in a context where it was meant as prose. Removing the literal (rewording to `statement-breakpoint`, dropping the arrow) eliminates the split point itself, so the file returns to the single un-split chunk the repo's runner model expects. This addresses the cause, not the symptom: the alternative symptom-level patches (escaping the backtick, or inserting real breakpoints between 0057's four statements to make the halves individually valid) would leave the accidental split in place and change the file's transaction/statement shape for reasons unrelated to the actual defect."
  blind_spots:
    - "Cannot apply migrations against a live Postgres in this session — Docker daemon is down. The apply of 0055-0061 and `npm run dev` are therefore unverified end to end and go to a human-verify checkpoint."
    - "Verified 0057's own SQL is otherwise sound only by reading, not by execution; if 0057 has an unrelated second defect it would surface only on the real apply. Mitigated by the fact that the reported error is at statement 2 of the split, i.e. before any real DDL ran."
    - "The new lint rule is lexical: a delimiter alone on its own line inside a dollar-quoted ($$...$$) body would pass it and still split. No migration does this today; documented as a scope limit in the rule, matching the file's existing documented limitation."
  candidate_causes:
    - "code/content (migration file text): the delimiter literal embedded in prose — CONFIRMED as the cause."
    - "tooling/config (drizzle-kit or drizzle-orm behaviour, e.g. a breakpoints:false setting or a version regression): ELIMINATED — the split is unconditional in drizzle-orm's readMigrationFiles with no config flag; the journal's per-entry `breakpoints` field is read into `bps` but never consulted before the split."
    - "environment (dev DB state at 0054, unapplied 0055/0056 leaving a precondition unmet): ELIMINATED as a cause of THIS error — 42601 is a parse-time syntax error raised before any statement in 0057 executes, and it is reported at statement 2 of the split. DB state cannot produce a syntax error."
    - "data (surviving send_event duplicates tripping 0057's Step 0 fail-closed guard): ELIMINATED — that guard raises a distinct RAISE EXCEPTION message, not 42601, and the reported duplicate/suppression counts are both zero."
  and_gate: "no — a single condition is sufficient and necessary. The split happens on file content alone, independent of DB state, role, data volume, or timing; and it is unavoidable once the literal is present. Removing that one condition restores a 1-chunk file. Confirmed by the fact that the corpus scan found exactly one non-conforming occurrence in 98 across 62 files, and the error signature matches that one occurrence's following character exactly."

tdd_checkpoint:
  test_file: "packages/test-support/src/__tests__/migration-lint.test.ts"
  test_name: "lintMigrationDirectory > has no misplaced statement delimiter in any real migration (plus the pre-existing 'reports zero violations across every real migration')"
  status: "green"
  oracle_type: "derived — the assertion encodes drizzle's own splitting contract (delimiter is consumed as a statement boundary over raw bytes), not a crash check"
  green_output: |
    RUN  v4.1.9 /Users/primeropanther/Projects/mega-crm/packages/test-support
    Test Files  1 passed (1)
         Tests  27 passed (27)
      Duration  672ms
    (invocation: `cd packages/test-support && npx vitest run src/__tests__/migration-lint.test.ts` —
     byte-identical to the invocation the session manager used to verify RED, so red->green is a
     like-for-like comparison and not an artifact of a different vitest config resolution)
  red_confirmation: "MACHINE-verified only (session manager re-ran the suite directly). AskUserQuestion was unavailable, so the interactive human 'confirm red' gate was never presented. Human acknowledgement is DEFERRED to the terminal verification checkpoint. NOT recorded as user confirmation."
  failure_output: |
    FAIL src/__tests__/migration-lint.test.ts > lintMigrationDirectory > has no misplaced statement delimiter in any real migration
    AssertionError: expected [ { …(4) } ] to deeply equal []
    + {
    +   "detail": "line 49 has text after the drizzle delimiter \"--> statement-breakpoint\" (\"` convention gives no loop construct at …\"); drizzle splits the raw file on that literal even inside a comment, so this text becomes the start of the next statement. Reword the prose so it does not contain the literal (dropping the \"-->\" is enough).",
    +   "file": "0057_send_events_dedup_rebase.sql",
    +   "line": 49,
    +   "rule": "statement-breakpoint-misplaced",
    + }
    Test Files  1 failed (1)
         Tests  2 failed | 25 passed (27)

verification_split:
  self_verifiable_here:
    - "Re-split of fixed 0057 yields exactly 1 chunk (node one-liner on the real bytes)."
    - "`npx vitest run packages/test-support/src/__tests__/migration-lint.test.ts` -> 27/27 green."
    - "`npm run lint:migrations` -> passes, 62 files checked."
    - "Static scan of 0055-0061 for the same defect class -> only 0057 was affected."
  requires_human_or_live_db:
    - "Applying migrations 0055-0061 against the dev DB (currently at 0054) — Docker daemon is down in this session."
    - "`npm run dev` starting api/web/worker cleanly after the migrations apply."

## Evidence

- timestamp: 2026-08-12
  checked: packages/db/migrations/0057_send_events_dedup_rebase.sql line 49
  found: Line 49 is `-- \`--> statement-breakpoint\` convention gives no loop construct at all. The` — the literal Drizzle delimiter appears inside a `--` comment, wrapped in backticks, mid-line with prose after it.
  implication: User-supplied diagnosis's premise is factually correct as to file content.

- timestamp: 2026-08-12
  checked: Migration execution path — root package.json predev -> scripts/migrate-dev.mjs -> `npm run db:migrate` -> packages/db `drizzle-kit migrate` (drizzle-kit 0.31.10)
  found: drizzle-kit bin.cjs migrate handler (line ~92042) calls preparePostgresDB().migrate; for the `pg` driver (line ~78873) that is `migrate` imported from `drizzle-orm/node-postgres/migrator`, which calls `readMigrationFiles` from `drizzle-orm/migrator.js`.
  implication: The splitting code that matters is drizzle-orm's, not drizzle-kit's own BREAKPOINT constant (which is write-only, used by `generate`).

- timestamp: 2026-08-12
  checked: node_modules/drizzle-orm/migrator.js line 16 and pg-core/dialect.js migrate() lines 44-72
  found: `query.split("--> statement-breakpoint")` — a plain String.split on raw file bytes, with NO comment awareness, no trimming, no empty-chunk filtering. Every resulting chunk is then executed verbatim via `tx.execute(sql.raw(stmt))` inside one transaction.
  implication: Any occurrence of the literal anywhere in the file — including inside a comment or a string — splits the migration. The delimiter is itself a `--` comment, which is precisely why it can hide inside another comment undetected.

- timestamp: 2026-08-12
  checked: Empirical re-split of the real 0057 file with the exact same String.split call
  found: 2 chunks. Chunk 0 = 3250 bytes, entirely `--` comment lines (harmless no-op to Postgres). Chunk 1 = 14129 bytes, first characters are exactly "` convention gives no loop construct at all. The\n-- deletion therefore lives OUT...".
  implication: Chunk 1 begins with a bare backtick — reproduces PostgreSQL 42601 `syntax error at or near "\`"` exactly as reported, at statement 2. Root cause mechanism confirmed end to end, not inferred.

- timestamp: 2026-08-12
  checked: Alternative origins for the backtick, to rule out that it comes from somewhere other than the line-49 comment
  found: The backtick is not a separate stray character — it is the closing/opening backtick of the inline code span around the delimiter in the comment prose. 0057 contains exactly ONE occurrence of the delimiter literal (grep -c = 1), so exactly one split point, and the character immediately following it in the raw bytes is "`". No other migration file in 0050-0061 contains the literal at all.
  implication: There is no second, independent source of the error. Single root cause; AND-gate does not fire.

- timestamp: 2026-08-12
  checked: Whether the delimiter can simply be banned from migrations (breadth check across all 62 migration files)
  found: 17 other migrations use the delimiter LEGITIMATELY (drizzle-kit `generate` output) — 0000 (14x), 0026 (24x), 0022 (8x), 0015 (7x), etc. 98 total occurrences across the directory. Legit occurrences take two forms: alone on its own line, and appended directly after a statement's `;` (e.g. `... ON UPDATE no action;--> statement-breakpoint`).
  implication: A blanket ban is wrong and would break 17 files. The rule must discriminate legitimate delimiter placement from a delimiter buried in prose.

- timestamp: 2026-08-12
  checked: Candidate lexical rule — delimiter must be preceded by start-of-file, "\n", or ";" AND followed by end-of-line/end-of-file — run against all 98 occurrences in all 62 files
  found: 97 of 98 occurrences conform. Exactly ONE non-conforming occurrence: 0057 line 49, preceded by "`" and followed by "`".
  implication: Zero false positives on the entire existing corpus, and it catches the actual defect. Also catches mid-line occurrences inside dollar-quoted bodies, which a comment-state-machine rule would miss. This is the regression guard to implement.

- timestamp: 2026-08-12
  checked: scripts/lint-migrations.mjs (existing migration linter, wired as `npm run lint:migrations`) and its test file packages/test-support/src/__tests__/migration-lint.test.ts, with fixtures in tools/migration-fixtures/
  found: Linter already exists with 2 rules (enum-add-value-used-same-file, destructive-ddl-unmarked), exported as pure functions plus a CLI. Its own header states the governing convention: "this repo applies each migration file as one client.query(sql) call".
  implication: The recurrence guard belongs here as a third rule — infrastructure, fixtures, and test harness already exist. Note the repo convention explains why 0055-0061 carry ZERO intentional breakpoints: hand-written migrations are meant to be one un-split chunk, so the fix must REMOVE the accidental split, never add real breakpoints.

- timestamp: 2026-08-12
  checked: Whether a hand-written migration with ZERO breakpoints and MANY statements actually applies under this runner — i.e. whether the correct fix is "reword the comment" or "add real breakpoints between 0057's four statements". Used migration 0020_send_events_partitioned.sql, which is already APPLIED (dev DB is at 0054).
  found: 0020 contains 0 occurrences of the delimiter and 8 statement-terminating semicolons outside comments (CREATE TABLE ... PARTITION BY RANGE, 3x CREATE TABLE ... PARTITION OF, CREATE INDEX, 2x ALTER TABLE, CREATE POLICY). It applied successfully as one un-split chunk.
  implication: PRODUCTION PROOF that a single multi-statement chunk is the intended and working shape for hand-written migrations here, matching the linter header's stated convention ("this repo applies each migration file as one client.query(sql) call"). So the fix is to REMOVE the accidental split point by rewording the prose — NOT to add real `--> statement-breakpoint` separators to 0057. Adding them would change 0057's statement shape for no reason related to the defect.

- timestamp: 2026-08-12
  checked: Added rule 3 `statement-breakpoint-misplaced` to scripts/lint-migrations.mjs (delimiter must end its line AND follow either a whitespace-only prefix or a completed `;`), then ran the full migration-lint suite as the TDD RED step.
  found: 2 tests FAIL — both `lintMigrationDirectory` corpus assertions — reporting exactly one violation: 0057_send_events_dedup_rebase.sql line 49, rule statement-breakpoint-misplaced. 25 tests PASS, including all 8 new rule-correctness tests (bad/good fixtures, minimum single-trailing-character case, the 5 boundary-neighbour accepted forms, the unterminated-statement shape, and prose naming the convention without the arrow).
  implication: RED achieved, and it is red for the right reason — the guard bites on the real defect and on nothing else in the 62-file corpus. Rule correctness is independently proven by the 8 passing tests, so the 2 failures are attributable to the migration content, not to a faulty rule.

- timestamp: 2026-08-12
  checked: Docker daemon availability for live migration verification (`docker ps`)
  found: "failed to connect to the docker API at unix:///var/run/docker.sock ... daemon not running". No Postgres reachable.
  implication: Applying 0055-0061 against the real dev DB cannot be self-verified in this session; that half of verification must go to a human-verify checkpoint. Everything else (split behavior, linter rule, static scan of 0055-0061) is verifiable here and deterministically so.

- timestamp: 2026-08-12
  checked: Independent RED confirmation by the debug session manager — re-ran `npx vitest run src/__tests__/migration-lint.test.ts` from packages/test-support directly, rather than trusting the investigator's reported output.
  found: Reproduced exactly — 2 tests failed, 25 passed (27 total), with the sole violation being 0057_send_events_dedup_rebase.sql line 49, rule statement-breakpoint-misplaced. Matches the investigator's report byte for byte.
  implication: The TDD red state is machine-verified, not merely reported. NOTE ON THE TDD GATE — AskUserQuestion was NOT available to the session manager in this session, so the human "confirm the test is red" gate could not be presented interactively. Red was therefore established by direct test execution and human confirmation is DEFERRED to the terminal verification checkpoint (which is required regardless, because the Docker daemon is down and the live migration apply cannot be self-verified). This is explicitly NOT recorded as user confirmation.

- timestamp: 2026-08-12
  checked: GREEN PHASE — applied the one-line reword to 0057 line 49 (dropped the "-->"), then ran all four self_verifiable_here checks. Actual output recorded, not expected output.
  found: |
    (1) Re-split of the FIXED file with drizzle's identical `raw.split("--> statement-breakpoint")`:
        `chunks: 1` — chunk[0] bytes=17399, firstChar="-". The inverse of the falsification test holds.
        Byte math reconciles exactly and independently confirms nothing else changed: the two RED
        chunks were 3250 + 14129 = 17379, plus the 24-byte delimiter that had been consumed by the
        split = 17403, minus the 4 bytes removed ("-->" + its space) = 17399. Exact match.
    (2) `cd packages/test-support && npx vitest run src/__tests__/migration-lint.test.ts`
        -> Test Files 1 passed (1); Tests 27 passed (27). Was 2 failed | 25 passed. 27/27 green.
    (3) `npm run lint:migrations` -> "lint:migrations — 62 file(s) checked, no violations.",
        exit code 0 (verified separately; the shell's PIPESTATUS was empty on the first attempt
        under zsh, so the code was re-checked with a direct `$?` read rather than assumed).
    (4) Static scan of the pending range: 0055, 0056, 0057, 0058, 0059, 0060, 0061 each contain
        0 occurrences of the delimiter literal. 0057 went 1 -> 0; no sibling was ever affected.
  implication: |
    GREEN achieved by removing the split point, not by masking the symptom — the file is once again
    the single un-split chunk the repo's runner convention (and migration 0020's applied precedent)
    expects, and 0057 carries zero delimiters like every other hand-written migration in the range.
    The recurrence guard that was RED on this exact defect is now green while still passing all 8
    rule-correctness tests, so the guard did not go green by being weakened. Note the guard's own
    scope is unchanged: 62 files checked before and after, i.e. adding the delimiter literal to
    CONVENTIONS.md prose did not enter the linter's corpus (it walks packages/db/migrations only).

- timestamp: 2026-08-12
  checked: CONVENTIONS.md — wrote the human half of rule 3 into the "Expand/contract" section, alongside the two rules already documented there.
  found: Added the binding rule (two accepted delimiter placements), the mechanism (raw-byte split, no comment awareness, delimiter is itself a `--` comment), the 42601 incident as the worked example, the instruction to write `statement-breakpoint` WITHOUT the arrow when prose must name the convention, and the corollary that a hand-written migration carries zero delimiters and applies as one chunk (0020's 8 statements as proof). Also corrected the section's closing line from "Both rules are enforced" to "All three rules are enforced" — it would otherwise have undercounted the moment rule 3 landed.
  implication: The guard now exists in both halves the repo's escape-hatch policy requires — enforced in scripts/lint-migrations.mjs AND stated in prose a reviewer reads before writing a migration. A future author who needs to discuss the convention in a comment now has the safe wording written down, which is the specific failure mode that produced this bug.

- timestamp: 2026-08-12
  checked: CORRECTION to the earlier "no Postgres reachable" conclusion. That conclusion came from `docker ps` ALONE and was wrong — this machine has no Docker Desktop/OrbStack/colima at all. The dev Postgres runs as a Homebrew service.
  found: `brew services list` shows `postgresql@17 started` and `redis started`; port 5432 OPEN and 6379 OPEN. The database was reachable the entire time.
  implication: The human-verify checkpoint was NOT actually blocked. Lesson for this repo's debug sessions — probe the actual port/service, never infer DB availability from `docker ps`. Live verification proceeded autonomously from here. (.env is tool-denied, but scripts/migrate-dev.mjs loads it via Node's own process.loadEnvFile, so DATABASE_URL resolves at runtime without any tool ever reading .env.)

- timestamp: 2026-08-12
  checked: BEFORE state of the dev DB — mapped drizzle journal entries to applied rows in drizzle.__drizzle_migrations.
  found: 62 journal entries, 55 applied rows, latest applied = 0054_dead_letter_jobs, 7 PENDING = 0055_webhook_ingress_durability, 0056_workspace_daily_rollup_dirtied_at, 0057_send_events_dedup_rebase, 0058_reputation_and_ingestion_alert_state, 0059_contact_erasure, 0060_suppression_hash_expand, 0061_suppression_hash_contract.
  implication: Independently confirms the reported starting condition (DB pinned at 0054 with exactly 0055-0061 unapplied) — the symptom's environment claim was accurate, not assumed.

- timestamp: 2026-08-12
  checked: LIVE APPLY — ran `node scripts/migrate-dev.mjs` (the exact predev path that was failing) against the real dev Postgres.
  found: `[✓] migrations applied successfully!`, exit code 0. No 42601, no `syntax error at or near "\`"`, no rollback.
  implication: ROOT CAUSE FIX CONFIRMED END TO END against a real database. This closes the investigator's blind spot #2 — 0057's DDL had never executed anywhere before (the 42601 fired at chunk 2 of the accidental split, before any statement ran), so this is the first proof the migration body itself is sound, not just parseable.

- timestamp: 2026-08-12
  checked: AFTER state of the dev DB, same journal-to-DB mapping.
  found: 62 journal entries, 62 applied rows, 0 pending, latest applied = 0061_suppression_hash_contract. All seven of 0055-0061 = APPLIED.
  implication: The journal reached 0061. The original symptom ("dev database remains at migration 0054") is fully resolved.

- timestamp: 2026-08-12
  checked: LIVE DEV STACK — ran `npm run dev` from the repo root in an isolated process group, polled for readiness, then shut it down.
  found: All three services started cleanly. api: `Server listening at http://127.0.0.1:4000` (also 192.168.31.118:4000), bound *:4000. web: `VITE v8.1.3 ready in 356 ms` -> http://localhost:5173/. worker: `apps/worker started (20 BullMQ worker(s) registered: events:ingest, imports:csv, email-broadcast, email-triggered, campaign-kickoff, campaign-scheduler, webhook-events, analytics-reconciliation, flow-run-advance, flow-reconciliation, flow-trigger-evaluator, flow-segment-sweep, flow-segment-sweep-flow, flow-enroll-existing, partition-maintenance, send-reconciler, webhook-replay-sweep, reputation-tick, erasure-scrub, erasure-scrub-reclaim)`; partition-maintenance ran to completion. The predev migrate step ran as a no-op. ZERO fatal signals — no ELIFECYCLE, no `exited with code N`, no EADDRINUSE, no MODULE_NOT_FOUND, no level 50/60 log lines.
  implication: `npm run dev` works. Original symptom fully resolved. Shutdown was clean: 0 processes remaining in the group, ports 4000/5173 released — no dev stack left running.

- timestamp: 2026-08-12
  checked: An apparent error flood in the dev log — hundreds of POST /webhooks/sendgrid/... requests returning 429.
  found: Unrelated to this bug and NOT a startup failure. A live ngrok tunnel (goggles-tuition-twerp.ngrok-free.dev, arriving via 127.0.0.1) delivers real SendGrid webhook traffic to localhost:4000; the backlog accumulated while nothing was listening on 4000, and @fastify/rate-limit correctly shed it with 429 "Rate limit exceeded, retry in 5 seconds" after the first ~20 succeeded with 200.
  implication: This is the rate limiter working as designed, not a regression. Flagged as an OBSERVATION for the user, not a finding of this session: starting the dev stack on this machine ingests real webhook traffic through that tunnel as a side effect.

## Eliminated

- hypothesis: The backtick in the error comes from some source other than the line-49 comment (e.g. a stray shell/markdown artifact elsewhere in the file, or a templating bug injecting backticks)
  evidence: 0057 contains exactly one occurrence of the delimiter; splitting the real file bytes on it yields chunk 2 whose literal first character is the backtick that closes the comment's inline code span. Reproduced deterministically. No other candidate backtick precedes any statement boundary.
  timestamp: 2026-08-12

- hypothesis: drizzle-kit's own BREAKPOINT constant / a drizzle-kit-side splitter is responsible, so the fix might belong in tooling config (e.g. a `breakpoints: false` setting)
  evidence: drizzle-kit's BREAKPOINT is used only by `writeResult` (the `generate` path). The `migrate` path delegates to drizzle-orm's readMigrationFiles, which splits unconditionally with no config flag to disable it. The journal's per-entry `breakpoints` field is read into `bps` but the split happens before and regardless of it.
  timestamp: 2026-08-12

- hypothesis: A blanket "no --> statement-breakpoint in hand-written migrations" lint rule is the right guard
  evidence: 17 generated migrations legitimately contain 97 occurrences; a blanket ban fails the whole corpus.
  timestamp: 2026-08-12

## Resolution

root_cause: |
  CONFIRMED (single cause; AND-gate does not fire). packages/db/migrations/0057_send_events_dedup_rebase.sql line 49 quotes the drizzle statement delimiter as prose inside a `--` comment:

      -- `--> statement-breakpoint` convention gives no loop construct at all. The

  drizzle-orm's readMigrationFiles (node_modules/drizzle-orm/migrator.js:16) splits every migration on that literal with a plain `query.split("--> statement-breakpoint")` over the RAW file bytes — no comment awareness, no quote awareness, no trimming, no empty-chunk filtering — and PgDialect.migrate (pg-core/dialect.js:60-71) then executes each resulting chunk verbatim with `tx.execute(sql.raw(chunk))` inside one transaction. The delimiter is itself a `--` comment, which is exactly why it stayed invisible to review while remaining fully active as a delimiter.

  0057 therefore splits into 2 chunks: chunk 1 (3250 bytes) is entirely comment lines and is a harmless no-op, while chunk 2 (14129 bytes) begins with the closing backtick of that inline code span — `"` convention gives no loop construct at all..."` — which PostgreSQL rejects with 42601 syntax error at or near "`". The transaction aborts, nothing in 0057 is applied, and because drizzle applies pending migrations inside a single transaction the whole 0055-0061 run rolls back, leaving the dev DB pinned at 0054.

  The reported "statement 2" in the error is literally chunk index 1 of this accidental split — not a real second SQL statement in the file. The file was written to be one un-split chunk (0 intentional breakpoints), which is the repo's documented convention for hand-written migrations.

fix: |
  APPLIED. Rewrote line 49 of packages/db/migrations/0057_send_events_dedup_rebase.sql to drop the "-->" so the prose no longer contains the delimiter literal:
    - before: -- `--> statement-breakpoint` convention gives no loop construct at all. The
    - after:  -- `statement-breakpoint` convention gives no loop construct at all. The
  One line, 4 bytes removed, no SQL touched. This removes the split point itself, restoring the single-chunk shape (verified: 1 chunk, 17399 bytes). Explicitly did NOT add real breakpoints to 0057 — migration 0020 proves a multi-statement single chunk is the working, intended shape here.

  RECURRENCE GUARD (applied; was RED against the unfixed migration, now GREEN): new rule 3 `statement-breakpoint-misplaced` in scripts/lint-migrations.mjs, wired into lintMigrationFile so it runs under `npm run lint:migrations` and under the existing corpus test. The delimiter must end its line and must follow either a whitespace-only prefix or a completed `;`. Validated against all 98 occurrences in the 62-file corpus: 97 conform, 1 violation (the defect). Zero false positives on the 17 drizzle-kit-generated migrations that use the delimiter legitimately.

verification: |
  COMPLETE — both halves verified. 6/6 signals PASS. No accepted debt.

  guardrail_verdict: passed

  SELF-VERIFIED HERE (4/4, actual output in the green-phase Evidence entry):
    - signal: reproduction inverted (falsification test run in reverse) -> PASS. Re-split of the
      fixed bytes with drizzle's identical call yields 1 chunk (was 2, chunk 2 starting with "`").
      Byte math reconciles exactly (17379 + 24 - 4 = 17399), proving only the 4 intended bytes moved.
    - signal: regression test red -> green -> PASS. 27/27, up from 2 failed | 25 passed, using the
      byte-identical invocation that established red.
    - signal: guard not weakened to pass -> PASS. All 8 rule-correctness tests still pass, so the
      suite went green because the migration was fixed, not because the rule was loosened. Corpus
      size unchanged at 62 files.
    - signal: defect class swept, not just the one instance -> PASS. All of 0055-0061 contain 0
      delimiter occurrences; the full 62-file corpus reports no violations, exit code 0.

  LIVE-VERIFIED AGAINST THE REAL DEV DATABASE (the two signals previously thought to need a human).
  The earlier "Docker daemon down -> no Postgres reachable" conclusion was WRONG — it rested on
  `docker ps` alone, and this machine has no Docker at all; Postgres 17 runs as a Homebrew service
  and was reachable the whole time (5432 open, redis on 6379).
    - signal: pending migrations 0055-0061 apply cleanly -> PASS. `node scripts/migrate-dev.mjs`
      (the exact failing predev path) returned `[✓] migrations applied successfully!`, exit 0.
      No 42601, no `syntax error at or near "\`"`, no rollback. DB went 55 -> 62 applied rows,
      latest 0054_dead_letter_jobs -> 0061_suppression_hash_contract, pending 7 -> 0. This also
      closes the "0057's DDL has never executed anywhere" blind spot — the SQL body is sound.
    - signal: `npm run dev` starts api/web/worker cleanly -> PASS. api `Server listening at
      http://127.0.0.1:4000`; web `VITE v8.1.3 ready in 356 ms` on :5173; worker `apps/worker
      started (20 BullMQ worker(s) registered)` with partition-maintenance completing. Zero fatal
      signals (no ELIFECYCLE / exited-with-code / EADDRINUSE / MODULE_NOT_FOUND / level 50-60).
      Stack then shut down cleanly — 0 processes left, ports 4000/5173 released.

  TDD RED PROVENANCE (honest record): red was machine-verified TWICE — by the investigator, then by
  an independent session-manager re-run that matched byte for byte (2 failed | 25 passed of 27, sole
  violation 0057:49). It was never confirmed by the user, because AskUserQuestion was unavailable and
  this was an autonomous run. Recorded as machine-verified, explicitly NOT as user acknowledgement;
  surfaced plainly in the final report for the user to acknowledge retrospectively.

postmortem: |
  why not caught: no gate existed for this class. The delimiter is itself a `--` comment, so quoting
  it as prose looked inert to human review while remaining fully active as a split point, and no
  lint rule or test inspected migration text for it. Human review alone could never reliably catch
  this — the defect is invisible precisely because it is a comment inside a comment.
  guard: rule 3 `statement-breakpoint-misplaced` in scripts/lint-migrations.mjs, enforced by
  `npm run lint:migrations` and by the 62-file corpus test in migration-lint.test.ts, with two
  fixtures pinning the good/bad shapes and 8 rule-correctness tests.
  known scope limit: the rule is lexical — a delimiter alone on its own line inside a `$$...$$`
  dollar-quoted body would pass it and still split the file. No migration does this today; this
  matches the linter's existing documented limitation and is recorded rather than silently ignored.

files_changed:
  - scripts/lint-migrations.mjs (rule 3 statement-breakpoint-misplaced + header)
  - packages/test-support/src/__tests__/migration-lint.test.ts (8 new tests + regression seed)
  - tools/migration-fixtures/bad-breakpoint-in-comment.sql (new)
  - tools/migration-fixtures/good-breakpoint-placement.sql (new)
  - packages/db/migrations/0057_send_events_dedup_rebase.sql (DONE — line 49 reword, the actual fix)
  - CONVENTIONS.md (DONE — rule 3's written half in "Expand/contract", plus "Both rules" -> "All three rules")

committed: |
  Committed in archive_session after live verification passed, on branch
  gsd/phase-13-compliance-analytics-integrity (commit_docs: true, so this session doc is
  force-added — .planning/ is gitignored but resolved debug docs are tracked by precedent).

  da6e776 fix(db): stop 0057 splitting itself on a quoted drizzle delimiter
    - packages/db/migrations/0057_send_events_dedup_rebase.sql (the 1-line fix)
    - scripts/lint-migrations.mjs (rule 3 statement-breakpoint-misplaced)
    - packages/test-support/src/__tests__/migration-lint.test.ts (8 new tests + regression seed)
    - tools/migration-fixtures/bad-breakpoint-in-comment.sql (new)
    - tools/migration-fixtures/good-breakpoint-placement.sql (new)
    - CONVENTIONS.md (rule 3's written half)
    6 files changed, 216 insertions(+), 3 deletions(-)

  This session doc was committed immediately after, in a separate docs commit.

observation_for_user: |
  Not a finding of this session, but worth knowing: a live ngrok tunnel
  (goggles-tuition-twerp.ngrok-free.dev) forwards real SendGrid webhook traffic to localhost:4000,
  so starting the dev stack immediately ingests a backlog of real webhook events. During the
  verification run the first ~20 returned 200 and the rest were correctly shed with 429 by
  @fastify/rate-limit. That 429 flood in the dev log is the rate limiter working as designed —
  not a regression, and unrelated to the migration bug.
