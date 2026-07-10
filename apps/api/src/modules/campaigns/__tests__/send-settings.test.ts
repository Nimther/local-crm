import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 06-07 (D-08/D-09): PUT /send-settings extended to accept + persist the
 * workspace default timezone and quiet-hours window, alongside the
 * pre-existing frequency-cap/rps fields (D-13, untouched). T-06-07-01: an
 * invalid IANA `defaultTimezone` is rejected with 400, never stored.
 */
describe("Workspace send-settings -- default timezone + quiet hours (06-07/D-08/D-09)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-up response did not set a session cookie");
    }
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
  }

  async function createWorkspace(cookie: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create workspace failed: ${res.body}`).toBe(200);
    return res.json() as { id: string; slug: string; name: string };
  }

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  it("persists default_timezone + quiet_hours_start/end + quiet_hours_enabled", async () => {
    const { cookie, workspace } = await owner("settings-tz");

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.slug}/send-settings`,
      headers: { cookie },
      payload: {
        frequencyCap: 3,
        frequencyWindowHours: 24,
        defaultTimezone: "America/New_York",
        quietHoursStart: 21 * 60,
        quietHoursEnd: 8 * 60,
        quietHoursEnabled: true,
      },
    });
    expect(putRes.statusCode, `PUT failed: ${putRes.body}`).toBe(200);
    expect(putRes.json()).toMatchObject({
      defaultTimezone: "America/New_York",
      quietHoursStart: 21 * 60,
      quietHoursEnd: 8 * 60,
      quietHoursEnabled: true,
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/send-settings`,
      headers: { cookie },
    });
    expect(getRes.statusCode, `GET failed: ${getRes.body}`).toBe(200);
    expect(getRes.json()).toMatchObject({
      defaultTimezone: "America/New_York",
      quietHoursStart: 21 * 60,
      quietHoursEnd: 8 * 60,
      quietHoursEnabled: true,
    });
  });

  it("T-06-07-01: rejects an invalid IANA defaultTimezone with 400, never persists it", async () => {
    const { cookie, workspace } = await owner("settings-tz-invalid");

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.slug}/send-settings`,
      headers: { cookie },
      payload: { frequencyCap: 3, frequencyWindowHours: 24, defaultTimezone: "Mars/Phobos" },
    });
    expect(putRes.statusCode).toBe(400);
    expect(putRes.json().code).toBe("invalid_timezone");

    const getRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/send-settings`,
      headers: { cookie },
    });
    expect(getRes.json().defaultTimezone).toBeNull();
  });

  it("D-13: frequency cap/rps still persist unaffected by the new timezone/quiet-hours fields", async () => {
    const { cookie, workspace } = await owner("settings-freq");

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspace.slug}/send-settings`,
      headers: { cookie },
      payload: { frequencyCap: 10, frequencyWindowHours: 12, rpsLimit: 5 },
    });
    expect(putRes.statusCode, `PUT failed: ${putRes.body}`).toBe(200);
    expect(putRes.json()).toMatchObject({ frequencyCap: 10, frequencyWindowHours: 12, rpsLimit: 5 });
  });
});
