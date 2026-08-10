import type { Job } from "bullmq";

/**
 * RED stub -- TDD scaffold only, not the real implementation. Exists so
 * `tenant-deferral.test.ts` compiles and its assertions fail for the right
 * reason (behavior not yet implemented) rather than a module-resolution
 * error. Task 1's GREEN step replaces this file's body.
 */
export const TENANT_DEFERRAL_MIN_DELAY_MS = 250;

// eslint-disable-next-line @typescript-eslint/require-await -- RED stub, no real await yet
export async function deferForTenantBucket(_job: Job, _rateLimitMs: number, _token: string | undefined): Promise<never> {
  throw new Error("deferForTenantBucket: not implemented (RED stub)");
}
