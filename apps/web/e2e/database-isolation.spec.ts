import { test, expect } from "@playwright/test";
import { Pool } from "pg";

/**
 * 08-18 (QG-04) — the assertion whose absence let the isolation defect survive.
 *
 * Everything 08-10 built asserted the PROVISIONING side: a database was
 * created, guarded, migrated and printed. None of it asserted the side that
 * matters — that the server under test writes there. It did not: Playwright
 * starts the webServer before `globalSetup`, so the API had already read the
 * developer's dev DSN, and 79 of the 88 rows in the development `user` table
 * turned out to be E2E fixtures accumulated over months of "isolated" runs.
 *
 * So this test asserts the direction that was missing. It registers through
 * the real UI and then opens its OWN connection to the ephemeral database to
 * confirm the row landed there. If the server is ever pointed somewhere else
 * again, the row will be missing from this database and this fails — which is
 * exactly what did not happen for the entire life of the defect.
 *
 * The DSN comes from the same environment variable the config exports after
 * provisioning, NOT from a name this file constructs: a second naming rule
 * would be a second thing to keep in sync.
 */
test("the server under test writes to the ephemeral database, not the developer's", async ({
  page,
}) => {
  const dsn = process.env.MEGA_CRM_E2E_DATABASE_URL;

  // Fail loudly rather than skip. A missing DSN means provisioning did not run,
  // and a skipped isolation check reports green having verified nothing — the
  // same vacuous-success shape every other gate in this phase refuses.
  expect(
    dsn,
    "MEGA_CRM_E2E_DATABASE_URL is unset — provisioning did not run, so there is nothing to assert against",
  ).toBeTruthy();
  expect(dsn).toContain("mega_crm_test_e2e_");

  const email = `isolation-${Date.now()}@example.com`;

  await page.goto("/register");
  await page.getByLabel(/имя/i).fill("Isolation Probe");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/пароль/i).fill("correct horse battery staple 42");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await page.waitForURL("**/create-workspace");

  const pool = new Pool({ connectionString: dsn });
  try {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "user" WHERE email = $1',
      [email],
    );
    expect(
      rows[0]?.count,
      `the account registered through the UI is absent from ${dsn?.replace(/:[^:@]*@/, ":***@")} — the server wrote somewhere else`,
    ).toBe("1");
  } finally {
    await pool.end();
  }
});
