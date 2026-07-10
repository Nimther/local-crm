import type { PoolClient } from "pg";

/**
 * Per-workspace send throttling (D-13, SEND-04) PLUS the D-08/D-09 default
 * timezone + quiet-hours window a flow's `quiet_hours_mode: 'inherit'`
 * resolves against when a contact has no `contacts.timezone` set (06-07).
 */
export interface WorkspaceSendSettings {
  frequencyCap: number;
  frequencyWindowHours: number;
  rpsLimit: number | null;
  /** IANA zone name, or `null` when the workspace hasn't set one yet (06-07: falls back to `'UTC'` via `resolveTimezone`). */
  defaultTimezone: string | null;
  /** Minutes since local midnight, 0-1439, or `null` when unset. */
  quietHoursStart: number | null;
  /** Minutes since local midnight, 0-1439, or `null` when unset. */
  quietHoursEnd: number | null;
  /** Gates whether the workspace-default quiet-hours window applies to a flow in `'inherit'` mode. */
  quietHoursEnabled: boolean;
}

/** Defaults applied when a workspace has no `workspace_send_settings` row yet (D-13). */
const DEFAULT_SEND_SETTINGS: WorkspaceSendSettings = {
  frequencyCap: 3,
  frequencyWindowHours: 24,
  rpsLimit: null,
  defaultTimezone: null,
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursEnabled: false,
};

interface SendSettingsRow {
  frequencyCap: number;
  frequencyWindowHours: number;
  rpsLimit: number | null;
  defaultTimezone: string | null;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  quietHoursEnabled: boolean;
}

/** Reads `workspace_send_settings`, returning the 3/24/null defaults when no row exists (D-13). */
export async function getWorkspaceSendSettings(
  client: PoolClient,
  workspaceId: string
): Promise<WorkspaceSendSettings> {
  const { rows } = await client.query<SendSettingsRow>(
    `SELECT
       frequency_cap as "frequencyCap",
       frequency_window_hours as "frequencyWindowHours",
       rps_limit as "rpsLimit",
       default_timezone as "defaultTimezone",
       quiet_hours_start as "quietHoursStart",
       quiet_hours_end as "quietHoursEnd",
       quiet_hours_enabled as "quietHoursEnabled"
     FROM workspace_send_settings
     WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0] ?? DEFAULT_SEND_SETTINGS;
}

/** Upserts the workspace's send settings (for the 04-05 send-settings route). Partial patch over current/default values. */
export async function upsertWorkspaceSendSettings(
  client: PoolClient,
  workspaceId: string,
  patch: Partial<WorkspaceSendSettings>
): Promise<WorkspaceSendSettings> {
  const current = await getWorkspaceSendSettings(client, workspaceId);
  const next: WorkspaceSendSettings = { ...current, ...patch };

  const { rows } = await client.query<SendSettingsRow>(
    `INSERT INTO workspace_send_settings
       (workspace_id, frequency_cap, frequency_window_hours, rps_limit, default_timezone, quiet_hours_start, quiet_hours_end, quiet_hours_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id) DO UPDATE SET
       frequency_cap = EXCLUDED.frequency_cap,
       frequency_window_hours = EXCLUDED.frequency_window_hours,
       rps_limit = EXCLUDED.rps_limit,
       default_timezone = EXCLUDED.default_timezone,
       quiet_hours_start = EXCLUDED.quiet_hours_start,
       quiet_hours_end = EXCLUDED.quiet_hours_end,
       quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
       updated_at = now()
     RETURNING
       frequency_cap as "frequencyCap",
       frequency_window_hours as "frequencyWindowHours",
       rps_limit as "rpsLimit",
       default_timezone as "defaultTimezone",
       quiet_hours_start as "quietHoursStart",
       quiet_hours_end as "quietHoursEnd",
       quiet_hours_enabled as "quietHoursEnabled"`,
    [
      workspaceId,
      next.frequencyCap,
      next.frequencyWindowHours,
      next.rpsLimit,
      next.defaultTimezone,
      next.quietHoursStart,
      next.quietHoursEnd,
      next.quietHoursEnabled,
    ]
  );
  return rows[0] ?? next;
}
