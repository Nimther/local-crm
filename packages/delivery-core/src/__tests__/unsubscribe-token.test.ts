import { beforeAll, describe, expect, it } from "vitest";
import {
  buildListUnsubscribeUrl,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../unsubscribe-token.js";
import { buildContactTemplateData } from "../contact-template-data.js";

beforeAll(() => {
  process.env.UNSUBSCRIBE_TOKEN_SECRET = "test-only-secret-at-least-32-bytes-long-000";
  process.env.PUBLIC_APP_URL = "https://api.example.com";
});

function samplePayload() {
  return {
    sendId: "11111111-1111-1111-1111-111111111111",
    contactId: "22222222-2222-2222-2222-222222222222",
    workspaceId: "33333333-3333-3333-3333-333333333333",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("signUnsubscribeToken / verifyUnsubscribeToken (SUBS-04, T-04-03-01)", () => {
  it("round-trips a valid token to the exact original payload", () => {
    const payload = samplePayload();
    const token = signUnsubscribeToken(payload);
    expect(verifyUnsubscribeToken(token)).toEqual(payload);
  });

  it("returns null when the payload bytes are altered (tampered payload -> HMAC mismatch)", () => {
    const payload = samplePayload();
    const token = signUnsubscribeToken(payload);
    const [, signature] = token.split(".");

    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payload, contactId: "44444444-4444-4444-4444-444444444444" })
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${signature}`;

    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("returns null when the signature itself is altered", () => {
    const payload = samplePayload();
    const token = signUnsubscribeToken(payload);
    const [encodedPayload] = token.split(".");
    const forgedSignature = Buffer.from("not-the-real-signature").toString("base64url");

    expect(verifyUnsubscribeToken(`${encodedPayload}.${forgedSignature}`)).toBeNull();
  });

  it("returns null for a structurally malformed token", () => {
    expect(verifyUnsubscribeToken("not-a-real-token")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("only.one.dot.too.many")).toBeNull();
  });

  it("buildListUnsubscribeUrl composes PUBLIC_APP_URL + /unsubscribe/:token", () => {
    expect(buildListUnsubscribeUrl("abc.def")).toBe("https://api.example.com/unsubscribe/abc.def");
  });
});

describe("buildContactTemplateData (D-18 v1 contact-profile contract)", () => {
  it("returns exactly the documented snake_case key set for a contact with custom properties and an unsubscribeUrl", () => {
    const contact = {
      firstName: "Ада",
      lastName: "Лавлейс",
      email: "ada@example.com",
      phone: "+15550000000",
      city: "London",
      country: "UK",
      tags: ["vip", "beta"],
      properties: { favorite_color: "blue", plan: "pro" },
    };

    const result = buildContactTemplateData(contact, {
      unsubscribeUrl: "https://api.example.com/unsubscribe/xyz",
    });

    expect(Object.keys(result).sort()).toEqual(
      [
        "city",
        "country",
        "email",
        "first_name",
        "last_name",
        "phone",
        "properties",
        "tags",
        "unsubscribe_url",
      ].sort()
    );
    expect(result).toEqual({
      first_name: "Ада",
      last_name: "Лавлейс",
      email: "ada@example.com",
      phone: "+15550000000",
      city: "London",
      country: "UK",
      tags: ["vip", "beta"],
      properties: { favorite_color: "blue", plan: "pro" },
      unsubscribe_url: "https://api.example.com/unsubscribe/xyz",
    });
  });

  it("passes null standard fields through as null and omits unsubscribe_url when not provided", () => {
    const contact = {
      firstName: null,
      lastName: null,
      email: "no-name@example.com",
      phone: null,
      city: null,
      country: null,
      tags: [],
      properties: {},
    };

    const result = buildContactTemplateData(contact);

    expect(result.first_name).toBeNull();
    expect(result.last_name).toBeNull();
    expect(result).not.toHaveProperty("unsubscribe_url");
  });

  it("never leaks a reserved column (subscription_status/workspace_id/id) into the payload", () => {
    const contact = {
      firstName: "Test",
      lastName: null,
      email: "test@example.com",
      phone: null,
      city: null,
      country: null,
      tags: [],
      properties: {},
    };

    const result = buildContactTemplateData(contact) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty("subscription_status");
    expect(result).not.toHaveProperty("workspace_id");
    expect(result).not.toHaveProperty("id");
  });
});
