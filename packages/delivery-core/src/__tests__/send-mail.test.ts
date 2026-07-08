import { describe, expect, it } from "vitest";
import { buildMailSendRequest } from "../send-mail.js";

function sampleParams(overrides: Partial<Parameters<typeof buildMailSendRequest>[0]> = {}) {
  return {
    to: "contact@example.com",
    templateId: "d-1234567890",
    fromEmail: "marketing@tenant.example.com",
    dynamicTemplateData: { first_name: "Ada" },
    listUnsubscribeUrl: "https://api.example.com/unsubscribe/abc.def",
    sendId: "11111111-1111-1111-1111-111111111111",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    campaignId: "33333333-3333-3333-3333-333333333333",
    ...overrides,
  };
}

describe("buildMailSendRequest (D-04 forced tracking, D-15 test marker)", () => {
  it("forces open_tracking and click_tracking on alongside the existing subscription_tracking:false", () => {
    const result = buildMailSendRequest(sampleParams());
    expect(result.tracking_settings).toEqual({
      subscription_tracking: { enable: false },
      open_tracking: { enable: true },
      click_tracking: { enable: true },
    });
  });

  it("a campaign build (isTest omitted) has NO test custom_arg", () => {
    const result = buildMailSendRequest(sampleParams());
    const customArgs = result.personalizations[0].custom_args;
    expect(customArgs).not.toHaveProperty("test");
  });

  it("a campaign build (isTest: false) has NO test custom_arg", () => {
    const result = buildMailSendRequest(sampleParams({ isTest: false }));
    const customArgs = result.personalizations[0].custom_args;
    expect(customArgs).not.toHaveProperty("test");
  });

  it("a test build (isTest: true) has custom_args.test === 'true'", () => {
    const result = buildMailSendRequest(sampleParams({ isTest: true }));
    const customArgs = result.personalizations[0].custom_args;
    expect(customArgs.test).toBe("true");
  });

  it("send_id/workspace_id/campaign_id remain present in both campaign and test builds", () => {
    const campaignResult = buildMailSendRequest(sampleParams());
    const testResult = buildMailSendRequest(sampleParams({ isTest: true }));

    for (const result of [campaignResult, testResult]) {
      expect(result.personalizations[0].custom_args).toMatchObject({
        send_id: "11111111-1111-1111-1111-111111111111",
        workspace_id: "22222222-2222-2222-2222-222222222222",
        campaign_id: "33333333-3333-3333-3333-333333333333",
      });
    }
  });
});
