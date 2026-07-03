import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * KMS envelope encryption (TENANT-04, RESEARCH.md Pattern 3 / Pitfall 3).
 * Runs against the `local` provider (KMS_PROVIDER=local, KMS_LOCAL_KEK set
 * in vitest.config.ts's test.env) -- the AWS provider itself is not
 * exercised here (no live/mocked AWS KMS in this phase's test suite), only
 * the shared client.ts envelope contract and the local provider's
 * production-boot guard.
 */
describe("KMS envelope encryption (client.ts, local provider)", () => {
  it("round-trips a secret: decrypt(encrypt(secret)) === secret", async () => {
    const { encryptTenantSecret, decryptTenantSecret } = await import("../client.js");
    const secret = "SG.aVeryRealSendGridApiKeyForTesting1234567890";

    const encrypted = await encryptTenantSecret("workspace-1", secret);
    expect(encrypted.ciphertext).not.toBe(secret);
    expect(encrypted.ciphertext).not.toContain(secret);
    expect(Buffer.from(encrypted.ciphertext, "base64").toString("utf8")).not.toContain(secret);

    const decrypted = await decryptTenantSecret("workspace-1", encrypted);
    expect(decrypted).toBe(secret);
  });

  it("never exposes the plaintext DEK to the caller -- only wrapped/encrypted fields are returned", async () => {
    const { encryptTenantSecret } = await import("../client.js");
    const encrypted = await encryptTenantSecret("workspace-1", "SG.another-key-0000000000000000");

    expect(encrypted).not.toHaveProperty("plaintextDek");
    expect(encrypted).not.toHaveProperty("dek");
    expect(Object.keys(encrypted).sort()).toEqual(["authTag", "ciphertext", "encryptedDek", "iv"].sort());
  });

  it("zeroes the plaintext DEK buffer immediately after use", async () => {
    const { encryptTenantSecret } = await import("../client.js");
    const fillSpy = vi.spyOn(Buffer.prototype, "fill");

    await encryptTenantSecret("workspace-1", "SG.zeroing-check-key-0000000000");

    expect(fillSpy).toHaveBeenCalledWith(0);
    fillSpy.mockRestore();
  });

  it("binds encryption to the workspaceId: decrypting under a different workspaceId fails", async () => {
    const { encryptTenantSecret, decryptTenantSecret } = await import("../client.js");
    const encrypted = await encryptTenantSecret("workspace-A", "SG.bound-key-0000000000000000000");

    await expect(decryptTenantSecret("workspace-B", encrypted)).rejects.toThrow();
  });
});

describe("local KMS provider production-boot guard (Pitfall 3)", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_KMS_PROVIDER = process.env.KMS_PROVIDER;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.KMS_PROVIDER = ORIGINAL_KMS_PROVIDER;
    vi.resetModules();
  });

  it("refuses to boot (throws at import time) when NODE_ENV=production and KMS_PROVIDER=local", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.KMS_PROVIDER = "local";

    await expect(import("../local-provider.js")).rejects.toThrow(/production/i);
  });
});
