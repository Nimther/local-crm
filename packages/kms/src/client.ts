import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env.js";

export interface EncryptedSecret {
  encryptedDek: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

interface KmsProvider {
  generateDataKey(workspaceId: string): Promise<{ plaintextDek: Buffer; wrappedDek: string }> | {
    plaintextDek: Buffer;
    wrappedDek: string;
  };
  decryptDataKey(workspaceId: string, wrappedDek: string): Promise<Buffer> | Buffer;
}

/**
 * Provider-agnostic envelope-encryption client (RESEARCH.md Pattern 3 / Open
 * Question 1): dispatches on `KMS_PROVIDER` behind a small internal
 * interface, dynamically importing only the active provider module so the
 * `aws-provider.ts` (real @aws-sdk/client-kms) never needs to be reachable
 * in local dev, and `local-provider.ts` (dev-only static KEK, refuses to
 * boot under NODE_ENV=production) is never loaded in a `KMS_PROVIDER=aws`
 * production deploy.
 *
 * Lives in the shared `@mega-crm/kms` package (04-02) so apps/worker -- a
 * separate process with no source import path into apps/api -- can decrypt
 * a tenant's SendGrid key at send-dispatch time (SEND-05), not just apps/api.
 */
async function loadProvider(): Promise<KmsProvider> {
  if (env.KMS_PROVIDER === "aws") {
    return import("./aws-provider.js");
  }
  return import("./local-provider.js");
}

/**
 * Envelope-encrypts `plaintext` (a tenant's SendGrid API key) for
 * `workspaceId`: generates a fresh DEK via the active KMS provider,
 * encrypts the plaintext with it (aes-256-gcm), then immediately zeroes the
 * plaintext DEK buffer -- it never leaves this function and is never
 * returned to the caller (only the wrapped/encrypted DEK is).
 */
export async function encryptTenantSecret(workspaceId: string, plaintext: string): Promise<EncryptedSecret> {
  const provider = await loadProvider();
  const { plaintextDek, wrappedDek } = await provider.generateDataKey(workspaceId);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", plaintextDek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      encryptedDek: wrappedDek,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
    };
  } finally {
    plaintextDek.fill(0);
  }
}

/** Reverses `encryptTenantSecret`: unwraps the DEK via the active KMS provider, then decrypts the ciphertext. */
export async function decryptTenantSecret(workspaceId: string, secret: EncryptedSecret): Promise<string> {
  const provider = await loadProvider();
  const plaintextDek = await provider.decryptDataKey(workspaceId, secret.encryptedDek);
  try {
    const decipher = createDecipheriv("aes-256-gcm", plaintextDek, Buffer.from(secret.iv, "base64"));
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } finally {
    plaintextDek.fill(0);
  }
}
