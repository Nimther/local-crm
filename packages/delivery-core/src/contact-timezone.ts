import type { PoolClient } from "pg";

/**
 * D-08: per-contact timezone is the source of truth for quiet-hours/
 * wait_until evaluation -- quiet hours must be silence for the RECIPIENT,
 * not the workspace default. This is the single shared lookup both flow
 * handlers (`send-node.ts`'s `resolveQuietHoursWindow`, `delay-node.ts`'s
 * `handleDelayNode`) must import so the contact-timezone resolution can
 * never diverge between them again (06-15).
 */
export async function loadContactTimezone(
  client: PoolClient,
  workspaceId: string,
  contactId: string
): Promise<string | null> {
  const { rows } = await client.query<{ timezone: string | null }>(
    `SELECT timezone FROM contacts WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, contactId]
  );
  return rows[0]?.timezone ?? null;
}
