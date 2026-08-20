# Phase 8: Quality Gates & Failure-Injection Foundation - Pattern Map

**Mapped:** 2026-07-28
**Files analyzed:** ~30 (new/modified, per CONTEXT.md + RESEARCH.md project structure)
**Analogs found:** 16 with real analog / 14 no-analog (greenfield)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `.github/workflows/ci.yml` | config (CI) | event-driven | none in repo | no analog — greenfield |
| `eslint.config.js` | config | transform (static analysis) | none in repo | no analog — greenfield |
| `vitest.config.ts` (root, `test.projects`) | config | batch | `apps/worker/vitest.config.ts`, `apps/api/vitest.config.ts` | structural precedent |
| `docker/redis.conf` | config | — | `docker/init-app-role.sql` (mounting pattern in `docker-compose.yml`) | structural precedent (mount pattern), no content analog |
| `docker-compose.yml` (modified: `redis.command`/volume mount) | config | — | itself (existing `db` service block) | exact (self-analog, apply same shape to `redis`) |
| `packages/test-support/package.json` + `tsconfig.json` | config (workspace scaffold) | — | `packages/delivery-core/package.json`, `packages/kms/package.json` | exact structural |
| `packages/test-support/src/guard.ts` | utility | request-response (pure fn, throws) | none directly; spec pseudocode in RESEARCH.md Code Examples | no analog — greenfield (but exact code given in RESEARCH.md) |
| `packages/test-support/src/db-fixture.ts` (consolidated) | utility | CRUD (migration apply) | `apps/worker/src/test/db-fixture.ts`, `apps/api/src/test/db-fixture.ts`, `packages/delivery-core/src/test/db-fixture.ts` | exact — 3 near-identical copies to merge |
| `packages/test-support/src/provision-db.ts` | utility | CRUD (CREATE/DROP DATABASE) | `packages/db/package.json` drizzle-kit scripts (structural), `db-fixture.ts` (advisory lock convention) | role-match |
| `packages/test-support/src/coverage-gate.ts` | utility | batch (file read + compare) | none; RESEARCH.md gives full code | no analog — greenfield (code provided) |
| `packages/test-support/src/migration-lint.ts` | utility | transform (static analysis of SQL) | none; RESEARCH.md gives full code | no analog — greenfield (code provided) |
| `packages/test-support/src/harness/spawn-and-kill.ts` | utility | event-driven (child process/IPC) | none in repo (new pattern) | no analog — greenfield |
| `packages/test-support/src/harness/docker-restart.ts` | utility | event-driven (shell exec) | none in repo | no analog — greenfield |
| `packages/test-support/src/__tests__/guard.test.ts` | test | request-response | `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts` (test structure/fixture style only, not DB) | role-match (structure only) |
| `packages/test-support/src/__tests__/coverage-gate.test.ts` | test | batch | same as above (fixture-file style) | role-match (structure only) |
| `packages/test-support/src/__tests__/migration-lint.test.ts` | test | transform | same | role-match (structure only) |
| `packages/db/src/__tests__/migrate-from-empty.test.ts` | test | CRUD (migration apply) | `apps/worker/src/test/db-fixture.ts` (`applyPendingMigrations`), `send-dispatch-durability.test.ts` (`beforeAll`/`afterAll` pool lifecycle style) | exact (reuse db-fixture engine) |
| `packages/db/src/__tests__/migrate-incremental.test.ts` | test | CRUD | same | exact |
| `apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts` | test | event-driven | `send-dispatch-durability.test.ts` (fakeSendMail/countingSendMail pattern) | exact |
| `apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts` | test | event-driven | `send-dispatch-durability.test.ts` `fakeSendMail(status, headers)` | exact — reuse verbatim |
| `apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts` | test | event-driven | `send-dispatch-durability.test.ts` | exact |
| `apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts` | test | event-driven (real process) | `send-dispatch-durability.test.ts` (DB/pool setup), no existing real-child-process test | role-match (DB fixture) + no analog (process spawn) |
| `apps/worker/src/queues/__tests__/failure-injection/redis-restart.test.ts` | test | event-driven (docker exec) | `send-dispatch-durability.test.ts` (queue/BullMQ assertions) | role-match |
| `apps/worker/src/test/harness/sigkill-entrypoint.ts` | utility (harness entrypoint) | event-driven | `apps/worker/src/server.ts` (boot shape, imports `processSendJob`'s deps) — not read in full, but is the "real worker" analog referenced in RESEARCH | role-match |
| `docker/__tests__/redis-config.test.ts` (or `packages/test-support/src/__tests__/redis-config.test.ts`) | test | request-response (ioredis `CONFIG GET`) | `send-dispatch-durability.test.ts` (`new Redis(...)` client setup) | role-match |
| `scripts/check-root-hygiene.mjs` | utility (CI script) | batch (fs scan) | `scripts/check-env.mjs` | exact |
| `scripts/lint-migrations.mjs` | utility (CI script) | transform | `scripts/check-env.mjs` (Node-builtins-only CLI script shape), `scripts/migrate-dev.mjs` | role-match |
| `scripts/check-env.mjs` (modified: `MEGA_CRM_ENV_FILE`) | utility (CI script) | batch | itself (existing) | exact — self-modify |
| `scripts/migrate-dev.mjs` (modified: `MEGA_CRM_ENV_FILE`) | utility | CRUD | itself (existing) | exact — self-modify |
| `apps/api/src/server.ts`, `apps/worker/src/server.ts` (modified: `process.loadEnvFile(resolveEnvPath())`) | config/bootstrap | — | `apps/worker/vitest.config.ts`'s existing `process.loadEnvFile(path.resolve(...))` try/catch block | exact |
| `apps/web/playwright.config.ts` (modified: `globalSetup`, `reuseExistingServer: false`, `webServer.env`, `dev:e2e` scripts) | config | request-response | itself (existing file, shown above) | exact — self-modify |
| `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, others (modified: add `globalSetup` for guard) | config | — | itself (existing `env:` block + `process.loadEnvFile` try/catch) | exact — self-modify |
| `ARCHITECTURE.md`, `CONVENTIONS.md` | doc | — | `SPECIFICATION.md` (existing doc, role/boundary precedent) | role-match (doc structure/tone, not content) |
| `.claude/CLAUDE.md` (extended `## Project Specification` section) | doc | — | itself, section "## Project Specification (SPECIFICATION.md)" quoted in system context above | exact — self-modify (extend existing table) |

## Pattern Assignments

### `packages/test-support/package.json` + `tsconfig.json` (config, workspace scaffold)

**Analog:** `packages/delivery-core/package.json`, `packages/kms/package.json` (both shown in full above)

**Copy this shape verbatim, substituting the name/deps:**
```json
{
  "name": "@mega-crm/test-support",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "pg": "8.22.0",
    "ioredis": "5.11.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "@types/pg": "^8.15.6",
    "typescript": "^5.9.3",
    "vitest": "4.1.9",
    "execa": "10.0.0"
  }
}
```
Note (RESEARCH.md flag): do NOT add `apps/worker` as a dependency of `packages/test-support` — no `packages/* -> apps/*` import exists anywhere in this repo today (every `apps/*/package.json` depends on `@mega-crm/*` packages, never the reverse). Keep the SIGKILL entrypoint physically inside `apps/worker/src/test/harness/`; `packages/test-support` only supplies generic spawn/IPC/kill helpers.

Then wire it as a `devDependency` into `apps/api`, `apps/worker`, `packages/delivery-core` package.json files (same `"@mega-crm/test-support": "0.1.0"` shape as any existing internal package reference, e.g. `apps/worker/package.json`'s `"@mega-crm/delivery-core": "0.1.0"`).

`tsconfig.json` for the new workspace: copy from any existing `packages/*/tsconfig.json` (e.g. `packages/delivery-core/tsconfig.json`) — not read in full above; fetch that file directly when writing the plan task if exact `compilerOptions` are needed (all packages share `tsconfig.base.json`'s `strict: true`, `NodeNext`, per RESEARCH.md's Established Patterns section).

---

### `packages/test-support/src/db-fixture.ts` (consolidated) (utility, CRUD)

**Analog:** `apps/worker/src/test/db-fixture.ts` (full content read above — 60 lines shown), near-duplicated in `apps/api/src/test/db-fixture.ts` and `packages/delivery-core/src/test/db-fixture.ts`.

**Core pattern to preserve exactly (advisory lock, migration tracking table, relative path to `packages/db/migrations`):**
```typescript
const MIGRATION_ADVISORY_LOCK_KEY = 8_472_991; // MUST stay identical across all three former copies — shared physical DB

async function applyPendingMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS _test_migrations_applied (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rows } = await client.query(
        "SELECT true as exists FROM _test_migrations_applied WHERE filename = $1", [file]
      );
      if (rows.length > 0) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO _test_migrations_applied (filename) VALUES ($1)", [file]);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
  }
}
```

**Critical fix required (D-14, D-13):** the analog's env resolution line —
```typescript
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
```
— is the exact dangerous fallback D-14 requires removing. In the consolidated `packages/test-support/src/db-fixture.ts`, this MUST become a hard-fail with no `?? DATABASE_URL` fallback, and MUST call `assertTestDatabaseUrl()` from `guard.ts` before returning any pool/connection. Do not carry the `??` forward.

**Edge case (RESEARCH.md Pitfall / Edge Coverage "ordering" backstop for R5):** `readdirSync(MIGRATIONS_DIR).sort()` gives correct order only because all 38 files are already zero-padded (`0000_...` .. `0037_...`, confirmed above). Preserve the zero-padded naming convention for any new migration files the linter/tests touch.

---

### `apps/worker/src/queues/__tests__/failure-injection/{timeout,rate-limit-429,connection-reset}.test.ts` (test, event-driven)

**Analog:** `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts` (read in full above through `connectFixtureSendgridKey`)

**Imports pattern (copy verbatim, adjust relative path since new files live one directory deeper under `failure-injection/`):**
```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { dispatchSendGate } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "@mega-crm/test-support"; // was "../../test/db-fixture.js"
import { processSendJob } from "../../send-dispatch.js"; // one extra "../" for the failure-injection/ subdir
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";
```

**Setup/teardown pattern (copy verbatim):**
```typescript
beforeAll(async () => {
  await ensureTestDbMigrated();
  process.env.DATABASE_URL = getTestDatabaseUrl();
  pool = createTestPool();
  redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
});

afterAll(async () => {
  await pool.end();
  await redisClient.quit();
});
```

**DI-injection pattern for 429 (copy verbatim from the analog, this IS the failure:429 scenario almost as-is):**
```typescript
function fakeSendMail(
  status: number,
  headers: Record<string, string> = {}
): (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult> {
  return async () => ({
    status,
    headers: new Headers(headers),
    messageId: status < 300 ? "sg-message-id-fixture" : null,
  });
}
// failure:429
const result = await processSendJob(
  { workspaceId, campaignId, kind: "campaign", contactId },
  { sendMail: fakeSendMail(429, { "retry-after": "3" }), redisClient }
);
expect(result).toEqual({ outcome: "rate_limited", rateLimitMs: 3000 });
```

**New pattern for timeout/reset (RESEARCH.md Code Examples, same file shape, different injected function — throw instead of resolve):**
```typescript
const timeoutError = new DOMException("The operation was aborted", "AbortError");
async function throwingSendMail() { throw timeoutError; }

await expect(
  processSendJob({ workspaceId, campaignId, kind: "campaign", contactId }, { sendMail: throwingSendMail, redisClient })
).rejects.toThrow(timeoutError);

// connection-reset.test.ts uses the same shape with:
const resetError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
async function resettingSendMail() { throw resetError; }
```

**Also reuse verbatim from the analog:** `countingSendMail(status)` helper and `freshWorkspaceId(nameSeed)` / `connectFixtureSendgridKey(workspaceId)` fixture builders — all shown in the file read above. RLS note preserved from the analog's own comment: fixture inserts MUST run inside `withTenant`/`withTenantTransaction` since `workspace_sendgrid_keys`/`segments`/`campaigns`/`contacts` carry `ENABLE + FORCE ROW LEVEL SECURITY`.

---

### `apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts` + `apps/worker/src/test/harness/sigkill-entrypoint.ts` (test + harness, event-driven/real-process)

**Analog (DB/pool lifecycle only):** same `send-dispatch-durability.test.ts` `beforeAll`/`afterAll` shown above — reuse verbatim for pool/redis setup in the test file.

**No analog for the process-spawn/IPC/kill mechanics** — greenfield, per RESEARCH.md's own explicit flag. Design constraints to carry into the plan (from D-22/D-23 in CONTEXT.md, both locked):
- Entrypoint file lives in `apps/worker/src/test/harness/sigkill-entrypoint.ts` (NOT in `packages/test-support`, see workspace-scaffold section above for why).
- Entrypoint imports `processSendJob` directly (`../../queues/send-dispatch.js`), injects only `sendMail` — a fake that (a) signals "I am inside the send-mail call" to the parent via `process.send()` (IPC), and (b) **never resolves** — so the child process is provably frozen inside the window after `dispatchSendGate`'s claim commits and before any terminal write, per D-23.
- `packages/test-support/src/harness/spawn-and-kill.ts` supplies the *generic* reusable parts only: `spawn` a child with `stdio: ["ipc", ...]`, `await` a "ready" IPC message, then `kill(pid, "SIGKILL")`, then assert exit code/signal — parameterized by entrypoint path, not hardcoded to worker.
- Test asserts, after respawning a fresh `processSendJob` call post-kill, that the send is NOT duplicated (query `sends` row count / status), matching the exact assertion style of `send-dispatch-durability.test.ts`'s `sendsRowCountFor` pattern used in the 429 example above.

---

### `packages/test-support/src/guard.ts` (utility, request-response — pure function)

**No in-repo analog** — greenfield. Use the exact algorithm RESEARCH.md already worked out against SPEC's acceptance criteria (reproduced here verbatim since it is load-bearing and must not drift):

```typescript
import { URL } from "node:url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeDsn(raw: string): { host: string; port: string; database: string } {
  const url = new URL(raw);
  const host = LOOPBACK_HOSTS.has(url.hostname) ? "loopback" : url.hostname.toLowerCase();
  const port = url.port || "5432";
  const database = url.pathname.replace(/^\//, "");
  return { host, port, database };
}

export function assertTestDatabaseUrl(testUrl: string | undefined, devUrl: string | undefined): void {
  if (!testUrl || testUrl.length === 0) {
    throw new Error("FATAL: TEST_DATABASE_URL is unset or empty. Tests must never fall back to DATABASE_URL.");
  }
  const testDsn = normalizeDsn(testUrl);
  if (!testDsn.database.startsWith("mega_crm_test")) {
    throw new Error(`FATAL: test database name "${testDsn.database}" does not start with the required "mega_crm_test" prefix.`);
  }
  if (devUrl) {
    const devDsn = normalizeDsn(devUrl);
    if (testDsn.host === devDsn.host && testDsn.port === devDsn.port && testDsn.database === devDsn.database) {
      throw new Error(`FATAL: TEST_DATABASE_URL resolves to the same host+port+database as DATABASE_URL.`);
    }
  }
}
```
Constraint (D-14, negative acceptance criterion): no env var or flag anywhere in this file may disable the check — do not add a `SKIP_GUARD`-style escape hatch even for local convenience.

Wire into `globalSetup` in every vitest config (`apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, and any other workspace with a `vitest.config.ts`) and into `apps/web/playwright.config.ts`'s own `globalSetup` — this is the single point RESEARCH.md's tracer slice calls out as step 3.

---

### `packages/test-support/src/coverage-gate.ts` and `migration-lint.ts` (utility, batch/transform)

**No in-repo analog** — greenfield. RESEARCH.md provides complete, ready-to-copy implementations (see RESEARCH.md "Code Examples" section, `checkCoverageGate` and `checkEnumAddValueSameFile`/`checkDestructiveDdl`) — copy those verbatim as the starting implementation; do not re-derive independently. Key invariants to preserve from those examples:
- `coverage-gate.ts`: comparison MUST be unrounded `covered / total` against a `baseline.lines` fraction (not a percentage), and `actual >= baseline.lines` (equal-passes semantics per D-18).
- `migration-lint.ts`: `stripSqlComments` must run before both rules; enum rule checks for the literal value used **outside** the `ADD VALUE` statement in the *same file*; destructive-DDL rule requires a `-- destructive: <reason>` comment on the immediately preceding line (not a file-level blanket comment — mirrors the `eslint-disable-next-line` escape-hatch symmetry from D-06/D-31).

---

### `scripts/check-root-hygiene.mjs` (utility, CI script, batch)

**Analog:** `scripts/check-env.mjs` (full content read above)

**Style to copy:** Node-builtins-only, no dependencies, shebang `#!/usr/bin/env node`, loud `console.error` + `process.exit(1)` on failure, doc comment at top referencing the GSD plan/decision that motivated it:
```javascript
#!/usr/bin/env node
// GSD 08-NN: root hygiene blacklist check (D-29) — non-recursive listing of
// process.cwd(), fails if any of .env, .env.* (except .env.example), *.rdb,
// *.aof, .DS_Store is present.
import { readdirSync } from "node:fs";

const BLACKLIST_EXACT = new Set([".DS_Store"]);
const BLACKLIST_PATTERNS = [/^\.env(\..+)?$/, /\.rdb$/, /\.aof$/];
const ALLOWED_ENV = ".env.example";

const entries = readdirSync(process.cwd());
const violations = entries.filter((name) => {
  if (name === ALLOWED_ENV) return false;
  if (BLACKLIST_EXACT.has(name)) return true;
  return BLACKLIST_PATTERNS.some((re) => re.test(name));
});

if (violations.length > 0) {
  console.error(`Root hygiene check failed. Forbidden files present: ${violations.join(", ")}`);
  process.exit(1);
}
```

---

### `.claude/CLAUDE.md` § Project Specification (doc, self-modify)

**Analog:** itself — the existing section (quoted in full in the system context above, starting "## Project Specification (SPECIFICATION.md)").

**Pattern to extend (D-33):** keep the exact same table shape ("Куда писать:" bullet list mapping change-type → section) but add two more target documents (`ARCHITECTURE.md`, `CONVENTIONS.md`) each with their own trigger bullet, and change the opening sentence from singular ("файл SPECIFICATION.md") to plural ("три документа"). Also replace the stub `## Conventions` ("Conventions not yet established...") and `## Architecture` ("Architecture not yet mapped...") sections elsewhere in the same file with one-line pointers to the new root `CONVENTIONS.md` / `ARCHITECTURE.md` files, per D-33's explicit requirement not to leave those stubs contradicting the new files' existence.

## Shared Patterns

### DI-seam fake `sendMail` (all 3 in-process failure scenarios + coverage-of-worker tests)
**Source:** `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts` `fakeSendMail`/`countingSendMail`
**Apply to:** `timeout.test.ts`, `rate-limit-429.test.ts`, `connection-reset.test.ts`, and the retry-redelivery half of the SIGKILL test
```typescript
function fakeSendMail(status: number, headers: Record<string, string> = {}) {
  return async () => ({ status, headers: new Headers(headers), messageId: status < 300 ? "sg-message-id-fixture" : null });
}
```

### RLS-safe fixture inserts (`withTenant`/`withTenantTransaction`)
**Source:** `send-dispatch-durability.test.ts` (`connectFixtureSendgridKey`, `freshWorkspaceId`)
**Apply to:** every new test under `apps/worker/src/queues/__tests__/failure-injection/*` and any `packages/kms`/`packages/tenant-context` D-19 coverage tests — any insert touching a RLS-protected table (`workspace_sendgrid_keys`, `segments`, `campaigns`, `contacts`) must go through `withTenant`/`withTenantTransaction`, never a bare `pool.query`.

### `TEST_DATABASE_URL`/`TEST_REDIS_URL` env convention + `.env` loading via `process.loadEnvFile`
**Source:** `apps/worker/vitest.config.ts` and `apps/api/vitest.config.ts` (both shown in full above — identical `env:` blocks and identical `process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"))` try/catch preamble)
**Apply to:** the new root `vitest.config.ts` aggregator (D-16 `test.projects`) must fold in the same `env:` keys per-project (not lose the `KMS_LOCAL_KEK`/`PUBLIC_APP_URL`/etc. test-safe defaults), and any config file touched for D-27/D-28 (`MEGA_CRM_ENV_FILE`) must replace the hardcoded `"../../.env"` path with `resolveEnvPath()` reading the new constant, keeping the same try/catch-optional shape.

### docker-compose volume-mount pattern for versioned config files
**Source:** `docker-compose.yml`'s existing `db` service — `./docker/init-app-role.sql:/docker-entrypoint-initdb.d/01-init-app-role.sql:ro`
**Apply to:** `redis` service — mount `./docker/redis.conf:/usr/local/etc/redis/redis.conf:ro` and add `command: ["redis-server", "/usr/local/etc/redis/redis.conf"]` (Note: `db`'s mount uses an entrypoint-init-script directory native to the `postgres` image; `redis` needs the file mounted to an arbitrary path plus an explicit `command:` override — this is exactly why D-03 rejects GHA `services:`, which cannot set `command:`).

### Self-contained Node-builtins-only CLI script style
**Source:** `scripts/check-env.mjs` (full content read above)
**Apply to:** `scripts/check-root-hygiene.mjs`, `scripts/lint-migrations.mjs` — no new dependency, shebang, loud stderr + non-zero exit, doc comment citing the GSD plan number and the pitfall/decision it closes.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `.github/workflows/ci.yml` | config | event-driven | `.github/` does not exist anywhere in repo history (SPEC.md confirms zero CI history) — use RESEARCH.md's Architecture Diagram + Tracer Slice section as the structural template instead |
| `eslint.config.js` | config | transform | No ESLint config/dependency exists in repo at all — use RESEARCH.md's Pitfall 2 (`projectService`/`allowDefaultProject`) and Standard Stack table as the template |
| `packages/test-support/src/guard.ts` | utility | request-response | New concept (fail-closed DSN guard); RESEARCH.md's Code Examples section supplies a complete reference implementation to copy directly |
| `packages/test-support/src/coverage-gate.ts` | utility | batch | Same — RESEARCH.md supplies complete reference implementation |
| `packages/test-support/src/migration-lint.ts` | utility | transform | Same — RESEARCH.md supplies complete reference implementation |
| `packages/test-support/src/harness/spawn-and-kill.ts` | utility | event-driven | No child-process/IPC orchestration exists anywhere in repo today |
| `packages/test-support/src/harness/docker-restart.ts` | utility | event-driven | No `docker restart`/execa shell-out exists anywhere in repo today |
| `docker/redis.conf` | config | — | No Redis config file exists; only the mount *mechanism* (`init-app-role.sql`) has a precedent, not the content |
| `ARCHITECTURE.md` | doc | — | Does not exist; `SPECIFICATION.md` is a structural/tonal precedent only (different content role by design — "what" vs "why") |
| `CONVENTIONS.md` | doc | — | Does not exist; same precedent caveat as above |
| `apps/worker/src/test/harness/sigkill-entrypoint.ts` | utility | event-driven | No real-subprocess-under-test harness exists in repo; `apps/worker/src/server.ts` is the nearest boot-shape reference but is explicitly NOT reusable per D-22 (hardcoded SendGrid URL) |
| `coverage-baseline.json` | config (data) | — | Cannot have an analog — value is measured fresh from this repo's current suite (D-18/D-19) |
| root `vitest.config.ts` with `test.projects` | config | batch | Vitest 4 `test.projects` aggregation is new to this repo (6 existing configs are all standalone, no root aggregator) — use `apps/worker/vitest.config.ts` only for the `env:`/`fileParallelism` sub-block shape, not for the top-level `projects` structure |
| `apps/web/e2e/*` (new? none planned — existing specs unchanged per RESEARCH.md structure) | — | — | Out of scope per SPEC boundaries (no new E2E scenarios) |

## Metadata

**Analog search scope:** `apps/api/src`, `apps/worker/src`, `apps/web`, `packages/*` (delivery-core, kms, db, tenant-context, contacts-core), root config files (`docker-compose.yml`, `package.json`, `.claude/CLAUDE.md`), `scripts/`
**Files scanned:** `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts`, `apps/worker/src/test/db-fixture.ts`, `docker-compose.yml`, `apps/worker/vitest.config.ts`, `apps/api/vitest.config.ts`, `apps/web/playwright.config.ts`, root `package.json`, `packages/delivery-core/package.json`, `packages/kms/package.json`, `apps/worker/package.json`, `packages/db/package.json`, `packages/db/migrations/` (listing), `scripts/check-env.mjs`
**Pattern extraction date:** 2026-07-28
