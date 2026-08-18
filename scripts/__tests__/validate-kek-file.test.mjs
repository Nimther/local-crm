import { mkdtempSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateKekFile } from "../validate-kek-file.mjs";

function tempFile(raw = Buffer.alloc(32, 7).toString("base64")) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kek-validator-"));
  const file = path.join(dir, "kek");
  writeFileSync(file, `${raw}\n`, { mode: 0o440 });
  return { dir, file };
}

describe("host KEK validator", () => {
  it("reports ownership policy without exposing contents", () => {
    const { file } = tempFile();
    const issues = validateKekFile(file);
    expect(issues.join(" ")).toMatch(/uid|gid/); // normal CI user cannot forge root:1999
    expect(issues.join(" ")).not.toContain(Buffer.alloc(32, 7).toString("base64"));
  });
  it("rejects permissive mode, malformed contents, and symlinks", () => {
    const first = tempFile("bad-value");
    chmodSync(first.file, 0o444);
    expect(validateKekFile(first.file).join(" ")).toMatch(/0440/);
    expect(validateKekFile(first.file).join(" ")).toMatch(/base64/);
    const link = path.join(first.dir, "link");
    symlinkSync(first.file, link);
    expect(validateKekFile(link).join(" ")).toMatch(/symlink/);
  });
  it("rejects a missing file without leaking anything", () => {
    expect(validateKekFile("/definitely/missing/mega-crm-kek")).toEqual([expect.stringMatching(/missing/)]);
  });
});
