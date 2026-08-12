import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";

import { createPgPool } from "../pool.js";

/**
 * Phase 14 plan 03 (DB-13, D-10), Task 3 -- proves TLS is actually
 * negotiated on the wire, by the SERVER'S OWN VIEW of the session
 * (`pg_stat_ssl`), never by inspecting config. RESEARCH.md's Pitfall B
 * failure mode is exactly "TLS looks configured in review while the wire is
 * plaintext" -- a config assertion could never catch that, which is why
 * this test always queries `pg_stat_ssl` for the connection's OWN backend
 * pid rather than asserting anything about the `Pool`'s own options.
 *
 * Confirmed against the installed pg@8.22.0 / pg-connection-string@2.14.0
 * dependency chain (packages/db/src/pool.ts's own header comment has the
 * full citation): a bare `sslmode=require` is treated as an alias for
 * `verify-full` (full certificate-chain verification) unless the DSN ALSO
 * carries `uselibpqcompat=true`, in which case `require` means classic
 * libpq semantics -- encrypt, don't verify. Against this phase's
 * self-signed certificate (docker/pg-tls-entrypoint.sh), a bare
 * `sslmode=require` would FAIL the handshake with a certificate-verification
 * error, not "connect without verifying" -- so the positive DSN below is
 * `sslmode=require&uselibpqcompat=true`, not `sslmode=require` alone. This
 * is a fact about pg 8.22.0, not something `createPgPool`/
 * `assertDsnRequestsTls` adds on the caller's behalf (see pool.ts's own
 * header) -- plan 14-08's production DSN needs the same parameter.
 *
 * ENVIRONMENT GATE: whether this suite's positive assertion actually runs
 * depends on the Postgres server THIS TEST RUN talks to actually serving
 * TLS. CI's `db` service serves TLS after this plan's docker-compose.yml
 * change, so the assertion runs there on every pass. A local run against a
 * plain (non-Docker, non-TLS) Postgres -- exactly this sandboxed
 * environment, which has no Docker daemon and provisions test databases
 * against a native `postgresql@17` Homebrew install instead -- cannot prove
 * a live TLS handshake, so the positive case is SKIPPED with a loud
 * `console.warn` naming the exact command to run once a TLS-capable
 * Postgres is available, per this task's own instruction not to weaken the
 * assertion into a config check. The negative case (no `sslmode` -> `ssl =
 * false`) is a true statement regardless of server TLS support and runs
 * unconditionally.
 */

async function probeServerServesTls(dsn: string): Promise<boolean> {
  const probePool = new Pool({ connectionString: dsn, max: 1 });
  try {
    const { rows } = await probePool.query<{ ssl: string }>("SHOW ssl");
    return rows[0]?.ssl === "on";
  } finally {
    await probePool.end();
  }
}

const provisioned = await createEphemeralDatabase({ workspace: "pg-tls" });
const serverServesTls = await probeServerServesTls(provisioned.dsn);

if (!serverServesTls) {
  // eslint-disable-next-line no-console -- deliberate, loud, human-facing skip notice, not app logging
  console.warn(
    "\npg-tls.test.ts: this run's Postgres server reports `SHOW ssl` = off -- the positive TLS " +
      "assertion (sslmode=require&uselibpqcompat=true -> pg_stat_ssl reports ssl=true) is SKIPPED in " +
      "this environment, not weakened to a config check (per this plan's own instruction). CI's " +
      "docker-compose.yml `db` service serves TLS after this plan's change, so the assertion runs " +
      "there on every pass. To run it locally: enable TLS on the Postgres this test's DSN points at " +
      "(docker compose up -d --wait, or `postgres -c ssl=on` with a cert/key pair for a native " +
      "install), then re-run `npx vitest run --root packages/db src/__tests__/pg-tls.test.ts`.\n",
  );
}

describe("pg_stat_ssl reports the real TLS posture of the connection (DB-13)", () => {
  afterAll(async () => {
    await dropEphemeralDatabase(provisioned.databaseName, provisioned.adminDsn);
  });

  it.skipIf(!serverServesTls)(
    "a factory pool built with sslmode=require&uselibpqcompat=true negotiates TLS with a non-empty cipher",
    async () => {
      const tlsUrl = new URL(provisioned.dsn);
      tlsUrl.searchParams.set("sslmode", "require");
      tlsUrl.searchParams.set("uselibpqcompat", "true");

      const pool = createPgPool({ connectionString: tlsUrl.toString(), name: "pg-tls-test-positive" });
      try {
        const client = await pool.connect();
        try {
          const { rows } = await client.query<{ ssl: boolean; cipher: string | null; version: string | null }>(
            "SELECT ssl, cipher, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
          );
          expect(rows).toHaveLength(1);
          expect(rows[0].ssl).toBe(true);
          expect(rows[0].cipher).not.toBeNull();
          expect(rows[0].cipher).not.toBe("");
          // A non-empty protocol/version is what distinguishes an actual
          // negotiated TLS session from a boolean column someone could have
          // defaulted -- RESEARCH.md Pitfall B's whole point.
          expect(rows[0].version).not.toBeNull();
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    },
  );

  it("a pool built with no sslmode at all reports ssl=false, proving the DSN alone drives TLS", async () => {
    const pool = createPgPool({ connectionString: provisioned.dsn, name: "pg-tls-test-negative" });
    try {
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ ssl: boolean }>(
          "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].ssl).toBe(false);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
