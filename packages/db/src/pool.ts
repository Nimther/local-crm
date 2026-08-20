import { Pool } from "pg";
import { scrubbedConsole } from "@mega-crm/redaction";

/**
 * Phase 14 plan 03 (DB-14, D-11) -- the single factory every first-party
 * production Postgres pool in this monorepo must go through, mirroring the
 * single-definition move `@mega-crm/queue-core`'s `createRedisConnection`
 * (`packages/queue-core/src/connection.ts`, WRK-11) made for Redis: one
 * function, an inline rationale comment for every non-obvious choice, the
 * error listener wired unconditionally rather than by opt-in.
 *
 * -- Error handler (CR-03 precedent, made unskippable) --
 * Without a listener on a `pg.Pool`'s `'error'` event, an idle-client
 * disconnection (a Postgres restart, failover, or the server's own idle
 * timeout) surfaces as an uncaught `'error'` event and crashes the whole
 * process (`packages/tenant-context/src/index.ts`'s own comment states this
 * exact failure mode; every existing pool in this codebase already wires
 * around it by discipline). DB-14's requirement -- "every pool has an error
 * handler" -- decays the moment a ninth pool is added by hand; this factory
 * plus `scripts/lint-pg-pool-factory.mjs` (Task 2) turns it from a
 * convention into an invariant nobody can forget.
 *
 * -- `options`: exactly one mechanism, guarded (WR-01 follow-up) --
 * The TimeZone pin below (`options: '-c TimeZone=UTC'` on `new Pool({...})`)
 * is subject to the EXACT SAME DSN-override hazard documented for `ssl`
 * immediately below: `pg-connection-string` copies every URL query parameter
 * verbatim into the parsed config, including an `options=` parameter, and
 * `pg`'s own `ConnectionParameters` merges the DSN's parsed fields OVER the
 * rest of `config` (`Object.assign({}, config, parse(connectionString))`) --
 * so a DSN carrying its own `options=` query parameter would silently
 * replace this factory's `-c TimeZone=UTC` string with no error. No DSN in
 * this codebase sets `options=` today, but "latent" is exactly the failure
 * mode the `ssl` rationale below exists to prevent. `assertDsnOmitsOptionsParam`
 * closes this the same way `assertDsnRequestsTls` closes the TLS hazard:
 * fail closed, at `createPgPool` time, unconditionally (not gated on
 * `NODE_ENV`, unlike the TLS check) -- the TimeZone pin protects correctness
 * of stored data in every environment, not just production's TLS posture.
 *
 * -- TLS: exactly one mechanism (RESEARCH.md Pitfall B) --
 * node-postgres resolves TLS from TWO independent inputs that can disagree:
 * a `sslmode` (or `sslcert`/`sslkey`/`sslrootcert`) query parameter on the
 * connection string, and a separately-supplied `ssl` config object passed to
 * `new Pool({...})`. Read directly from the installed pg@8.22.0 dependency
 * chain rather than trusting research prose (as this task's own
 * instructions required):
 *
 *   - `node_modules/pg/lib/connection-parameters.js`: `this.ssl =
 *     typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() :
 *     config.ssl`. If BOTH a `connectionString` and a top-level `ssl` key
 *     are passed to `new Pool({ connectionString, ssl })`, the DSN's own
 *     parsed fields are `Object.assign`ed OVER the rest of `config`
 *     (`config = Object.assign({}, config, parse(config.connectionString))`)
 *     -- so the connection string's own `ssl` derivation wins over a
 *     hand-written `ssl` object passed alongside it. Code that builds both
 *     believing it configured a verification posture may never have applied
 *     the one it wrote down.
 *   - `node_modules/pg-connection-string/index.js`: a `sslmode` query
 *     parameter sets `config.ssl = {}` (an empty, truthy object), which
 *     `pg`'s own `ConnectionParameters` then treats as "SSL enabled, default
 *     verification". This is where this codebase's own installed version
 *     diverges from the "classic libpq" behavior often assumed in
 *     documentation: `pg-connection-string@2.14.0` treats `sslmode=require`,
 *     `prefer` and `verify-ca` as ALIASES for `verify-full` (full
 *     certificate-chain verification against the system trust store) unless
 *     the connection string ALSO carries `uselibpqcompat=true` -- confirmed
 *     by reading the `switch (config.sslmode)` block in that file directly,
 *     not assumed from libpq's own docs. A DSN of `sslmode=require` alone
 *     against a self-signed certificate (this phase's dev/CI Postgres, Task
 *     3) THEREFORE FAILS the handshake with a certificate-verification
 *     error, not "encrypts without verifying" as libpq's own `require` means.
 *     Getting libpq's classic "encrypt, don't verify" semantics back
 *     requires `sslmode=require&uselibpqcompat=true` in the DSN. This
 *     factory does not add that parameter itself -- it is a property of the
 *     DSN a caller supplies, and D-10 (below) already documents that this
 *     phase deliberately stops at `require`, not `verify-full` -- but the
 *     fact is recorded here because it is exactly the kind of "TLS looks
 *     configured but the wire says otherwise" trap RESEARCH.md's Pitfall B
 *     warns about, and it is load-bearing for plan 14-08's production DSN
 *     and for Task 3's own `pg-tls.test.ts` in this plan.
 *
 * Given both of the above, this factory picks exactly ONE source of truth:
 * the connection string. It passes `connectionString` through UNCHANGED and
 * NEVER constructs or attaches a separate `ssl` config object. One
 * mechanism means the DSN is the only thing anyone ever has to audit for
 * this pool's TLS posture.
 *
 * -- Fail-closed production enforcement --
 * `assertDsnRequestsTls` is called from this factory ONLY when
 * `process.env.NODE_ENV === "production"` (read at CALL time, not at module
 * load, so a test can toggle it), and its throw is allowed to propagate --
 * fail-closed matches this project's posture everywhere else (RLS,
 * suppression, webhook signature verification), and the alternative ("warn
 * and continue") means the very first production deploy could silently
 * carry plaintext database traffic across the Docker network with nobody
 * the wiser. Outside production this factory does NOT call it: the test
 * suite provisions ephemeral DSNs by the hundred
 * (`packages/test-support/src/provision-db.ts`), and forcing TLS onto every
 * one of them is a blast radius this requirement does not ask for -- DB-13
 * is about production traffic, not every throwaway test database.
 *
 * D-10 (recorded here, not only in 14-RESEARCH.md): this phase deliberately
 * stops at `sslmode=require` against a self-signed certificate generated
 * inside the container (Task 3) -- it encrypts the wire but does not
 * authenticate the server's identity, so a co-located container could still
 * impersonate Postgres (T-14-12, accepted risk with a recorded revisit
 * trigger). `verify-full` plus real CA management is deferred until
 * Postgres has a real network path worth authenticating (plan 14-08+).
 *
 * -- TimeZone: pinned at handshake, not by a post-connect SET (WR-06, D-01) --
 * `now()` is a `timestamptz`; coercing it into a naive `timestamp` column
 * (`contacts.created_at` and siblings) uses the **session's** `TimeZone` GUC.
 * With no pin, a Postgres server or database whose own default timezone is
 * ever non-UTC silently stores local wall-clock values into those naive
 * columns, and every day-bucketed metric derived from them shifts. Two
 * mechanisms were considered:
 *
 *   - `options: '-c TimeZone=UTC'` on `new Pool({...})` -- node-postgres
 *     forwards this string verbatim in the Postgres startup packet, so the
 *     GUC is negotiated during the connection handshake itself, before any
 *     query can run on that connection. CHOSEN.
 *   - `pool.on("connect", client => client.query("SET TIME ZONE 'UTC'"))` --
 *     REJECTED. A documented race in node-postgres
 *     (brianc/node-postgres#3265, "Timezone not set on pool event
 *     'connect'"): the `SET` fires asynchronously and a query can reach the
 *     connection before it completes, so the timezone silently fails to
 *     apply on some fraction of connections.
 *
 * `packages/db/src/partitions/relocate-default.ts` already establishes the
 * companion read-site idiom for naive-timestamp columns (the double-hop
 * `AT TIME ZONE 'UTC'` cast); plan 17-02 applies that idiom to the
 * growth-chart query this pin's write-path fix pairs with.
 *
 * Revisit trigger: there is no external connection pooler (PgBouncer or
 * similar) anywhere in this topology today (DB-14 deferred to SCALE-02).
 * Transaction-mode pooling can restrict or drop non-default startup
 * parameters via its own `ignore_startup_parameters` setting -- if SCALE-02
 * ever introduces a pooler, this pin must be re-verified against a real
 * backend connection under that topology before it can be trusted there.
 */

export interface CreatePgPoolOptions {
  /** The DSN to connect with. Passed through to `pg.Pool` unchanged -- see the TLS rationale above. */
  connectionString: string;
  /**
   * Identifies this pool's consumer for log attribution (an emitted
   * `'error'` names which pool dropped a connection, not "some pool") and
   * for the `PG_POOL_SIZES` lookup below. Required, not inferred, so every
   * call site states explicitly what it is.
   */
  name: string;
  /** Explicit override for this pool's `max` -- bypasses `PG_POOL_SIZES`/`PG_POOL_DEFAULT_MAX` entirely when supplied. */
  max?: number;
}

/**
 * Named per-consumer pool-size ceilings (D-11). Sized from what each
 * consumer actually does, not uniformly:
 *
 *   - `db` (packages/db/src/index.ts's main Drizzle pool): the non-tenant,
 *     non-auth app-role client -- workspace-slug lookups and similar --
 *     imported by both `apps/api`'s request path and `apps/worker`
 *     (indirectly, via shared packages), so it carries concurrent work in
 *     BOTH long-running processes.
 *   - `auth` (packages/db/src/index.ts's lazily-built better-auth adapter
 *     pool): concurrent HTTP work on every authenticated request in
 *     `apps/api` (session/account/organization reads); never constructed in
 *     `apps/worker` (no worker source imports the better-auth schema).
 *   - `tenant-context` (packages/tenant-context/src/index.ts's shared
 *     RLS-scoped pool): the busiest pool in the system by a wide margin --
 *     every tenant-scoped request AND every one of `apps/worker`'s ~14 queue
 *     workers checks connections out of this exact pool.
 *   - `tenant-context-scan` (packages/tenant-context/src/scan.ts's lazy
 *     cross-workspace scan pool): several background watchdogs/reconcilers
 *     read through it, but each is a low-frequency tick, not a per-request
 *     path.
 *   - `worker-partition-maintenance` / `worker-dead-letter`
 *     (apps/worker/src/queues/...): single-tick, low-concurrency consumers
 *     -- one daily cron run plus one boot-time run, or one write per
 *     terminal job failure. 2 connections is generous headroom, not 10.
 *
 * Operator CLI scripts (`packages/db/scripts/*.ts`) are deliberately NOT
 * listed here: each runs as a single, sequential, one-shot process invoked
 * by a human, never concurrently with itself, and never alongside a second
 * instance of the same script. They fall through to `PG_POOL_DEFAULT_MAX`.
 *
 * Sum of maxima across every LONG-RUNNING production process, assuming one
 * instance each of `apps/api` and `apps/worker` (the number 14-13's own
 * budget table must refine for horizontal scaling):
 *   apps/api:    db(10) + auth(10) + tenant-context(20) + tenant-context-scan(5) = 45
 *   apps/worker: db(10) + tenant-context(20) + tenant-context-scan(5)
 *                + worker-partition-maintenance(2) + worker-dead-letter(2)      = 39
 *   TOTAL (one instance of each process)                                        = 84
 * This is the number plan 14-08 sizes Postgres's own `max_connections`
 * against, and the number plan 14-13's budget table either confirms or
 * revises with the real per-process pool inventory (D-09's PgBouncer
 * deferral rests on this arithmetic being written down and checkable, not
 * on it staying exactly 84 forever).
 */
export const PG_POOL_SIZES: Record<string, number> = {
  db: 10,
  auth: 10,
  "tenant-context": 20,
  "tenant-context-scan": 5,
  "worker-partition-maintenance": 2,
  "worker-dead-letter": 2,
};

/**
 * The default `max` for any named consumer NOT listed in `PG_POOL_SIZES` --
 * every operator CLI script in `packages/db/scripts`, and any future
 * low-concurrency consumer nobody has sized explicitly yet. 2 (not 1): a
 * handful of these scripts hold two connections briefly (e.g.
 * `audit-sends-history.ts`'s `Promise.all` across its own scan pool), and 2
 * is still nowhere near the 10 a concurrent-HTTP consumer needs.
 */
export const PG_POOL_DEFAULT_MAX = 2;

/** Pure resolution of a pool's `max`, shared by `createPgPool` and directly testable. */
export function poolSizeFor(name: string, explicitMax?: number): number {
  if (explicitMax !== undefined) return explicitMax;
  return PG_POOL_SIZES[name] ?? PG_POOL_DEFAULT_MAX;
}

/** Every `sslmode` value that actually requests an encrypted connection. */
const TLS_REQUESTING_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Throws unless `dsn`'s `sslmode` is one of `require`, `verify-ca` or
 * `verify-full`. Parses the DSN with the platform `URL` parser (a Postgres
 * connection string's query parameters are ordinary URL query parameters --
 * this is also exactly what `pg-connection-string`'s own `parse()` does
 * internally) rather than a bespoke regex, so this stays correct against
 * the same syntax `pg` itself accepts.
 */
export function assertDsnRequestsTls(dsn: string): void {
  const sslmode = new URL(dsn).searchParams.get("sslmode");
  if (!sslmode || !TLS_REQUESTING_SSLMODES.has(sslmode)) {
    throw new Error(
      `refusing to build a production Postgres pool from a DSN that does not request TLS ` +
        `(sslmode=${sslmode ?? "(absent)"}) -- set sslmode=require, verify-ca or verify-full`,
    );
  }
}

/**
 * Throws if `dsn` carries its own `options` query parameter -- see this
 * module's header comment ("`options`: exactly one mechanism, guarded").
 * `pg-connection-string` copies every URL query parameter (including
 * `options`) into the parsed config, and `pg`'s `ConnectionParameters` then
 * merges those parsed fields OVER whatever top-level `options` string this
 * factory passes to `new Pool({...})` -- so a DSN-level `options=` value
 * would silently defeat the `-c TimeZone=UTC` startup-parameter pin with no
 * error. Called unconditionally (every environment), unlike
 * `assertDsnRequestsTls`, because the TimeZone pin protects stored-data
 * correctness everywhere, not only production's TLS posture.
 */
export function assertDsnOmitsOptionsParam(dsn: string): void {
  if (new URL(dsn).searchParams.has("options")) {
    throw new Error(
      `refusing to build a Postgres pool from a DSN that sets its own 'options' query parameter -- ` +
        `it would silently override this factory's '-c TimeZone=UTC' startup-parameter pin ` +
        `(see packages/db/src/pool.ts's header comment, "options: exactly one mechanism, guarded")`,
    );
  }
}

/**
 * Builds a `pg.Pool` with an unconditional error listener, a single-source
 * TLS decision (the connection string alone), a guarded single-source
 * `options` decision (this factory's TimeZone pin alone), and an explicit,
 * named size. See this module's header comment for the full rationale
 * behind each of these properties.
 */
export function createPgPool(options: CreatePgPoolOptions): Pool {
  const { connectionString, name } = options;

  if (!connectionString || connectionString.trim() === "") {
    throw new Error(`createPgPool("${name}"): a non-empty connection string is required`);
  }

  // WR-01 follow-up: unconditional (every environment) -- a DSN-level
  // `options=` query parameter would silently override the TimeZone pin
  // below, and that hazard is not specific to production.
  assertDsnOmitsOptionsParam(connectionString);

  // Read at CALL time, not module load, so NODE_ENV can vary across calls
  // within the same process (and so a test can toggle it around one call).
  if (process.env.NODE_ENV === "production") {
    assertDsnRequestsTls(connectionString);
  }

  const max = poolSizeFor(name, options.max);

  // Deliberately no `ssl` key here -- see this module's header comment
  // ("TLS: exactly one mechanism").
  //
  // WR-06/D-01: every physical connection this pool ever opens negotiates
  // TimeZone=UTC during the Postgres startup handshake itself -- before any
  // query can run on it, unlike a `pool.on("connect", ...)` SET, which is a
  // documented race in node-postgres (see this module's header comment,
  // "TimeZone: pinned at handshake", citing brianc/node-postgres#3265).
  const pool = new Pool({ connectionString, max, options: "-c TimeZone=UTC" });

  // CR-03, made unskippable: without this listener an idle-connection
  // termination surfaces as an uncaught 'error' event and crashes the whole
  // process. Routed through scrubbedConsole (not bare console.error) so a
  // driver-level error string can never bypass this codebase's one
  // redaction path (T-14-16).
  pool.on("error", (err) => {
    scrubbedConsole.error(`pg pool "${name}": idle client error (connection dropped)`, err);
  });

  return pool;
}
