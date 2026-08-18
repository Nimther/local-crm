import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { env } from "./env.js";

/**
 * Real AWS KMS envelope-encryption provider (RESEARCH.md Pattern 3), used
 * when KMS_PROVIDER=aws. `EncryptionContext: { workspaceId }` binds the
 * wrapped DEK to the workspace it was generated for -- KMS refuses to
 * decrypt if the caller doesn't supply the same context, so a wrapped DEK
 * copied across workspace rows (e.g. by a bug or an attacker with DB
 * access) cannot be unwrapped under a different workspaceId.
 */
const kms = new KMSClient({});

function requireKekId(): string {
  if (!env.KMS_KEK_ID) {
    throw new Error("KMS_KEK_ID must be set when KMS_PROVIDER=aws");
  }
  return env.KMS_KEK_ID;
}

/** Configuration-only readiness; no data key is generated during boot. */
export function assertReady(): void {
  requireKekId();
}

export async function generateDataKey(
  workspaceId: string
): Promise<{ plaintextDek: Buffer; wrappedDek: string }> {
  const { Plaintext, CiphertextBlob } = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: requireKekId(),
      KeySpec: "AES_256",
      EncryptionContext: { workspaceId },
    })
  );
  if (!Plaintext || !CiphertextBlob) {
    throw new Error("KMS GenerateDataKey returned no key material");
  }
  return {
    plaintextDek: Buffer.from(Plaintext),
    wrappedDek: Buffer.from(CiphertextBlob).toString("base64"),
  };
}

export async function decryptDataKey(workspaceId: string, wrappedDek: string): Promise<Buffer> {
  const { Plaintext } = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(wrappedDek, "base64"),
      KeyId: requireKekId(),
      EncryptionContext: { workspaceId },
    })
  );
  if (!Plaintext) {
    throw new Error("KMS Decrypt returned no key material");
  }
  return Buffer.from(Plaintext);
}
