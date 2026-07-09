import { describe, expect, it } from "vitest";
import {
  WEBHOOK_CAP_REACHED_WARNING,
  WEBHOOK_INSECURE_URL_WARNING,
  WEBHOOK_MISSING_SCOPE_WARNING,
  WEBHOOK_PROVISION_FAILED_WARNING,
  webhookWarningFor,
} from "../webhook-warning-copy.js";

/**
 * webhookWarningFor (05-12 gap-closure): the insecure_url reason is new;
 * the other three reasons are a regression guard so the new
 * ProvisionEventWebhookError-typed signature never silently drops a
 * pre-existing mapping.
 */
describe("webhookWarningFor", () => {
  it("maps 'insecure_url' to WEBHOOK_INSECURE_URL_WARNING", () => {
    expect(webhookWarningFor("insecure_url")).toBe(WEBHOOK_INSECURE_URL_WARNING);
  });

  it("WEBHOOK_INSECURE_URL_WARNING names PUBLIC_APP_URL, https, and the runbook", () => {
    expect(WEBHOOK_INSECURE_URL_WARNING).toContain("PUBLIC_APP_URL");
    expect(WEBHOOK_INSECURE_URL_WARNING).toContain("https");
    expect(WEBHOOK_INSECURE_URL_WARNING).toContain("docs/webhook-live-uat.md");
  });

  it("regression: the three pre-existing reasons still map to their constants", () => {
    expect(webhookWarningFor("missing_scope")).toBe(WEBHOOK_MISSING_SCOPE_WARNING);
    expect(webhookWarningFor("cap_reached")).toBe(WEBHOOK_CAP_REACHED_WARNING);
    expect(webhookWarningFor("failed")).toBe(WEBHOOK_PROVISION_FAILED_WARNING);
  });
});
