import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const POSTGRES_DOCKERFILE = path.join(REPO_ROOT, "docker/postgres/Dockerfile");

describe("Postgres/pgBackRest image TLS trust", () => {
  it("installs the system CA bundle required by S3-compatible HTTPS repositories", () => {
    const source = readFileSync(POSTGRES_DOCKERFILE, "utf8");

    expect(source).toMatch(/apt-get install[^\n]*ca-certificates/);
  });
});
