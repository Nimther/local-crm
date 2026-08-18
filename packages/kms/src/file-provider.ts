import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { env } from "./env.js";

const EXPECTED_UID = 0;
const EXPECTED_GID = 1999;
const EXPECTED_MODE = 0o440;
const PREFIX = "file:v1:";
const PACKED_BYTES = 12 + 16 + 32;

export interface KekFileMetadata {
  isFile: boolean;
  isSymbolicLink: boolean;
  uid: number;
  gid: number;
  mode: number;
}

function metadataOf(stat: Stats): KekFileMetadata {
  return {
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
  };
}

/** Pure policy check exported so CI can exercise root ownership without privileged fixtures. */
export function validateKekFile(metadata: KekFileMetadata, raw: string, path: string): Buffer {
  const reject = (reason: string): never => {
    throw new Error(`Unsafe KMS file at ${path}: ${reason}`);
  };
  if (metadata.isSymbolicLink || !metadata.isFile) reject("must be a regular file, not a symlink");
  if (metadata.uid !== EXPECTED_UID) reject(`owner uid must be ${EXPECTED_UID}`);
  if (metadata.gid !== EXPECTED_GID) reject(`group gid must be ${EXPECTED_GID}`);
  if (metadata.mode !== EXPECTED_MODE) reject("mode must be exactly 0440");

  const encoded = raw.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) reject("contents must be strict base64 for exactly 32 bytes");
  const kek = Buffer.from(encoded, "base64");
  if (kek.length !== 32 || kek.toString("base64") !== encoded) {
    kek.fill(0);
    reject("decoded key must be exactly 32 bytes");
  }
  return kek;
}

function requirePath(): string {
  if (!env.KMS_FILE_KEK_PATH) throw new Error("KMS_FILE_KEK_PATH must be set when KMS_PROVIDER=file");
  return env.KMS_FILE_KEK_PATH;
}

function loadKek(): Buffer {
  const path = requirePath();
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`Unsafe KMS file at ${path}: file is missing or inaccessible`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Unsafe KMS file at ${path}: file is unreadable`);
  }
  return validateKekFile(metadataOf(stat), raw, path);
}

export function assertReady(): void {
  const kek = loadKek();
  kek.fill(0);
}

export function generateDataKey(workspaceId: string): { plaintextDek: Buffer; wrappedDek: string } {
  const kek = loadKek();
  try {
    const plaintextDek = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    cipher.setAAD(Buffer.from(workspaceId, "utf8"));
    const wrapped = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
    return { plaintextDek, wrappedDek: `${PREFIX}${packed.toString("base64")}` };
  } finally {
    kek.fill(0);
  }
}

export function decryptDataKey(workspaceId: string, wrappedDek: string): Buffer {
  if (!wrappedDek.startsWith(PREFIX)) throw new Error("Wrapped DEK is not a supported file-provider value");
  const encoded = wrappedDek.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Wrapped DEK is malformed");
  const packed = Buffer.from(encoded, "base64");
  if (packed.length !== PACKED_BYTES || packed.toString("base64") !== encoded) {
    throw new Error("Wrapped DEK has an invalid file-provider length or encoding");
  }
  const kek = loadKek();
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, packed.subarray(0, 12));
    decipher.setAAD(Buffer.from(workspaceId, "utf8"));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
  } finally {
    kek.fill(0);
  }
}
