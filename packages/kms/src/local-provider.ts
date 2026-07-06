import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env.js";

/**
 * Dev-only static-KEK provider (RESEARCH.md Pattern 3 / Pitfall 3 / Open
 * Question 2). Mirrors the shape of the AWS provider (`generateDataKey` /
 * `decryptDataKey`) so client.ts can dispatch on `KMS_PROVIDER` without
 * caring which one is active.
 *
 * Redundant safety net: apps/api's env.ts schema-level `superRefine` is the
 * primary "refuse to boot" guard (fires before the server even starts
 * listening, regardless of whether this module is ever imported). This
 * module-level check additionally guards the case where something (apps/api
 * OR apps/worker) imports this module directly while NODE_ENV=production,
 * independent of KMS_PROVIDER.
 */
if (env.NODE_ENV === "production") {
  throw new Error(
    "@mega-crm/kms's local-provider.ts must never be imported when NODE_ENV=production (RESEARCH.md Pitfall 3) -- set KMS_PROVIDER=aws and KMS_KEK_ID instead."
  );
}

function getLocalKek(): Buffer {
  const raw = env.KMS_LOCAL_KEK;
  if (!raw) {
    throw new Error(
      "KMS_LOCAL_KEK must be set when KMS_PROVIDER=local (dev only: `openssl rand -base64 32`)"
    );
  }
  const kek = Buffer.from(raw, "base64");
  if (kek.length !== 32) {
    throw new Error("KMS_LOCAL_KEK must decode to exactly 32 bytes (base64 output of `openssl rand -base64 32`)");
  }
  return kek;
}

/**
 * Dev-only analog of KMS `GenerateDataKey`: generates a fresh 32-byte DEK
 * and wraps ("encrypts") it with the static local KEK via aes-256-gcm,
 * using `workspaceId` as AAD -- mirroring the AWS provider's
 * `EncryptionContext` binding, so a wrapped DEK can only be unwrapped under
 * the same workspaceId it was created for.
 */
export function generateDataKey(workspaceId: string): { plaintextDek: Buffer; wrappedDek: string } {
  const kek = getLocalKek();
  const plaintextDek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(Buffer.from(workspaceId, "utf8"));
  const wrapped = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, wrapped]).toString("base64");
  return { plaintextDek, wrappedDek: packed };
}

/** Dev-only analog of KMS `Decrypt`: unwraps a DEK produced by `generateDataKey` above. */
export function decryptDataKey(workspaceId: string, wrappedDek: string): Buffer {
  const kek = getLocalKek();
  const packed = Buffer.from(wrappedDek, "base64");
  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 28);
  const wrapped = packed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAAD(Buffer.from(workspaceId, "utf8"));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(wrapped), decipher.final()]);
}
