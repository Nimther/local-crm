import { describe, expect, it, vi } from "vitest";

import { decryptTenantSecret, encryptTenantSecret, type EncryptedSecret } from "../index.js";

/**
 * 08-16 (QG-03) — envelope encryption of tenant secrets.
 *
 * Every tenant's SendGrid API key passes through this code. It has been
 * executed constantly by apps/api's tests since Phase 4, and until now nothing
 * asserted what it actually guarantees — the round-trip, the non-determinism,
 * or that a tampered payload is rejected rather than quietly returning wrong
 * bytes.
 *
 * No database and no live KMS. The local provider is a static-KEK dev path,
 * which is what makes this package unit-testable at all; the AWS provider
 * mirrors its shape and is dispatched to by KMS_PROVIDER.
 */

const WORKSPACE_A = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_B = "22222222-2222-2222-2222-222222222222";
const SECRET = "SG.a_tenants_real_looking_sendgrid_key_0000000000";

/** Flip one base64 payload byte, keeping the field well-formed. */
function corrupt(base64: string): string {
  const buf = Buffer.from(base64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
}

describe("envelope encryption — the round trip", () => {
  it("returns the original plaintext exactly", async () => {
    const sealed = await encryptTenantSecret(WORKSPACE_A, SECRET);
    expect(await decryptTenantSecret(WORKSPACE_A, sealed)).toBe(SECRET);
  });

  it("never returns the data key to the caller — only the wrapped one", async () => {
    const sealed = await encryptTenantSecret(WORKSPACE_A, SECRET);
    expect(Object.keys(sealed).sort()).toEqual(["authTag", "ciphertext", "encryptedDek", "iv"]);
    // The plaintext must not be recoverable from the envelope without the KEK.
    expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toContain("SG.");
  });
});

describe("envelope encryption — non-determinism", () => {
  it("produces different ciphertext, IV and wrapped key for the same input", async () => {
    const first = await encryptTenantSecret(WORKSPACE_A, SECRET);
    const second = await encryptTenantSecret(WORKSPACE_A, SECRET);

    // A deterministic scheme would leak that two tenants hold the same key, and
    // would make a stored ciphertext a stable identifier for its plaintext.
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(second.iv).not.toBe(first.iv);
    expect(second.encryptedDek).not.toBe(first.encryptedDek);

    // Both still decrypt.
    expect(await decryptTenantSecret(WORKSPACE_A, first)).toBe(SECRET);
    expect(await decryptTenantSecret(WORKSPACE_A, second)).toBe(SECRET);
  });
});

describe("envelope encryption — tampering is rejected, not tolerated", () => {
  it("rejects a modified authentication tag", async () => {
    const sealed = await encryptTenantSecret(WORKSPACE_A, SECRET);
    const tampered: EncryptedSecret = { ...sealed, authTag: corrupt(sealed.authTag) };

    // GCM must fail the integrity check. Returning wrong plaintext instead
    // would mean a modified stored secret reaching SendGrid as a live API key.
    await expect(decryptTenantSecret(WORKSPACE_A, tampered)).rejects.toThrow();
  });

  it("rejects modified ciphertext", async () => {
    const sealed = await encryptTenantSecret(WORKSPACE_A, SECRET);
    const tampered: EncryptedSecret = { ...sealed, ciphertext: corrupt(sealed.ciphertext) };
    await expect(decryptTenantSecret(WORKSPACE_A, tampered)).rejects.toThrow();
  });

  it("rejects a modified wrapped data key", async () => {
    const sealed = await encryptTenantSecret(WORKSPACE_A, SECRET);
    const tampered: EncryptedSecret = { ...sealed, encryptedDek: corrupt(sealed.encryptedDek) };
    await expect(decryptTenantSecret(WORKSPACE_A, tampered)).rejects.toThrow();
  });
});

describe("envelope encryption — tenant binding", () => {
  it("refuses to decrypt one workspace's payload under another's identity", async () => {
    const sealed = await encryptTenantSecret(WORKSPACE_A, SECRET);

    // The workspace id is the AAD on the DEK wrap (local-provider.ts), mirroring
    // the AWS provider's EncryptionContext. So the binding is real: possessing
    // the KEK and another tenant's stored row is not enough.
    await expect(decryptTenantSecret(WORKSPACE_B, sealed)).rejects.toThrow();
  });
});

describe("local provider — key material is required, not optional", () => {
  it("refuses to operate when the KEK is absent", async () => {
    vi.resetModules();
    const previous = process.env.KMS_LOCAL_KEK;
    delete process.env.KMS_LOCAL_KEK;
    try {
      const provider = await import("../local-provider.js");
      expect(() => provider.generateDataKey(WORKSPACE_A)).toThrow(/KMS_LOCAL_KEK/);
    } finally {
      process.env.KMS_LOCAL_KEK = previous;
      vi.resetModules();
    }
  });

  it("refuses a KEK that does not decode to 32 bytes", async () => {
    vi.resetModules();
    const previous = process.env.KMS_LOCAL_KEK;
    process.env.KMS_LOCAL_KEK = Buffer.from("too-short").toString("base64");
    try {
      const provider = await import("../local-provider.js");
      // Silently accepting a short key would hand aes-256-gcm the wrong key
      // length and fail somewhere far less legible.
      expect(() => provider.generateDataKey(WORKSPACE_A)).toThrow(/32 bytes/);
    } finally {
      process.env.KMS_LOCAL_KEK = previous;
      vi.resetModules();
    }
  });

  it("refuses to load at all under NODE_ENV=production", async () => {
    vi.resetModules();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(import("../local-provider.js")).rejects.toThrow(/never be imported/);
    } finally {
      process.env.NODE_ENV = previous;
      vi.resetModules();
    }
  });
});
