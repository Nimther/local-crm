import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

/**
 * better-auth React client. baseURL points at the same-origin /api/auth
 * (Vite dev proxy forwards to the Fastify API — see vite.config.ts), and the
 * HttpOnly session cookie is sent automatically for same-origin requests.
 * `credentials: "include"` is set explicitly so the cookie is always sent
 * even if the proxy target is ever swapped for a cross-origin API URL.
 */
export const authClient = createAuthClient({
  baseURL: "/api/auth",
  fetchOptions: {
    credentials: "include",
  },
  plugins: [organizationClient()],
});

export const { useSession, signIn, signUp, signOut, organization } = authClient;
