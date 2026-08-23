import { boolean, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * better-auth core + `organization` plugin schema, hand-authored to match
 * the shape the better-auth Drizzle adapter expects (column names mirror
 * better-auth's internal camelCase model fields verbatim — quoted where
 * Postgres would otherwise fold the identifier to lowercase).
 *
 * IDs are native Postgres `uuid` (`gen_random_uuid()` default), NOT
 * better-auth's default nanoid text ID — the app config sets
 * `advanced.database.generateId: false` (see modules/auth/auth.ts) so
 * better-auth defers to the database default. This is required so
 * `organization.id` / `workspace_id` columns are real `uuid`, matching the
 * `current_setting('app.current_workspace_id', true)::uuid` cast used by
 * every RLS policy (see ../../migrations/0001_rls_policies.sql).
 *
 * `organization.deletedAt` is a project-added `additionalFields` column
 * (not part of better-auth's default shape) so soft-delete (01-04's
 * delete-workspace flow, D-20) is present in the schema from Wave 0.
 *
 * IMPORTANT: These tables are queried by better-auth OUTSIDE any tenant
 * transaction (see apps/api/src/middleware/tenant-context.ts) — better-auth
 * scopes access via the session's active-organization membership, not via
 * Postgres RLS. RLS is enforced on domain tables instead (see
 * ./sendgrid-keys.ts + migrations/0001_rls_policies.sql).
 */

export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: uuid("id").primaryKey().defaultRandom(),
  expiresAt: timestamp("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: uuid("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // Added by the `organization` plugin: which workspace this session is
  // currently "inside", used by tenant-context.ts to resolve workspace_id.
  activeOrganizationId: uuid("activeOrganizationId"),
});

export const account = pgTable("account", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: uuid("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
});

/** A workspace, in better-auth's `organization` plugin terms. */
export const organization = pgTable("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  metadata: text("metadata"),
  // Project-added additionalField (D-20): soft-delete, physical cleanup
  // deferred to 01-04's delete-workspace flow.
  deletedAt: timestamp("deletedAt"),
  // Phase 22 (D-09, plan 22-01): stamped by `tombstoneOrganization`
  // (apps/worker/src/queues/workspace-purge.worker.ts) in the SAME UPDATE
  // that scrubs `name`/`slug` to non-identifying values -- non-null means
  // this workspace's tenant data has been physically destroyed and this row
  // survives only as an anonymized tombstone. `deletedAt` is left UNCHANGED
  // by that UPDATE (it still records when the soft-delete happened); this
  // column is the separate, later fact that the physical purge completed.
  // `timestamptz` (unlike `deletedAt`'s bare `timestamp`) because this is a
  // brand-new column with no legacy-value convention to match.
  purgedAt: timestamp("purgedAt", { withTimezone: true }),
});

export const member = pgTable(
  "member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  // Phase 14 (DB-12, plan 14-02): migration 0062 adds this exact
  // constraint, by this exact name, to the live database -- closes the
  // one confirmed structural gap this plan's live pg_constraint/pg_index
  // introspection found (member carried only its primary key). Declared
  // here too so `drizzle-kit generate` (plan 14-05's empty-diff gate) does
  // not see the database's constraint as a schema drift to re-add.
  (t) => [unique("member_organization_user_unique").on(t.organizationId, t.userId)],
);

export const invitation = pgTable("invitation", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organizationId")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expiresAt").notNull(),
  inviterId: uuid("inviterId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // 01-04 fix: the organization plugin's own adapter
  // (better-auth/dist/plugins/organization/adapter.mjs createInvitation)
  // writes a `createdAt` value on every insert -- 01-01's hand-authored
  // schema omitted it, which throws "field createdAt does not exist in the
  // invitation Drizzle schema" the moment TENANT-02's invite-create route
  // runs (caught by invite-flow.test.ts).
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});
