# Phase 17: Address tech debt: WR-06 + medium security follow-ups - Pattern Map

**Mapped:** 2026-08-19
**Files analyzed:** 9 (7 modify, 1 new test, plus doc/register updates handled directly)
**Analogs found:** 9 / 9 (this phase is entirely in-place extension of existing mechanisms — every touched file has a direct, already-verified analog in RESEARCH.md; no speculative search was needed)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/db/src/pool.ts` | config/utility (connection factory) | request-response (session-param negotiation) | itself (in-place edit) | exact — modify existing factory |
| `apps/api/src/modules/analytics/dashboard.repository.ts` | service/repository (SQL query) | CRUD (read/aggregate) | `packages/db/src/partitions/relocate-default.ts` (double-hop UTC cast idiom) | exact — same idiom, different call site |
| `packages/db/src/__tests__/pg-timezone.test.ts` (NEW) | test | request-response (integration, real Postgres) | `packages/db/src/__tests__/pg-tls.test.ts` | exact — same ephemeral-DB + Vitest structure |
| `scripts/validate-prod-compose.mjs` | config/gate script | batch (static validation) | itself (`FIRST_PARTY_IMAGE_SERVICES` set, in-place edit) | exact — one-line set extension |
| `docker/docker-compose.prod.yml` | config | — | `api`/`worker`/`web` service blocks in the same file (image-ref-only, no `build:`) | exact — mirror sibling services |
| `docker/prod.env.example` | config | — | existing `IMAGE_TAG` placeholder-SHA convention in the same file | exact — mirror sibling var |
| `.github/workflows/images.yml` | CI/CD config | event-driven (push/pull_request triggered build) | `build-and-push` / `build-only` jobs in the same file | role-match — same job shape, different `context`/`file` |
| `scripts/restore-drill.sh` | utility/script (operator tool) | batch (drill orchestration) | itself, `run_real_drill` function + existing `pg_isready` container-exec pattern | exact — additive instrumentation in place |
| `scripts/__fixtures__/prod-compose/*.yml` (review only) | test fixture | batch | existing fixtures in same directory | exact — no new file, review/adjust tags |

## Pattern Assignments

### `packages/db/src/pool.ts` (config/utility, request-response)

**Analog:** itself — `createPgPool` (lines 204-233)

**Current core pattern to extend** (lines 219-221):
```ts
// Deliberately no `ssl` key here -- see this module's header comment
// ("TLS: exactly one mechanism").
const pool = new Pool({ connectionString, max });
```

**Change (D-01):** add `options: '-c TimeZone=UTC'` alongside `connectionString, max`:
```ts
const pool = new Pool({ connectionString, max, options: "-c TimeZone=UTC" });
```
Follow this file's own documentation convention: every non-obvious choice gets an inline rationale comment in the module header (see existing header block lines 1-92 for the TLS/error-handler precedent) — add a matching block explaining the startup-parameter-vs-`pool.on('connect')` race (node-postgres issue #3265), citing this exact repo precedent style.

**Do NOT use** the `pool.on('connect', ...)` pattern — no analog for it exists in this file and RESEARCH.md documents why it's rejected (race condition).

---

### `apps/api/src/modules/analytics/dashboard.repository.ts` (service/repository, CRUD)

**Analog:** `packages/db/src/partitions/relocate-default.ts:112` (double-hop `AT TIME ZONE 'UTC'` idiom on a naive column)

**Analog excerpt:**
```sql
SELECT DISTINCT date_trunc('month', ${table.partitionKeyColumn} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start
```

**Current pattern at the target file** (lines ~185-197, verified in RESEARCH.md):
```sql
SELECT created_at::date::text as day, count(*)::text as "newContacts"
FROM contacts
WHERE workspace_id = $1 AND created_at >= $2::date AND anonymized_at IS NULL
GROUP BY created_at::date
```

**Corrected pattern to apply (D-01/D-03), mirroring the analog's double-hop shape exactly:**
```sql
SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date::text as day,
       count(*)::text as "newContacts"
FROM contacts
WHERE workspace_id = $1 AND created_at >= $2::date AND anonymized_at IS NULL
GROUP BY ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date
```

**Critical correction — do not follow the literal text in CONTEXT.md/13-REVIEW.md's WR-06 description** (`(col AT TIME ZONE 'UTC')::date`, single-hop). That form is empirically wrong for a naive `timestamp` column (proven in RESEARCH.md Pitfall 1 with reproducible SQL). Use the double-hop form shown above, matching `relocate-default.ts`.

The adjacent baseline-count query (`created_at < $2::date`) needs **no change** — record as verified-safe (it's a `<` comparison against a naive date literal, no timezone conversion occurs at all).

**D-03 sweep:** after fixing this file, grep-audit remaining bare `::date` casts:
```bash
grep -rn "::date" apps/api/src apps/worker/src packages/db/src --include="*.ts"
```
Fix any affecting user-visible day bucketing on naive columns; record the rest as verified-safe with reasoning in the plan/SUMMARY.

---

### `packages/db/src/__tests__/pg-timezone.test.ts` (NEW test, request-response/integration)

**Analog:** `packages/db/src/__tests__/pg-tls.test.ts` (full file read above — 125 lines)

**Imports pattern** (analog lines 1-6):
```ts
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";

import { createPgPool } from "../pool.js";
```

**Ephemeral-DB provisioning + teardown pattern** (analog lines 56, 72-74):
```ts
const provisioned = await createEphemeralDatabase({ workspace: "pg-tls" });
// ...
describe("...", () => {
  afterAll(async () => {
    await dropEphemeralDatabase(provisioned.databaseName, provisioned.adminDsn);
  });
  // ...
});
```

**"Prove real server behavior, not config" philosophy** (analog lines 8-16, 46-54): probe/assert against actual Postgres session state (`pg_stat_ssl` there; `SHOW TimeZone` / actual stored row values here), never assert on the `Pool`'s own JS config object.

**Structure to build for D-02**, following RESEARCH.md's Pattern 3 exactly (already-drafted skeleton — use verbatim as the starting point, adjust per this file's real API surface):
```ts
import { Pool } from "pg";
import { createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";
import { createPgPool } from "../pool.js";

const provisioned = await createEphemeralDatabase({ workspace: "pg-timezone" });

const admin = new Pool({ connectionString: provisioned.adminDsn });
await admin.query(`ALTER DATABASE ${provisioned.databaseName} SET timezone TO 'America/New_York'`);
await admin.end();

describe("naive timestamp UTC pin survives a non-UTC database default (WR-06, D-01/D-02)", () => {
  // 1. negative control: a bare `new Pool()` (NOT createPgPool) inherits the non-UTC default
  // 2. createPgPool's pool reports SHOW TimeZone === 'UTC' and writes true-UTC wall-clock values
  // 3. the exact growth-query SQL fragment, run against a raw client forced to
  //    a non-UTC session (`SET TIME ZONE 'America/New_York'`), still returns the correct UTC day
});
```

**Config file / run command:** `packages/db/vitest.config.ts`; `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts`.

---

### `scripts/validate-prod-compose.mjs` (gate script)

**Analog:** itself — `FIRST_PARTY_IMAGE_SERVICES` set

**Before:**
```js
const FIRST_PARTY_IMAGE_SERVICES = new Set(["api", "worker", "web", "migrate", "alloy"]);
```
**After (D-05):**
```js
const FIRST_PARTY_IMAGE_SERVICES = new Set(["api", "worker", "web", "migrate", "alloy", "db", "pgbackrest"]);
```
No other logic change needed — `extractImageTag`/`isMutableTag`/the mutable-tag `check(...)` call (~line 548) already iterate the set generically.

**Follow-up required:** run the existing prod-compose validator test suite after this change; fixtures under `scripts/__fixtures__/prod-compose/*.yml` using `image: megacrm-postgres:local` (e.g. `pgbackrest-missing-data-volume.yml`) will now ALSO trip the mutable-tag check. Update those fixtures' tags to a placeholder-SHA shape so they keep testing their original invariant (missing volume/port/mem-limit), not a conflated mutable-tag failure.

---

### `docker/docker-compose.prod.yml` (config)

**Analog:** sibling `api`/`worker`/`web` service blocks in the same file (pull-only, SHA-tagged, no `build:`)

**Change (D-05/D-06):** remove `build:` sections from `db`/`pgbackrest` services (currently at lines ~66, ~186); change image ref from `megacrm-postgres:${POSTGRES_IMAGE_TAG:-local}` to the same `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` shape the app images already use.

---

### `docker/prod.env.example` (config)

**Analog:** existing `IMAGE_TAG` placeholder-SHA convention in the same file (line ~108 area for `POSTGRES_IMAGE_TAG`)

**Change (Pitfall 3):** replace the `local` default with the same deliberately-invalid placeholder `IMAGE_TAG` already uses:
```
POSTGRES_IMAGE_TAG=0000000000000000000000000000000000000000
```

---

### `.github/workflows/images.yml` (CI/CD)

**Analog:** existing `build-and-push` / `build-only` jobs in the same file (matrix over `api`/`web`/`worker`)

**Do NOT extend the matrix** — its `file: docker/Dockerfile.${{ matrix.app }}` / repo-root `context` convention doesn't fit `db` (real Dockerfile at `docker/postgres/Dockerfile`, context `docker/`).

**Pattern to add instead — two new standalone jobs**, reusing the exact same pinned action SHAs already in this file verbatim (do not re-resolve them):
```yaml
  build-and-push-postgres:
    name: build-and-push (postgres)
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    steps:
      - uses: actions/checkout@<SAME SHA AS build-and-push>
      - uses: docker/setup-buildx-action@<SAME SHA>
      - uses: docker/login-action@<SAME SHA>
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Compute lowercase image base
        id: image-base
        run: echo "base=ghcr.io/$(echo '${{ github.repository }}' | tr '[:upper:]' '[:lower:]')" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@<SAME SHA>
        with:
          context: docker
          file: docker/postgres/Dockerfile
          push: true
          tags: ${{ steps.image-base.outputs.base }}/postgres:${{ github.sha }}

  build-only-postgres:
    name: build-only (postgres)
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<SAME SHA>
      - uses: docker/setup-buildx-action@<SAME SHA>
      - uses: docker/build-push-action@<SAME SHA>
        with:
          context: docker
          file: docker/postgres/Dockerfile
          push: false
          cache-from: type=gha,scope=postgres
          cache-to: type=gha,mode=max,scope=postgres
```

---

### `scripts/restore-drill.sh` (operator script)

**Analog:** itself — existing `run_real_drill` function, `pg_isready` container-exec pattern (avoids host-level Docker volume permission issues, per Pitfall 5)

**Existing pattern to mirror** (container-internal check, no host Docker-internals dependency):
```bash
docker exec "$SCRATCH_CONTAINER_NAME" pg_isready -U postgres
```

**Additive instrumentation pattern (D-09)** — bracket the existing restore-and-wait section:
```bash
local restore_start restore_end duration_seconds disk_high_water_kb=0
restore_start="$(date +%s)"

# ... existing docker run -d --name "$SCRATCH_CONTAINER_NAME" ... unchanged ...

local waited=0
while (( waited < READY_TIMEOUT_SECONDS )); do
  if docker exec "$SCRATCH_CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  local current_kb
  current_kb="$(docker exec "$SCRATCH_CONTAINER_NAME" du -sk /var/lib/postgresql/data 2>/dev/null | cut -f1)"
  if [[ -n "$current_kb" && "$current_kb" -gt "$disk_high_water_kb" ]]; then
    disk_high_water_kb="$current_kb"
  fi
  sleep "$READY_POLL_INTERVAL_SECONDS"
  waited=$(( waited + READY_POLL_INTERVAL_SECONDS ))
done

restore_end="$(date +%s)"
duration_seconds=$(( restore_end - restore_start ))

METRICS_FILE="${RESTORE_DRILL_METRICS_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/mega-crm/restore-drill-history.ndjson}"
mkdir -p "$(dirname "$METRICS_FILE")"
printf '{"target":"%s","durationSeconds":%d,"diskHighWaterKb":%d,"recordedAt":"%s"}\n' \
  "$target" "$duration_seconds" "$disk_high_water_kb" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$METRICS_FILE"
```

**Important:** the sketch above inlines `wait_for_scratch_ready`'s polling loop — the ORIGINAL function has a timeout-failure branch (prints "READINESS TIMEOUT", calls `print_cleanup_command`, `exit 1`) that MUST be preserved on the `waited >= READY_TIMEOUT_SECONDS` path. Record duration/disk figures on the failure path too, not only success.

---

## Shared Patterns

### Fail-closed / defense-in-depth session config
**Source:** `packages/db/src/pool.ts` header comment (TLS section, lines 23-92) and its existing `assertDsnRequestsTls` fail-closed pattern (lines 188-196, 213-215)
**Apply to:** the new `options: '-c TimeZone=UTC'` addition — same file, same "one mechanism, no silent fallback" philosophy; document with an equally thorough inline comment.

### Ephemeral per-test Postgres database, never container/server-level changes
**Source:** `packages/db/src/__tests__/pg-tls.test.ts` (`createEphemeralDatabase`/`dropEphemeralDatabase` from `@mega-crm/test-support`)
**Apply to:** the new `pg-timezone.test.ts` — scope the non-UTC timezone change to `ALTER DATABASE <ephemeral-db> SET timezone TO ...`, never the shared CI/dev Postgres cluster's own `TZ`/`PGTZ`.

### Immutable-SHA-tag discipline
**Source:** `scripts/validate-prod-compose.mjs`'s `FIRST_PARTY_IMAGE_SERVICES` / `MUTABLE_TAG_NAMES` / `isMutableTag` mechanism (generic, already covers any service added to the set)
**Apply to:** `db`, `pgbackrest` — no new logic, just membership in the existing set, mirroring how `api`/`worker`/`web`/`migrate`/`alloy` are already covered.

### Pinned-action-SHA CI job shape
**Source:** `.github/workflows/images.yml`'s existing `build-and-push` / `build-only` jobs
**Apply to:** the two new `*-postgres` jobs — reuse the exact same pinned commit SHAs for `actions/checkout`, `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action` (do not re-resolve).

### Placeholder-SHA "loud footgun" env-var convention
**Source:** `docker/prod.env.example`'s existing `IMAGE_TAG` default (`0000000000000000000000000000000000000000`)
**Apply to:** `POSTGRES_IMAGE_TAG`'s new default, replacing the silent `:-local` fallback.

## No Analog Found

None — every file in this phase's scope is an in-place edit to an existing mechanism, or a new test file with a direct structural precedent (`pg-tls.test.ts`). No greenfield component requiring a RESEARCH.md-only pattern.

## Metadata

**Analog search scope:** `packages/db/src`, `apps/api/src/modules/analytics`, `scripts/`, `docker/`, `.github/workflows/` (all identified directly via RESEARCH.md's already-verified primary-source file reads — no additional Glob/Grep search was needed since RESEARCH.md's "Sources" section already cites exact files read in full this research session)
**Files scanned:** 9 target files + 4 analog files read in full or targeted (`packages/db/src/pool.ts`, `packages/db/src/__tests__/pg-tls.test.ts`, `packages/db/src/partitions/relocate-default.ts` (per RESEARCH.md), `.github/workflows/images.yml` (per RESEARCH.md), `scripts/validate-prod-compose.mjs` (per RESEARCH.md), `scripts/restore-drill.sh` (per RESEARCH.md))
**Pattern extraction date:** 2026-08-19
