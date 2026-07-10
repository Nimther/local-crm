import type { PoolClient } from "pg";
import { CONTACT_COLUMNS, type ContactRow } from "@mega-crm/contacts-core";
import { decryptTenantSecret } from "@mega-crm/kms";
import {
  evaluatePreSendGate,
  claimFlowSend as claimFlowSendLedger,
  recordFlowExcluded,
  recordFlowStepResult,
  buildContactTemplateData,
  signUnsubscribeToken,
  buildListUnsubscribeUrl,
  getWorkspaceSendSettings,
  type DispatchSendGateResult,
} from "@mega-crm/delivery-core";
import type { FlowDefinition } from "@mega-crm/flows-core";
import { DEFAULT_TENANT_RPS } from "../rate-limiter.js";

/**
 * Effectively long-lived per RESEARCH.md Assumption A3 -- mirrors
 * send-dispatch.ts's own constant/rationale exactly (an old flow-step email
 * sitting unopened for months must still successfully unsubscribe when
 * finally clicked). Duplicated rather than imported: send-dispatch.ts does
 * not export this constant, and this is genuinely a fixed policy value, not
 * shared mutable state.
 */
const UNSUBSCRIBE_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;

interface SendgridKeyRow {
  ciphertext: string;
  encryptedDek: string;
  iv: string;
  authTag: string;
}

export interface FlowSendPrereqs {
  apiKey: string;
  rps: number;
  templateId: string;
  fromEmail: string;
}

/**
 * Resolves a flow-step send's prerequisites (FLOW-01, RESEARCH.md Pattern
 * 1 item 5): decrypts the tenant's SendGrid key and reads the per-tenant
 * RPS override (same as send-dispatch.ts's `readSendPrereqs`), then resolves
 * `templateId`/`fromEmail` from the send-node's own config inside the
 * PINNED `flow_versions.definition` (joined via `flow_runs.flow_version_id`
 * -- NEVER `flows.live_version_id`, which may have moved on to a newer,
 * unrelated published version since this run started; FLOW-06/FLOW-07
 * immutability guarantee). Throws if the run/version isn't found, if the
 * node isn't a `send` node, or if the node is missing a templateId/fromEmail
 * (mirrors `readSendPrereqs`'s "missing templateId/fromEmail" guard for
 * campaigns).
 */
export async function readFlowSendPrereqs(
  client: PoolClient,
  workspaceId: string,
  flowRunId: string,
  nodeId: string
): Promise<FlowSendPrereqs> {
  const { rows: keyRows } = await client.query<SendgridKeyRow>(
    `SELECT ciphertext, encrypted_dek as "encryptedDek", iv, auth_tag as "authTag"
     FROM workspace_sendgrid_keys WHERE workspace_id = $1`,
    [workspaceId]
  );
  const keyRow = keyRows[0];
  if (!keyRow) {
    throw new Error(`No SendGrid key connected for workspace ${workspaceId}`);
  }
  const apiKey = await decryptTenantSecret(workspaceId, keyRow);

  const settings = await getWorkspaceSendSettings(client, workspaceId);
  const rps = settings.rpsLimit ?? DEFAULT_TENANT_RPS;

  const { rows: versionRows } = await client.query<{ definition: FlowDefinition }>(
    `SELECT fv.definition
     FROM flow_runs fr
     JOIN flow_versions fv ON fv.id = fr.flow_version_id
     WHERE fr.id = $1 AND fr.workspace_id = $2`,
    [flowRunId, workspaceId]
  );
  const definition = versionRows[0]?.definition;
  if (!definition) {
    throw new Error(`Flow run ${flowRunId} (or its pinned flow_version) not found in workspace ${workspaceId}`);
  }

  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type !== "send") {
    throw new Error(`Node ${nodeId} in flow run ${flowRunId}'s pinned definition is not a send node`);
  }

  if (!node.templateId || !node.fromEmail) {
    throw new Error(
      `Send node ${nodeId} (flow run ${flowRunId}) is missing a templateId/fromEmail -- cannot dispatch`
    );
  }

  return { apiKey, rps, templateId: node.templateId, fromEmail: node.fromEmail };
}

interface ClaimedFlowSend extends FlowSendPrereqs {
  sendId: string;
  to: string;
  dynamicTemplateData: Record<string, unknown>;
  unsubscribeUrl: string;
}

export type FlowClaimResult =
  | { kind: "proceed"; claim: ClaimedFlowSend }
  | { kind: "excluded"; reason: string }
  | { kind: "skipped" }
  | { kind: "failed"; sendId: string };

/**
 * Flow-shaped sibling of send-dispatch.ts's `claimCampaignSend` -- unit 1 of
 * the three-unit dispatch discipline (claim / external call / record).
 * Resolves prereqs, re-evaluates the SAME `evaluatePreSendGate` gate every
 * other send source uses (D-05: no second subscription check anywhere in
 * the flow path -- a contact re-subscribed mid-flow has its NEXT dispatch
 * go out normally), and commits the idempotent claim via
 * `@mega-crm/delivery-core`'s `claimFlowSend` -- all inside the ONE
 * transaction the caller wraps this call in, BEFORE any SendGrid call.
 */
export async function claimFlowSend(
  client: PoolClient,
  params: { workspaceId: string; flowRunId: string; nodeId: string; contactId: string }
): Promise<FlowClaimResult> {
  const { workspaceId, flowRunId, nodeId, contactId } = params;
  const prereqs = await readFlowSendPrereqs(client, workspaceId, flowRunId, nodeId);

  const { rows: contactRows } = await client.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = $1 AND workspace_id = $2`,
    [contactId, workspaceId]
  );
  const contact = contactRows[0];
  if (!contact) {
    throw new Error(`Contact ${contactId} not found in workspace ${workspaceId}`);
  }

  const gateDecision = await evaluatePreSendGate(client, { workspaceId, contact });
  if (!gateDecision.sendable) {
    await recordFlowExcluded(client, { workspaceId, flowRunId, nodeId, contactId }, gateDecision.reason);
    return { kind: "excluded", reason: gateDecision.reason };
  }

  const dispatchResult: DispatchSendGateResult = await claimFlowSendLedger(client, {
    workspaceId,
    flowRunId,
    nodeId,
    contactId,
  });
  if (dispatchResult === "skipped") {
    // SEND-06 sibling: a redelivered job for an already-terminal row never
    // reaches this far again -- no second SendGrid call, no second row.
    return { kind: "skipped" };
  }

  if (dispatchResult.interrupted) {
    // CR-04 sibling: a PRIOR attempt already committed this claim and never
    // finished -- never re-call SendGrid for it; record it as failed.
    await recordFlowStepResult(client, dispatchResult.sendId, { status: "failed" });
    return { kind: "failed", sendId: dispatchResult.sendId };
  }

  const sendId = dispatchResult.sendId;
  const to = contact.email as string; // evaluatePreSendGate already proved email is present (no_email otherwise)
  const unsubscribeUrl = buildListUnsubscribeUrl(
    signUnsubscribeToken({
      sendId,
      contactId,
      workspaceId,
      exp: Math.floor(Date.now() / 1000) + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
    })
  );
  const dynamicTemplateData = buildContactTemplateData(contact, { unsubscribeUrl }) as unknown as Record<
    string,
    unknown
  >;

  return { kind: "proceed", claim: { ...prereqs, sendId, to, dynamicTemplateData, unsubscribeUrl } };
}
