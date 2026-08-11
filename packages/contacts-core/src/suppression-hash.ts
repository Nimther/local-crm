import { createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { decryptTenantSecret, encryptTenantSecret } from "@mega-crm/kms";

/**
 * CMP-04 (D-02, plan 13-12): the normalize-then-HMAC path that replaces the
 * plaintext `workspace_suppressions.email` column with a per-workspace hash.
 * Pure module -- no database, no network -- mirroring
 * `packages/delivery-core/src/event-normalize.ts`'s convention, so the
 * identity rule (`normalizeSuppressionEmail` -> `hashSuppressionEmail`) is
 * fully unit-testable and cannot be applied inconsistently at different call
 * sites.
 *
 * The key-lifecycle functions below (`ensureWorkspaceSuppressionKey`,
 * `loadWorkspaceSuppressionKey`) are the one place this module touches the
 * database and `@mega-crm/kms` -- everything else in this file is pure.
 */

/**
 * Lowercases and trims -- nothing more. Deliberately does NOT apply
 * provider-specific aliasing (Gmail-style dots or plus-tags): those are
 * aliasing conventions the sending provider chooses to honor, not identity
 * rules this platform gets to assume on a tenant's behalf. Applying them
 * would suppress addresses the tenant never asked to suppress; the
 * conservative direction is to under-normalize, not over-normalize.
 *
 * This MUST stay in agreement with however `contacts.email` itself is
 * normalized on create/update (today: not normalized at all beyond what the
 * caller supplies) -- a mismatch would mean the same person could be
 * suppressed under one letter-case/whitespace form and re-created under
 * another, silently defeating the re-import protection this table exists
 * for. `hashSuppressionEmail` below takes the ALREADY-normalized string for
 * exactly this reason: normalization cannot be accidentally skipped at one
 * call site and applied at another when it happens in one place, before
 * hashing, every time.
 */
export function normalizeSuppressionEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * HMAC-SHA256 via `node:crypto`, exactly as `packages/kms/src/client.ts`
 * uses `createCipheriv` from the same module -- never a hand-rolled hashing
 * construction. Returns a fixed-length hex digest (64 hex characters)
 * regardless of input length, so the stored column shape never varies with
 * the address's length.
 *
 * Takes the ALREADY-normalized email (see `normalizeSuppressionEmail`'s own
 * comment) and the raw key material buffer -- never the wrapped/encrypted
 * form. Every call site loads the key via `loadWorkspaceSuppressionKey` or
 * `ensureWorkspaceSuppressionKey` first.
 */
export function hashSuppressionEmail(normalizedEmail: string, keyMaterial: Buffer): string {
  return createHmac("sha256", keyMaterial).update(normalizedEmail, "utf8").digest("hex");
}

/**
 * How long an unwrapped key stays cached in process before the next read
 * re-unwraps it. Chosen as a middle ground rather than measured under the
 * AWS KMS provider (RESEARCH.md assumption A2, still outstanding -- the
 * local provider used in dev/test has no network round trip, so this risk
 * only surfaces in an AWS-backed environment): long enough that a single
 * broadcast's worth of suppression checks for one workspace shares one
 * unwrap rather than paying a KMS round trip per candidate recipient (the
 * hazard T-13-12-05 exists to close), short enough that revoking/rotating a
 * workspace's key takes effect within a bounded, human-legible window
 * rather than staying live indefinitely in a long-lived worker process.
 */
export const SUPPRESSION_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  key: Buffer;
  expiresAt: number;
}

/**
 * In-process only -- never persisted to disk, Redis, or a log (T-13-12-04).
 * Keyed by workspace id so one workspace's key never leaks into another's
 * lookup. `Buffer` values are zeroed with `.fill(0)` when evicted (TTL
 * expiry or explicit clear) rather than simply dropped, so a lingering
 * reference elsewhere in the process cannot outlive the cache's own
 * lifetime with live key bytes.
 */
const keyCache = new Map<string, CacheEntry>();

function cacheGet(workspaceId: string): Buffer | undefined {
  const entry = keyCache.get(workspaceId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entry.key.fill(0);
    keyCache.delete(workspaceId);
    return undefined;
  }
  return entry.key;
}

function cacheSet(workspaceId: string, key: Buffer): void {
  const existing = keyCache.get(workspaceId);
  if (existing && existing.key !== key) {
    existing.key.fill(0);
  }
  keyCache.set(workspaceId, { key, expiresAt: Date.now() + SUPPRESSION_KEY_CACHE_TTL_MS });
}

/**
 * Test-only (and process-shutdown) cache reset. Zeroes every cached buffer
 * before dropping the map, mirroring the eviction discipline above --
 * clearing the cache must never simply orphan live key bytes for the
 * garbage collector to find whenever it gets around to it.
 */
export function clearSuppressionKeyCache(): void {
  for (const entry of keyCache.values()) {
    entry.key.fill(0);
  }
  keyCache.clear();
}

interface WrappedKeyRow {
  encryptedDek: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

async function readWrappedKeyRow(client: PoolClient, workspaceId: string): Promise<WrappedKeyRow | null> {
  const { rows } = await client.query<WrappedKeyRow>(
    `SELECT encrypted_dek as "encryptedDek", ciphertext, iv, auth_tag as "authTag"
     FROM workspace_suppression_keys WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0] ?? null;
}

/**
 * Returns the workspace's unwrapped suppression key, or `null` if the
 * workspace has never suppressed anything -- NEVER creates a row. This is
 * the read path every pre-send/pre-create suppression check goes through:
 * `isEmailSuppressed` short-circuits to `false` on a `null` return without
 * performing any further work, so a workspace with a clean list pays zero
 * KMS cost (the absence of a key row IS the answer, not a missing
 * precondition to fill in).
 *
 * Serves from the in-process TTL cache when available; otherwise reads the
 * wrapped row and unwraps it via `@mega-crm/kms`'s `decryptTenantSecret`
 * (the SAME envelope-encryption path tenant SendGrid keys use), then caches
 * the result.
 */
export async function loadWorkspaceSuppressionKey(client: PoolClient, workspaceId: string): Promise<Buffer | null> {
  const cached = cacheGet(workspaceId);
  if (cached) return cached;

  const row = await readWrappedKeyRow(client, workspaceId);
  if (!row) return null;

  const plaintextBase64 = await decryptTenantSecret(workspaceId, row);
  const key = Buffer.from(plaintextBase64, "base64");
  cacheSet(workspaceId, key);
  return key;
}

/**
 * Get-or-create: returns the existing key for a workspace if one is already
 * stored, otherwise generates a fresh 32-byte key, wraps it through
 * `@mega-crm/kms`'s envelope-encryption path (exactly as tenant SendGrid
 * keys are wrapped -- never a re-derived KMS integration), and stores only
 * the wrapped form. Never rotates a key that already exists.
 *
 * This is the ONE path that legitimately creates a
 * `workspace_suppression_keys` row -- called only from the two write sites
 * that suppress an address for the first time in a workspace (`deleteContact`,
 * `applySuppression`) and from the operator-invoked backfill script. The
 * read-only `isEmailSuppressed` path never calls this.
 *
 * The freshly-generated plaintext key buffer is zeroed in a `finally` block
 * immediately after being handed to `encryptTenantSecret` -- copying the
 * `plaintextDek.fill(0)` discipline `packages/kms/src/client.ts` already
 * applies to the KMS-internal DEK, for this key too -- in every path,
 * including the error path. The value this function returns is re-read from
 * the database afterward (via `loadWorkspaceSuppressionKey`), never the
 * zeroed local buffer, which also resolves a race cleanly: `ON CONFLICT DO
 * NOTHING` means a concurrent caller that inserted first simply "wins", and
 * the re-read returns whichever row is actually persisted.
 */
export async function ensureWorkspaceSuppressionKey(client: PoolClient, workspaceId: string): Promise<Buffer> {
  const existing = await loadWorkspaceSuppressionKey(client, workspaceId);
  if (existing) return existing;

  const keyMaterial = randomBytes(32);
  try {
    const sealed = await encryptTenantSecret(workspaceId, keyMaterial.toString("base64"));
    await client.query(
      `INSERT INTO workspace_suppression_keys (workspace_id, encrypted_dek, ciphertext, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId, sealed.encryptedDek, sealed.ciphertext, sealed.iv, sealed.authTag]
    );
  } finally {
    keyMaterial.fill(0);
  }

  const stored = await loadWorkspaceSuppressionKey(client, workspaceId);
  if (!stored) {
    throw new Error(
      `ensureWorkspaceSuppressionKey: workspace_suppression_keys row for workspace ${workspaceId} was not found immediately after insert`
    );
  }
  return stored;
}
