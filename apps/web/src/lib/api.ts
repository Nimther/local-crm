/**
 * Thin fetch wrapper for the non-auth REST surface (/api/workspaces, etc).
 * Always sends the HttpOnly session cookie (credentials: "include") — the
 * SPA never reads the cookie directly (T-01-05, prohibition in 01-02-PLAN).
 */
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    // The guard above already narrows `body`; the assertion it used to carry
    // restated a type TypeScript had, and hid that `.error` is unknown.
    const err: unknown = body.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") return JSON.stringify(err);
  }
  return fallback;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      // Only attach the JSON content type when a body is actually sent.
      // Fastify 5.9.0 runs its content-type parser whenever this header is
      // present (regardless of content-length), so a bodyless request that
      // still carries it -- every bodyless apiDelete call before this fix --
      // is rejected with 400 FST_ERR_CTP_EMPTY_JSON_BODY before the route
      // handler ever runs. See
      // .planning/debug/ui-delete-empty-json-body-400.md. Do not "simplify"
      // this back to unconditional -- that reintroduces G-21-2.
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const contentType = res.headers.get("content-type") ?? "";
  // res.json() is typed `Promise<any>`; landing it in `unknown` keeps that
  // `any` from spreading into every caller through the return below.
  const body: unknown = contentType.includes("application/json")
    ? await res.json()
    : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(body, `Request failed: ${res.status}`), body);
  }

  return body as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, data: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify(data) });
}

export function apiPatch<T>(path: string, data: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(data) });
}

/** PUT wrapper (04-08: /send-settings is a PUT, not PATCH -- no full-replace verb existed yet). */
export function apiPut<T>(path: string, data: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "PUT", body: JSON.stringify(data) });
}

export function apiDelete<T>(path: string, data?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "DELETE",
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}
