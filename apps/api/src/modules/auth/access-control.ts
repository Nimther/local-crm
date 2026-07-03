import { createAccessControl } from "better-auth/plugins/access";

/**
 * Full permission statement defined now (Open Question 3 / RESEARCH.md),
 * even though only `sendgridKey:update` is enforced by a real route in this
 * phase — `campaign:launch` and `flow:publish` land in Phase 4/6 but are
 * named here so later phases reference stable action names without an
 * access-control schema migration.
 */
export const statement = {
  sendgridKey: ["update"],
  campaign: ["launch"],
  flow: ["publish"],
} as const;

export const ac = createAccessControl(statement);

/** D-17: Member has full CRUD on drafts elsewhere, but none of the gated actions here. */
export const member = ac.newRole({
  sendgridKey: [],
  campaign: [],
  flow: [],
});

/** D-19: Admin can update the SendGrid key and launch/publish. */
export const admin = ac.newRole({
  sendgridKey: ["update"],
  campaign: ["launch"],
  flow: ["publish"],
});

/** D-18/D-19: Owner has every gated permission Admin has (plus team/ownership management, enforced by better-auth's org plugin itself). */
export const owner = ac.newRole({
  sendgridKey: ["update"],
  campaign: ["launch"],
  flow: ["publish"],
});
