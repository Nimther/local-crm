import { describe, expect, it } from "vitest";
import { resolveSuppression, ADDRESS_DROP_REASONS, SOFT_BOUNCE_SUPPRESS_THRESHOLD } from "../suppression-rules.js";

describe("resolveSuppression (SUBS-02, D-10/D-11/D-12)", () => {
  it("hard bounce -> suppressed(hard_bounce)", () => {
    expect(resolveSuppression("bounce_hard", null)).toEqual({ status: "suppressed", reason: "hard_bounce" });
  });

  it("spam_report -> suppressed(spam_report)", () => {
    expect(resolveSuppression("spam_report", null)).toEqual({ status: "suppressed", reason: "spam_report" });
  });

  it("unsubscribe -> unsubscribed(unsubscribe)", () => {
    expect(resolveSuppression("unsubscribe", null)).toEqual({ status: "unsubscribed", reason: "unsubscribe" });
  });

  it("group_unsubscribe -> unsubscribed(unsubscribe)", () => {
    expect(resolveSuppression("group_unsubscribe", null)).toEqual({ status: "unsubscribed", reason: "unsubscribe" });
  });

  it("dropped with an address-validity reason maps to the matching suppressed reason (D-12)", () => {
    expect(resolveSuppression("dropped", "Bounced Address")).toEqual({
      status: "suppressed",
      reason: "dropped_bounced_address",
    });
    expect(resolveSuppression("dropped", "Spam Reporting Address")).toEqual({
      status: "suppressed",
      reason: "dropped_spam_reporting_address",
    });
    expect(resolveSuppression("dropped", "Invalid Address")).toEqual({
      status: "suppressed",
      reason: "dropped_invalid_address",
    });
  });

  it("dropped with Unsubscribed Address maps to unsubscribed (D-12)", () => {
    expect(resolveSuppression("dropped", "Unsubscribed Address")).toEqual({
      status: "unsubscribed",
      reason: "dropped_unsubscribed_address",
    });
  });

  it("dropped with a technical/unknown reason maps to null (no status change, D-12)", () => {
    expect(resolveSuppression("dropped", "Invalid SMTPAPI header")).toBeNull();
    expect(resolveSuppression("dropped", "Spam Content")).toBeNull();
    expect(resolveSuppression("dropped", "Recipient List over Package Quota")).toBeNull();
    expect(resolveSuppression("dropped", "some-unmapped-reason")).toBeNull();
  });

  it("dropped with no reason maps to null", () => {
    expect(resolveSuppression("dropped", null)).toBeNull();
  });

  it("bounce_soft always returns null (streak handled by the 05-03 worker, not here)", () => {
    expect(resolveSuppression("bounce_soft", null)).toBeNull();
    expect(resolveSuppression("bounce_soft", "anything")).toBeNull();
  });

  it("delivered/open/click never trigger a suppression outcome", () => {
    expect(resolveSuppression("delivered", null)).toBeNull();
    expect(resolveSuppression("open", null)).toBeNull();
    expect(resolveSuppression("click", null)).toBeNull();
  });

  it("ADDRESS_DROP_REASONS exposes exactly the 4 address-validity reasons", () => {
    expect(Object.keys(ADDRESS_DROP_REASONS).sort()).toEqual(
      ["Bounced Address", "Invalid Address", "Spam Reporting Address", "Unsubscribed Address"].sort()
    );
  });

  it("SOFT_BOUNCE_SUPPRESS_THRESHOLD is the D-10 platform constant N=3", () => {
    expect(SOFT_BOUNCE_SUPPRESS_THRESHOLD).toBe(3);
  });
});
