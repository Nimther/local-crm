import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = Buffer.alloc(32, 0x5a).toString("base64");
const state = vi.hoisted(() => ({
  raw: "",
  metadata: { isFile: true, isSymbolicLink: false, uid: 0, gid: 1999, mode: 0o440 },
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => state.raw),
  lstatSync: vi.fn(() => ({
    ...state.metadata,
    isFile: () => state.metadata.isFile,
    isSymbolicLink: () => state.metadata.isSymbolicLink,
  })),
}));

beforeEach(() => {
  state.raw = KEY;
  state.metadata = { isFile: true, isSymbolicLink: false, uid: 0, gid: 1999, mode: 0o440 };
  process.env.KMS_PROVIDER = "file";
  process.env.KMS_FILE_KEK_PATH = "/run/secrets/mega-crm-kek";
});

describe("file provider key-file policy", () => {
  it("selects file strictly and rejects missing paths, local production, and typos", async () => {
    const { loadKmsEnv } = await import("../env.js");
    expect(loadKmsEnv({ KMS_PROVIDER: "file", KMS_FILE_KEK_PATH: "/secret", NODE_ENV: "production" }).KMS_PROVIDER).toBe("file");
    expect(() => loadKmsEnv({ KMS_PROVIDER: "file" })).toThrow(/KMS_FILE_KEK_PATH/);
    expect(() => loadKmsEnv({ KMS_PROVIDER: "local", NODE_ENV: "production" })).toThrow(/never/);
    expect(() => loadKmsEnv({ KMS_PROVIDER: "typo" })).toThrow(/one of/);
  });

  it.each([
    [{ isFile: false }, /regular file/],
    [{ isSymbolicLink: true }, /symlink/],
    [{ uid: 1000 }, /uid must be 0/],
    [{ gid: 1000 }, /gid must be 1999/],
    [{ mode: 0o400 }, /0440/],
    [{ mode: 0o444 }, /0440/],
  ])("rejects unsafe metadata %j", async (override, expected) => {
    const { validateKekFile } = await import("../file-provider.js");
    expect(() => validateKekFile({ ...state.metadata, ...override }, KEY, "/secret")).toThrow(expected);
  });

  it.each(["not-base64", Buffer.alloc(31).toString("base64"), `${KEY}garbage`])(
    "rejects malformed key contents without echoing them",
    async (raw) => {
      const { validateKekFile } = await import("../file-provider.js");
      let error: Error | undefined;
      try { validateKekFile(state.metadata, raw, "/secret"); } catch (caught) { error = caught as Error; }
      expect(error?.message).toMatch(/base64|32 bytes/);
      expect(error?.message).not.toContain(raw);
    },
  );
});

describe("file provider envelope", () => {
  it("round-trips nondeterministically and binds the workspace", async () => {
    const provider = await import("../file-provider.js");
    const first = provider.generateDataKey("workspace-a");
    const second = provider.generateDataKey("workspace-a");
    expect(first.wrappedDek).toMatch(/^file:v1:/);
    expect(second.wrappedDek).not.toBe(first.wrappedDek);
    expect(provider.decryptDataKey("workspace-a", first.wrappedDek)).toEqual(first.plaintextDek);
    expect(() => provider.decryptDataKey("workspace-b", first.wrappedDek)).toThrow();
  });

  it.each(["foreign-value", "file:v2:AAAA", "file:v1:AAAA"])("rejects foreign or malformed wrapped DEK %s", async (value) => {
    const provider = await import("../file-provider.js");
    expect(() => provider.decryptDataKey("workspace-a", value)).toThrow();
  });

  it("rejects a tampered wrapped DEK", async () => {
    const provider = await import("../file-provider.js");
    const sealed = provider.generateDataKey("workspace-a");
    const encoded = Buffer.from(sealed.wrappedDek.slice("file:v1:".length), "base64");
    encoded[30] ^= 0xff;
    expect(() => provider.decryptDataKey("workspace-a", `file:v1:${encoded.toString("base64")}`)).toThrow();
  });

  it("zeroes each temporary KEK buffer after use", async () => {
    const provider = await import("../file-provider.js");
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      const sealed = provider.generateDataKey("workspace-a");
      expect(fill).toHaveBeenCalledTimes(1);
      provider.decryptDataKey("workspace-a", sealed.wrappedDek);
      expect(fill).toHaveBeenCalledTimes(2);
      provider.assertReady();
      expect(fill).toHaveBeenCalledTimes(3);
    } finally {
      fill.mockRestore();
    }
  });
});
