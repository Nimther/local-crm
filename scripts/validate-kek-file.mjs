#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function validateKekFile(pathname) {
  let stat;
  try { stat = lstatSync(pathname); } catch { return [`${pathname}: missing or inaccessible`]; }
  const issues = [];
  if (stat.isSymbolicLink() || !stat.isFile()) issues.push(`${pathname}: must be a regular file, not a symlink`);
  if (stat.uid !== 0) issues.push(`${pathname}: owner uid must be 0`);
  if (stat.gid !== 1999) issues.push(`${pathname}: group gid must be 1999`);
  if ((stat.mode & 0o777) !== 0o440) issues.push(`${pathname}: mode must be exactly 0440`);
  let raw;
  try { raw = readFileSync(pathname, "utf8").trim(); } catch { issues.push(`${pathname}: unreadable`); return issues; }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    issues.push(`${pathname}: contents must be strict base64 for exactly 32 bytes`);
  } else {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== raw) issues.push(`${pathname}: decoded length must be 32 bytes`);
    decoded.fill(0);
  }
  return issues;
}

function isDirect() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}
if (isDirect()) {
  const pathname = process.argv[2] ?? "/etc/mega-crm/kek";
  const issues = validateKekFile(pathname);
  if (issues.length) {
    for (const issue of issues) console.error(`KEK preflight: ${issue}`);
    process.exit(1);
  }
  console.log(`KEK preflight: ${pathname} metadata and encoding are valid (contents not displayed).`);
}
