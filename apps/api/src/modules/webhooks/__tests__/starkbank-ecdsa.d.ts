/**
 * Minimal ambient typing for `starkbank-ecdsa` (test-only devDependency,
 * SPECIFICATION.md §2.2) -- the transitive ECDSA library
 * `@sendgrid/eventwebhook` itself uses to verify signatures
 * (`signature-verify.ts`). `@sendgrid/eventwebhook` only exposes
 * verification, not signing, so `webhook-timestamp-window.test.ts` imports
 * this library directly to generate a self-consistent test key pair and
 * sign fixture payloads at arbitrary, test-controlled timestamps -- the
 * fixed SendGrid-published fixture used by `webhooks-signature.test.ts`
 * cannot exercise a time-varying boundary/replay window. `starkbank-ecdsa`
 * ships no type declarations of its own; this covers only the small
 * surface this test file actually calls.
 */
declare module "starkbank-ecdsa" {
  export class PublicKey {
    toPem(): string;
  }

  export class PrivateKey {
    constructor();
    publicKey(): PublicKey;
  }

  export class Signature {
    toBase64(withRecoveryId?: boolean): string;
  }

  export const Ecdsa: {
    sign(message: string, privateKey: PrivateKey, hashfunc?: string): Signature;
  };
}
