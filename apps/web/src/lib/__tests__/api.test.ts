import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiFetch, apiGet, apiPost, apiPatch, apiPut, apiDelete, ApiError } from "../api";

/**
 * Request-shape matrix pinning the fix for G-21-2 (every bodyless
 * apiDelete call sent Content-Type: application/json with no body, which
 * Fastify 5.9.0 rejects with 400 FST_ERR_CTP_EMPTY_JSON_BODY -- see
 * .planning/debug/ui-delete-empty-json-body-400.md). apps/web/vitest.config.ts
 * runs `environment: "node"` -- there is no jsdom/@testing-library here, so
 * `globalThis.fetch` is stubbed directly rather than reaching for a DOM
 * helper.
 */

function makeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("apiFetch request shape", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(makeResponse({}));
    vi.stubGlobal("fetch", fetchMock);
  });

  function calledInit(): RequestInit {
    return fetchMock.mock.calls[0]?.[1] as RequestInit;
  }

  function headerRecord(init: RequestInit): Record<string, string> {
    return (init.headers ?? {}) as Record<string, string>;
  }

  it("apiGet(path) carries no Content-Type header and no body", async () => {
    await apiGet("/x");
    const init = calledInit();
    expect(headerRecord(init)["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("apiDelete(path) with no data carries no Content-Type header and no body", async () => {
    await apiDelete("/x/1");
    const init = calledInit();
    expect(headerRecord(init)["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("apiDelete(path, data) sets Content-Type: application/json and stringifies the body", async () => {
    const data = { confirmName: "acme" };
    await apiDelete("/x/1", data);
    const init = calledInit();
    expect(headerRecord(init)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(data));
  });

  it("apiPost(path, data) sets Content-Type and stringifies the body", async () => {
    const data = { name: "hi" };
    await apiPost("/x", data);
    const init = calledInit();
    expect(headerRecord(init)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(data));
  });

  it("apiPatch(path, data) sets Content-Type and stringifies the body", async () => {
    const data = { name: "hi" };
    await apiPatch("/x", data);
    const init = calledInit();
    expect(headerRecord(init)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(data));
  });

  it("apiPut(path, data) sets Content-Type and stringifies the body", async () => {
    const data = { name: "hi" };
    await apiPut("/x", data);
    const init = calledInit();
    expect(headerRecord(init)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(data));
  });

  it("apiPost(path, {}) still sets Content-Type because '{}' is a non-empty body -- this is why POST never hit the defect", async () => {
    await apiPost("/x", {});
    const init = calledInit();
    expect(headerRecord(init)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe("{}");
  });

  it("a caller-supplied header in init.headers overrides the default", async () => {
    await apiFetch("/x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "Content-Type": "application/vnd.custom+json" },
    });
    const init = calledInit();
    expect(headerRecord(init)["Content-Type"]).toBe("application/vnd.custom+json");
  });

  it("every request sets credentials: include", async () => {
    await apiGet("/x");
    await apiPost("/x", {});
    await apiDelete("/x/1");
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).credentials).toBe("include");
    }
  });

  it("a non-2xx response throws ApiError with the parsed body", async () => {
    fetchMock.mockResolvedValue(makeResponse({ error: "nope" }, { ok: false, status: 400 }));
    await expect(apiGet("/x")).rejects.toBeInstanceOf(ApiError);

    fetchMock.mockResolvedValue(makeResponse({ error: "nope" }, { ok: false, status: 400 }));
    try {
      await apiGet("/x");
      expect.unreachable("apiGet should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).body).toEqual({ error: "nope" });
    }
  });
});
