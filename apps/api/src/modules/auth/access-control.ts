import { createAccessControl } from "better-auth/plugins/access";

/**
 * Full permission statement. `sendgridKey`/`campaign`/`flow` were defined in
 * 01-01 (Open Question 3 / RESEARCH.md) for later phases to reference.
 *
 * `organization`/`member`/`invitation` are added in 01-04 and MUST mirror
 * better-auth's own default statement shape (see
 * better-auth/dist/plugins/organization/access/statement.mjs) -- passing a
 * custom `ac` + `roles` to the `organization` plugin REPLACES its default
 * roles entirely (organization.ts does `{ ...defaultRoles, ...opts.roles }`,
 * but `hasPermission` reads `ctx.context.orgOptions.roles`, i.e. the RAW
 * `opts.roles` we pass, never the merged variable). Without these three
 * resources defined here, every `invitation:create`/`member:update`/
 * `organization:delete` permission check the org plugin's own routes run
 * (createInvitation, updateMemberRole, removeMember, updateOrganization,
 * deleteOrganization) would deny EVERYONE, including the Owner -- verified
 * by reading node_modules/better-auth/dist/plugins/organization/*.mjs
 * directly, not assumed.
 */
export const statement = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  sendgridKey: ["update"],
  campaign: ["launch"],
  flow: ["publish"],
  // D-21: Owner/Admin create and revoke workspace API keys independently;
  // Member has neither (02-03).
  apiKeys: ["create", "revoke"],
} as const;

export const ac = createAccessControl(statement);

/**
 * D-17: Member has full CRUD on drafts elsewhere (contacts/segments/flow and
 * campaign drafts, out of this phase's scope), but none of the
 * organization/member/invitation/sendgridKey/campaign/flow actions gated here.
 */
export const member = ac.newRole({
  organization: [],
  member: [],
  invitation: [],
  sendgridKey: [],
  campaign: [],
  flow: [],
  apiKeys: [],
});

/**
 * D-18/D-19: Admin manages the team (invite, change roles, remove members)
 * and can update the SendGrid key / launch+publish, but only "update" on the
 * organization (not "delete" -- D-20 workspace deletion is Owner-only) and
 * NOT the ability to assign/remove the Admin role or transfer ownership.
 * That last restriction cannot be expressed as an ac permission (better-auth
 * only distinguishes the built-in `creatorRole` from everyone else) -- it is
 * enforced by an explicit owner-only check in members.ts/invites.ts, on top
 * of this ac gate.
 */
export const admin = ac.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  sendgridKey: ["update"],
  campaign: ["launch"],
  flow: ["publish"],
  apiKeys: ["create", "revoke"],
});

/** D-18/D-19/D-20: Owner has every gated permission, including organization delete. */
export const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  sendgridKey: ["update"],
  campaign: ["launch"],
  flow: ["publish"],
  apiKeys: ["create", "revoke"],
});
