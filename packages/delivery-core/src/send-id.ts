import { createHash } from "node:crypto";

/**
 * Deterministic send-intent id derivation (Phase 11, D-09, DLV-05).
 *
 * Closes the release-claim phantom-event hole (RESEARCH.md Pitfall 4):
 * `releaseDispatchClaim` DELETEs a `dispatching` row on a 429/5xx response
 * because SendGrid is assumed not to have accepted the message. If SendGrid
 * silently accepted it anyway, that row's id is the ONLY thing a later
 * webhook event can use to find its way back to this send -- and until this
 * module existed, the next claim attempt got a brand-new `gen_random_uuid()`
 * id, so the phantom message's evidence would arrive addressed to an id
 * nothing recognizes, and the retry would send a genuine second email to the
 * same contact. Deriving `sends.id` as a pure function of the send intent
 * means a re-claim for the same intent always reproduces the SAME id, so a
 * late-arriving webhook for the phantom attempt still correlates -- to
 * whichever row currently occupies that id.
 *
 * `campaign:`/`flow:` key prefixes keep the two intent spaces from
 * colliding: a campaign send and a flow send that happen to share the same
 * three positional argument values (e.g. by coincidence of two different
 * UUIDs matching pairwise, astronomically unlikely but not structurally
 * impossible) must never derive the same id, because they are two distinct
 * `sends` rows keyed by different unique constraints.
 *
 * `kind='test'` sends are explicitly EXEMPT from this module (D-11) -- they
 * never enter the ledger at all (`send-dispatch.ts`'s test branch keeps
 * `randomUUID()`), so there is no intent to derive a stable id from and no
 * correlation requirement to satisfy. Do not "fix" that call site to use
 * this module.
 *
 * Human decision at the 11-04 package-legitimacy checkpoint: the reviewer
 * chose "hand-roll" over adding the `uuid` npm dependency RESEARCH.md
 * recommended for UUIDv5 generation. This file is therefore a self-contained
 * RFC 4122 §4.3 UUIDv5 implementation over `node:crypto`'s `sha1` digest --
 * no new runtime dependency is introduced anywhere in this plan;
 * `packages/delivery-core/package.json` and `package-lock.json` are
 * unchanged. `send-id.test.ts` carries the correctness burden a library
 * would otherwise have already discharged (a published RFC test vector, not
 * self-agreement) precisely because there is no library here to trust.
 *
 * UUIDv5's internal SHA-1 use is NOT a security control: there is no secret
 * input, no adversarial input, and no confidentiality/integrity property
 * being claimed. SHA-1's deprecation for collision-resistance purposes
 * (certificate signing, etc.) does not apply to this non-adversarial,
 * deterministic id-derivation use -- do not flag this as a weak-hash finding
 * in review (RESEARCH.md T-11-04-04 disposition: accept).
 */

/**
 * Fixed, project-specific UUIDv5 namespace -- deliberately NOT one of the
 * RFC-predefined DNS/URL namespaces, since the values hashed here (campaign
 * and flow send intents) are neither DNS names nor URLs.
 *
 * THIS CONSTANT IS IMMUTABLE INFRASTRUCTURE, LIKE A MIGRATION. Changing it
 * re-derives a DIFFERENT id for every existing send intent, silently
 * orphaning every `custom_args.send_id` SendGrid already holds for every
 * message ever sent by this platform -- any webhook evidence in flight at
 * the moment of the change would stop correlating to anything. The golden
 * vector pinned in `send-id.test.ts` (`"SEND_ID_NAMESPACE pins the literal
 * value"` / the fully-worked derivation test) is the tripwire: it fails
 * loudly the moment this literal, or the key-composition strings in
 * `deriveCampaignSendId`/`deriveFlowSendId` below, ever change.
 */
export const SEND_ID_NAMESPACE = "6f1c9a3e-5d2b-4f8a-9c17-2e0b7d4a6591";

/**
 * Parses a canonical (hyphenated or bare-hex) UUID string into its 16 raw
 * bytes, or throws. Deliberately strict: a truncated or non-hex namespace
 * must fail loudly rather than silently hash to a plausible-looking but
 * wrong 16-byte buffer (a truncated `Buffer.from(hex, "hex")` on invalid
 * input pads/truncates instead of throwing, which is exactly the silent
 * failure mode this function exists to prevent).
 */
function parseUuid(uuidString: string): Buffer {
  const hex = uuidString.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(
      `send-id: "${uuidString}" is not a valid UUID -- expected 32 hex characters (with or without hyphens)`
    );
  }
  return Buffer.from(hex, "hex");
}

/** Formats 16 raw bytes as a canonical lowercase `8-4-4-4-12` UUID string. */
function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/**
 * RFC 4122 §4.3 UUIDv5: `SHA-1(namespace_bytes || name_bytes)`, truncated to
 * 16 bytes, with the version nibble forced to `5` and the variant bits
 * forced to the RFC 4122 pattern (`10xx` in the high bits of byte 8, i.e.
 * the first hex character of the fourth hyphenated group is one of
 * `8`/`9`/`a`/`b`). `namespace` must itself be a valid UUID string (throws
 * via `parseUuid` otherwise); `name` is UTF-8 encoded before hashing.
 */
export function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = parseUuid(namespace);
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1").update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(hash.subarray(0, 16));
}

/**
 * Derives the deterministic `sends.id` for a `kind='campaign'` send intent.
 * Called from EVERY campaign ledger insert site (`dispatchSendGate`,
 * `recordExcluded`) so the same intent always produces the same id
 * regardless of which insert path reaches it first (RESEARCH.md key_links).
 */
export function deriveCampaignSendId(workspaceId: string, campaignId: string, contactId: string): string {
  return uuidv5(`campaign:${workspaceId}:${campaignId}:${contactId}`, SEND_ID_NAMESPACE);
}

/**
 * Derives the deterministic `sends.id` for a `kind='flow'` send intent.
 * Called from EVERY flow ledger insert site (`claimFlowSend`,
 * `recordFlowExcluded`) for the same reason `deriveCampaignSendId` is.
 */
export function deriveFlowSendId(workspaceId: string, flowRunId: string, nodeId: string): string {
  return uuidv5(`flow:${workspaceId}:${flowRunId}:${nodeId}`, SEND_ID_NAMESPACE);
}
