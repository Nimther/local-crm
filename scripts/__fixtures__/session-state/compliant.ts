// Compliant fixture for scripts/lint-session-state.mjs (10-05).
//
// Prose describing the forbidden constructs on purpose, to prove the checker
// strips comments before matching (T-10-05 Test 3): a bare `SET app.foo =
// '1'` with no LOCAL qualifier is exactly what the audit forbids, and `SET
// ROLE` / `RESET ROLE` / `SET SESSION AUTHORIZATION` role switches have no
// accepted form at all in this codebase. Neither forbidden shape is a live
// statement below -- they only appear in this comment as English words, the
// same way CONVENTIONS.md and packages/tenant-context/src/index.ts describe
// them without ever executing them.
//
// Excluded from tsconfig builds, ESLint, and coverage collection, same as
// `tools/lint-fixtures/`.

interface QueryableClient {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/** Accepted form 1: the transaction-local assignment qualifier. */
export async function compliantSetLocal(client: QueryableClient, workspaceId: string): Promise<void> {
  await client.query(`SET LOCAL app.current_workspace_id = '${workspaceId}'`);
}

/** Accepted form 2: set_config with a literal `true` third argument. */
export async function compliantSetConfigTrue(
  client: QueryableClient,
  workspaceId: string,
): Promise<void> {
  await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
}

/**
 * A documented exception: the marker on the line immediately above the
 * statement, with a reason, suppresses exactly that statement -- not the
 * whole file.
 */
export async function compliantDocumentedException(client: QueryableClient): Promise<void> {
  // session-state-exception: one-shot maintenance connection closed immediately after this call, never returned to any app-level pool -- see scripts/ensure-db-roles.mjs
  await client.query("SET statement_timeout = '0'");
}
