// Deliberately violating fixture for scripts/lint-session-state.mjs (10-05).
//
// Every statement below is exactly what CONVENTIONS.md's "transaction-local
// session state only" rule forbids -- do not "fix" these to pass. That would
// defeat the audit's own fail-first proof (T-10-05-03): a checker that
// matches nothing looks identical to a checker that never ran.
//
// Excluded from tsconfig builds, ESLint, and coverage collection, same as
// `tools/lint-fixtures/`.

interface QueryableClient {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/** Violation 1 of 3: missing the LOCAL qualifier. */
export async function violatingConnectionScopedAssignment(
  client: QueryableClient,
  workspaceId: string,
): Promise<void> {
  // This persists on the pooled connection past COMMIT/ROLLBACK and leaks
  // into the next request or job that reuses it (Pitfall 10).
  await client.query(`SET app.current_workspace_id = '${workspaceId}'`);
}

/** Violation 2 of 3: a role switch, which has no accepted form at all. */
export async function violatingRoleSwitch(client: QueryableClient): Promise<void> {
  await client.query("SET ROLE mega_crm_admin");
}

/** Violation 3 of 3: set_config's third argument is not the literal `true`. */
export async function violatingSetConfigNotLocal(
  client: QueryableClient,
  workspaceId: string,
): Promise<void> {
  await client.query("SELECT set_config('app.current_workspace_id', $1, false)", [workspaceId]);
}
