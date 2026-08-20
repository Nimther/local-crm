---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
reviewed: 2026-08-20T00:00:00Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - .github/workflows/images.yml
  - apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts
  - apps/api/src/modules/analytics/dashboard.repository.ts
  - apps/web/vite.config.ts
  - docker/docker-compose.prod.yml
  - docker/prod.env.example
  - docs/runbooks/backups.md
  - docs/runbooks/restore-drill.md
  - packages/db/src/__tests__/pg-timezone.test.ts
  - packages/db/src/__tests__/pool-factory.test.ts
  - packages/db/src/__tests__/replay-webhook-journal-cli.test.ts
  - packages/db/src/pool.ts
  - scripts/__fixtures__/prod-compose/db-mutable-image-tag.yml
  - scripts/__fixtures__/prod-compose/pgbackrest-missing-data-volume.yml
  - scripts/__fixtures__/prod-compose/pgbackrest-missing-mem-limit.yml
  - scripts/__fixtures__/prod-compose/pgbackrest-publishes-port.yml
  - scripts/__tests__/deploy-script.test.mjs
  - scripts/__tests__/restore-drill-script.test.mjs
  - scripts/__tests__/validate-prod-compose.test.mjs
  - scripts/check-web-chunks.mjs
  - scripts/deploy.sh
  - scripts/restore-drill.sh
  - scripts/validate-prod-compose.mjs
  - SPECIFICATION.md
findings:
  critical: 0
  warning: 4
  info: 1
  total: 5
status: issues_found
---

# Phase 17: Code Review Report

**Reviewed:** 2026-08-20T00:00:00Z
**Depth:** standard
**Files Reviewed:** 24
**Status:** issues_found

## Summary

Reviewed Phase 17's UTC-timezone pinning (`packages/db/src/pool.ts` + the
`dashboard.repository.ts` read-side anchor), the CI-built/GHCR-published
Postgres image cutover (`.github/workflows/images.yml`,
`docker/docker-compose.prod.yml`, `docker/prod.env.example`,
`scripts/validate-prod-compose.mjs` + fixtures), `scripts/deploy.sh`'s
`--no-deps` leg-isolation fix, `scripts/restore-drill.sh`'s self-instrumented
metrics, and the `apps/web/vite.config.ts` / `scripts/check-web-chunks.mjs`
chunk-cycle fix, plus the accompanying test suites and runbook/spec updates.

The shell scripts (`deploy.sh`, `restore-drill.sh`) and the compose-gate
script are well-tested against realistic fixtures/subprocess stubs and I did
not find a functional defect in any of them. Two genuine findings came out
of tracing library internals rather than reading the diff in isolation: (1)
the new pool-level `options: "-c TimeZone=UTC"` passthrough is vulnerable to
the exact same "DSN silently overrides an explicitly-passed same-named
config key" class of bug this same file's own header comment spends several
paragraphs documenting and defending against for `ssl` — but does not defend
against for `options` — confirmed empirically against the installed
`pg`/`pg-connection-string` versions. (2) The claimed "read-path fix" for
WR-06 in `dashboard.repository.ts` is, verified empirically against a real
Postgres 17 instance under a non-UTC session, a mathematical no-op: the
double-hop `AT TIME ZONE 'UTC'` expression it introduces produces byte-
identical results to the plain `created_at::date` cast it replaced, in every
session timezone. This does not ship incorrect behavior, but it means the
phase's own narrative ("closes read-path WR-06") overstates what changed,
which matters because that narrative is cited as evidence toward closing a
security-register row (D-12 / `gsd-security-auditor`). No Critical findings —
nothing here is exploitable today or ships incorrect production behavior.

## Warnings

### WR-01: `createPgPool`'s new `options` passthrough is unguarded against the same DSN-override hazard the file documents for `ssl`

**File:** `packages/db/src/pool.ts:258` (and the module header comment, `packages/db/src/pool.ts:22-70`)
**Issue:** This module's own header comment (lines ~22-70) proves, by
reading `pg`'s installed source directly, that when both a `connectionString`
and a same-named top-level config key are passed to `new Pool({...})`, the
DSN's own parsed value silently wins:
`config = Object.assign({}, config, parse(config.connectionString))`
(`node_modules/pg/lib/connection-parameters.js:60`). The comment uses this
exact mechanism to justify never constructing a separate `ssl` object. The
new WR-06 fix adds a second top-level key subject to the identical
mechanism — `options: "-c TimeZone=UTC"` — without applying the same
analysis or any guard to it. `pg-connection-string` copies **every** URL
query parameter verbatim into the parsed config
(`node_modules/pg-connection-string/index.js:40-42`), so a DSN carrying
`?options=...` for any reason would silently replace the TimeZone pin with
no error, exactly mirroring the TLS footgun this file otherwise takes pains
to avoid. Confirmed empirically against the installed `pg` version:

```
$ node -e "
const ConnectionParameters = require('pg/lib/connection-parameters.js');
const cp = new ConnectionParameters({
  connectionString: 'postgres://u:p@h/db?options=-c%20search_path%3Dfoo',
  options: '-c TimeZone=UTC',
});
console.log(cp.options);
"
-c search_path=foo
```

No DSN in this codebase sets `options=` today, so this is latent, not
actively triggered — but it is unguarded, undocumented for this specific
key, and untested at the level that would catch it: the new pool-factory
test (`packages/db/src/__tests__/pool-factory.test.ts`, "TimeZone startup
parameter (WR-06)") only asserts `pool.options.options` — the raw,
**pre-merge** config object handed to `new Pool()` — never the resolved
`ConnectionParameters` a real connection actually negotiates with. That test
would pass even if a DSN's `options=` query param silently overrode the pin,
the same way the neighbouring "no ssl config object attached" test would
have missed the TLS hazard had it only checked `pool.options.ssl` instead of
a real connection's resolved TLS posture.
**Fix:** Either (a) mirror `assertDsnRequestsTls`'s pattern — parse the DSN
and reject (or at minimum warn) at `createPgPool` time if it carries an
`options` query parameter, since one silently defeating the TimeZone pin
would fail the exact same way a missing `sslmode` does; or (b) at minimum,
extend the module header's "TLS: exactly one mechanism" reasoning to
explicitly cover `options`, and add a test against the resolved
`ConnectionParameters` (not `pool.options`) proving a DSN-level `options=`
value cannot silently win.

### WR-02: The `dashboard.repository.ts` "read-path WR-06 fix" is a behavioral no-op; the closure narrative overstates what changed

**File:** `apps/api/src/modules/analytics/dashboard.repository.ts:78-82`
**Issue:** `GROWTH_BY_DAY_SQL`'s new double-hop expression
(`((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date`) is presented,
here and in `SPECIFICATION.md` §8.6/§5.17 ("закрывая read-путь WR-06"), as
closing a read-side timezone-session-dependence bug analogous to the
write-side bug `packages/db/src/pool.ts`'s TimeZone pin genuinely fixed.
Verified empirically against a real local Postgres 17 that this is not the
case: `created_at::date` (the expression this change **replaced**) and the
new double-hop expression produce byte-identical results under a non-UTC
session, because `(x AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` is an identity
transform on a naive `timestamp` (both operations explicitly name `'UTC'`,
so neither ever consults the session `TimeZone` GUC), and casting a naive
`timestamp` to `date` is a pure truncation that never consults session
timezone either:

```
CREATE TABLE t (c timestamp);
INSERT INTO t VALUES ('2026-08-19 01:30:00');
SET TIME ZONE 'America/New_York';
SELECT c::date AS plain_cast,
       ((c AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date AS double_hop,
       (c AT TIME ZONE 'UTC')::date AS single_hop
FROM t;
--  plain_cast | double_hop | single_hop
-- ------------+------------+------------
--  2026-08-19 | 2026-08-19 | 2026-08-18
```

Only the **single-hop** form (`(created_at AT TIME ZONE 'UTC')::date`) was
ever actually session-dependent/wrong — and per the diff, the codebase never
shipped that form; the pre-existing code was the plain cast, which was
already session-independent and correct. The new
`dashboard-timezone.test.ts` never actually tests this: Test 3 ("under the
pool's own UTC session, the double-hop and single-hop forms agree") only
compares double-hop against single-hop, and only under a UTC session — it
never compares the new double-hop expression against the **original,
replaced** plain-cast expression under a non-UTC session, which is the one
comparison that would have surfaced that the change is a no-op. This does
not ship incorrect behavior (the new form is still correct), but the paper
trail is materially wrong: SPECIFICATION.md §8.6 lists this as one of "four
as-built changes... each closing a specific gap," and that evidence feeds
directly into `D-12`'s planned `gsd-security-auditor` closure of the
`14-SECURITY.md` threat-register rows this phase's evidence is cited for.
**Fix:** Reframe the claim (in `dashboard.repository.ts`'s comment and
`SPECIFICATION.md` §5.17/§8.6/§9-23) from "closes/fixes read-path WR-06" to
"read path was already session-independent for the shipped expression; this
change is a regression guard against a *future* simplification toward the
single-hop form, not a behavior fix." Add a fourth comparison to
`dashboard-timezone.test.ts` (or a comment acknowledging it was
intentionally not needed) that runs the original `created_at::date` form
side-by-side under the non-UTC session, so the "no functional change"
property is itself verified rather than asserted.

### WR-03: `check-web-chunks.mjs`'s new cycle-detection logic has no unit test coverage

**File:** `scripts/check-web-chunks.mjs:165-206` (`viteConfigHasStrictExecutionOrder`, `findChunkImportCycle`)
**Issue:** This exact logic exists to prevent recurrence of the incident
named in its own comment ("Production shipped exactly this for four days
(2026-08-15..19)"). Every other CI-gate script touched or added in this same
phase (`scripts/validate-prod-compose.mjs`, `scripts/deploy.sh`,
`scripts/restore-drill.sh`) ships dedicated, fixture-driven `__tests__`
exercising the pure exported helpers directly (`scripts/__tests__/
validate-prod-compose.test.mjs`'s per-fixture cases,
`scripts/__tests__/deploy-script.test.mjs`'s stubbed subprocess cases). No
equivalent `scripts/__tests__/check-web-chunks*.test.mjs` exists for
`findChunkImportCycle` or `viteConfigHasStrictExecutionOrder`, and
`.github/workflows/ci.yml`'s new `check:web-chunks` step only runs the
script against the *current, already-fixed* build — it can prove today's
build passes, but nothing exercises whether the detector actually fires on a
reintroduced cycle, correctly no-ops on an unrelated DAG, or correctly
tolerates a cycle when `strictExecutionOrder: true` is present versus
flagging one when it is absent.
**Fix:** Add `scripts/__tests__/check-web-chunks.test.mjs` with in-memory
manifest fixtures covering: (1) a 2-node mutual-import cycle → `
findChunkImportCycle` returns it; (2) an acyclic manifest → returns `null`;
(3) a cyclic manifest + a `vite.config.ts` fixture containing
`strictExecutionOrder: true` → `main()`'s violation is suppressed; (4) the
same cycle without that config flag → a violation is raised naming the
cycle.

### WR-04: `docs/runbooks/backups.md`'s WAL-archiving health check contradicts the phase's own ratified production reality

**File:** `docs/runbooks/backups.md:181-187`
**Issue:** The runbook instructs operators to run
`SELECT * FROM pg_stat_archiver;` and states `failed_count` "should stay at
zero." This phase's own live cutover (`17-05-SUMMARY.md`, ratified
mid-session) established that this criterion is **unsatisfiable on the real
production host**: `failed_count` is cumulative since `stats_reset`, this
host's value has been a fixed `67` since the 2026-08-14 stanza bring-up, and
the phase's own corrected/ratified acceptance criterion is "`failed_count`
unchanged from baseline" — not zero. `backups.md` is precisely the
day-to-day operational runbook an operator would consult when checking
backup health, and it was not updated to reflect the reality this same
phase discovered and ratified elsewhere. An operator following this
runbook's literal text during a real incident would see `failed_count=67`,
conclude WAL archiving is unhealthy, and could act on a false alarm — or, in
the other direction, could not tell 68 from 67, since "stay at zero" gives
no baseline to compare against at all.
**Fix:** Update `docs/runbooks/backups.md`'s "Confirming WAL archiving is
keeping up" section to read "`archived_count` should be increasing over
time; `failed_count` should **not increase from its previously observed
value**" (matching `17-05-SUMMARY.md`'s ratified criterion), and note that a
nonzero `failed_count` alone is not itself an incident signal on this host
given the recorded 2026-08-14 stanza-bring-up history.

## Info

### IN-01: `viteConfigHasStrictExecutionOrder`'s comment-stripping only removes full-line comments

**File:** `scripts/check-web-chunks.mjs:165-173`
**Issue:** The function strips lines where `line.trimStart().startsWith("//")` before regex-testing for `strictExecutionOrder\s*:\s*true`, but does not strip trailing inline comments (e.g. `foo: bar, // strictExecutionOrder: true`). Since this is a *safety* gate (a false match makes `main()` treat a genuine chunk-cycle regression as tolerated and suppress the violation), the failure direction matters: a stray inline mention of the flag's name anywhere in the file — even in an unrelated comment — would cause a **false pass** of the exact gate this phase added to prevent a repeat of a real production outage.
**Fix:** Also strip trailing `//...` comments per line (e.g. split on the first unquoted `//`), or match only within the specific `rollupOptions.output` object literal rather than the whole file text.

---

_Reviewed: 2026-08-20T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
