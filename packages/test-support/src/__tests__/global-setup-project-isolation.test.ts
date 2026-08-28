import { URL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prepareTestRedisOnceMock } = vi.hoisted(() => ({
  prepareTestRedisOnceMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../redis-guard.js", () => ({
  prepareTestRedisOnce: prepareTestRedisOnceMock,
}));

import setup, { AMBIGUOUS_PROJECT_MARKER } from "../global-setup.js";

/**
 * Phase 10 debug (aggregate-coverage-run-fails) — the per-project ephemeral
 * database contract.
 *
 * `createEphemeralDatabase`'s `mega_crm_test_<workspace>_<runId>` naming has
 * always encoded the intent that every workspace gets its OWN database
 * (db-fixture-isolation.test.ts asserts the databases themselves stay apart).
 * What was never asserted is that each project's test workers actually RECEIVE
 * the DSN provisioned for them.
 *
 * They did not. `globalSetup` published the DSN by mutating the shared parent
 * `process.env`, and vitest runs EVERY project's globalSetup in that one parent
 * process before forking any worker (`Vitest.initializeGlobalSetup` loops the
 * projects sequentially). With five projects registering this hook, five
 * databases were provisioned and the last writer's DSN won: every project's
 * workers connected to ONE physical database, four of the five to a database
 * that was not theirs. That silently re-merged the tenants that
 * db-fixture-isolation.test.ts's per-database isolation exists to keep apart,
 * and made apps/worker's deliberately cross-tenant
 * `runFlowSegmentSweepTick()` compile another workspace's segment fixtures.
 *
 * The DSNs are therefore published into vitest's PER-PROJECT `config.env`
 * channel, which is merged over the inherited `process.env` when that project's
 * workers are spawned. These tests drive the hook directly with two stub
 * projects — the same way two projects hit it in an aggregate run — because
 * that is the only place the last-writer-wins collision is observable without
 * spawning a nested vitest.
 */

interface StubProject {
  name: string;
  config: { env: Record<string, string> };
}

function stubProject(name: string): StubProject {
  return { name, config: { env: {} } };
}

/** Every environment variable the hook writes, so each test restores the process it borrowed. */
const MUTATED_KEYS = [
  "TEST_REDIS_URL",
  "TEST_DATABASE_URL",
  "DATABASE_URL",
  "GSD_DEV_DATABASE_URL",
  "SCAN_DATABASE_URL",
  "AUTH_DATABASE_URL",
  "GSD_TEST_PROJECT",
] as const;

function databaseOf(dsn: string | undefined): string {
  if (!dsn) throw new Error("expected a DSN, got undefined");
  return new URL(dsn).pathname.replace(/^\//, "");
}

describe("global-setup: per-project ephemeral database publication", () => {
  let saved: Partial<Record<(typeof MUTATED_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    prepareTestRedisOnceMock.mockClear();
    saved = {};
    for (const key of MUTATED_KEYS) saved[key] = process.env[key];
    // Every test here simulates the START of a run. This project registers no
    // globalSetup of its own, so in an aggregated run its workers inherit a
    // process.env in which the OTHER projects' globalSetups have already left
    // GSD_TEST_PROJECT set (to the ambiguity marker, once there is more than
    // one of them). Clearing it makes these tests measure this hook's own
    // behaviour rather than how many sibling projects happened to run first.
    delete process.env.GSD_TEST_PROJECT;
  });

  afterEach(() => {
    for (const key of MUTATED_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("Test 1: two projects each receive their OWN database in their OWN config.env -- not one shared, last-writer-wins DSN", async () => {
    const alpha = stubProject("@mega-crm/iso-alpha");
    const beta = stubProject("@mega-crm/iso-beta");

    const teardownAlpha = await setup(alpha);
    const teardownBeta = await setup(beta);

    try {
      // Each project's DSN names the database provisioned for THAT project.
      expect(databaseOf(alpha.config.env.TEST_DATABASE_URL)).toContain("iso_alpha");
      expect(databaseOf(beta.config.env.TEST_DATABASE_URL)).toContain("iso_beta");

      // And they are genuinely different physical databases, not two spellings
      // of one (the whole failure mode was them collapsing into one).
      expect(databaseOf(alpha.config.env.TEST_DATABASE_URL)).not.toBe(
        databaseOf(beta.config.env.TEST_DATABASE_URL),
      );
    } finally {
      await teardownBeta();
      await teardownAlpha();
    }
  });

  it("Test 2: within one project every published DSN -- app, scan and auth roles -- names that project's own single database", async () => {
    const alpha = stubProject("@mega-crm/iso-roles-alpha");
    const beta = stubProject("@mega-crm/iso-roles-beta");

    const teardownAlpha = await setup(alpha);
    const teardownBeta = await setup(beta);

    try {
      for (const project of [alpha, beta]) {
        const own = databaseOf(project.config.env.TEST_DATABASE_URL);
        // A role-swapped DSN that pointed at a DIFFERENT database than
        // TEST_DATABASE_URL would send cross-tenant scans (SCAN) or fixture
        // organization inserts (AUTH) into another project's data.
        expect(databaseOf(project.config.env.DATABASE_URL)).toBe(own);
        expect(databaseOf(project.config.env.SCAN_DATABASE_URL)).toBe(own);
        expect(databaseOf(project.config.env.AUTH_DATABASE_URL)).toBe(own);

        expect(project.config.env.SCAN_DATABASE_URL).toContain("mega_crm_scan");
        expect(project.config.env.AUTH_DATABASE_URL).toContain("mega_crm_auth");
      }
    } finally {
      await teardownBeta();
      await teardownAlpha();
    }
  });

  it("Test 3: the fail-closed guard keeps comparing against the REAL dev DSN, never against a previous project's ephemeral one", async () => {
    const devDsn = "postgres://dev:dev@localhost:5432/mega_crm_dev_isolation_fixture";
    process.env.DATABASE_URL = devDsn;
    delete process.env.GSD_DEV_DATABASE_URL;

    const alpha = stubProject("@mega-crm/iso-dev-alpha");
    const beta = stubProject("@mega-crm/iso-dev-beta");

    const teardownAlpha = await setup(alpha);
    const teardownBeta = await setup(beta);

    try {
      // The stash is what db-fixture.ts's second guard layer (D-14 layer b)
      // compares against. Overwriting it on the second invocation -- as the
      // shared-process.env version did -- makes BOTH guard layers compare one
      // ephemeral DSN against another, which can never collide, so the guard
      // silently stops guarding for projects 2..N.
      expect(process.env.GSD_DEV_DATABASE_URL).toBe(devDsn);
      expect(alpha.config.env.GSD_DEV_DATABASE_URL).toBe(devDsn);
      expect(beta.config.env.GSD_DEV_DATABASE_URL).toBe(devDsn);
    } finally {
      await teardownBeta();
      await teardownAlpha();
    }
  });

  it("Test 4: a second project poisons the shared process.env project marker, so any worker reading it instead of its own config.env fails loudly", async () => {
    const alpha = stubProject("@mega-crm/iso-marker-alpha");
    const beta = stubProject("@mega-crm/iso-marker-beta");

    const teardownAlpha = await setup(alpha);
    try {
      // One project: the shared copy is unambiguous and usable.
      expect(process.env.GSD_TEST_PROJECT).toBe("@mega-crm/iso-marker-alpha");

      const teardownBeta = await setup(beta);
      try {
        // Two projects: the shared copy can no longer identify anyone, and says
        // so. Each project's own channel still carries the truth.
        expect(process.env.GSD_TEST_PROJECT).toBe(AMBIGUOUS_PROJECT_MARKER);
        expect(alpha.config.env.GSD_TEST_PROJECT).toBe("@mega-crm/iso-marker-alpha");
        expect(beta.config.env.GSD_TEST_PROJECT).toBe("@mega-crm/iso-marker-beta");
      } finally {
        await teardownBeta();
      }
    } finally {
      await teardownAlpha();
    }
  });

  it("Test 5: a project object with no config (the Playwright entrypoint's shape) still gets its DSN through process.env", async () => {
    const teardown = await setup({ name: "@mega-crm/iso-no-config" });
    try {
      expect(databaseOf(process.env.TEST_DATABASE_URL)).toContain("iso_no_config");
      expect(databaseOf(process.env.DATABASE_URL)).toBe(databaseOf(process.env.TEST_DATABASE_URL));
    } finally {
      await teardown();
    }
  });

  it("Test 6: setup routes the explicitly test-only Redis URL through the fail-closed preparation boundary", async () => {
    process.env.TEST_REDIS_URL = "redis://localhost:6379/4";

    const teardown = await setup(stubProject("@mega-crm/iso-redis-guard"));
    try {
      expect(prepareTestRedisOnceMock).toHaveBeenCalledTimes(1);
      expect(prepareTestRedisOnceMock).toHaveBeenCalledWith("redis://localhost:6379/4");
    } finally {
      await teardown();
    }
  });
});
