#!/usr/bin/env node
// Phase 14 plan 06 (OPS-01) -- run inside the Docker build stage only, never
// against the checked-in repo. Every shared workspace package under
// `packages/*` ships with `"main": "./src/index.ts"` and `noEmit: true` in
// its tsconfig.json BY DESIGN (tsx/vitest read them as TypeScript source in
// dev and in tests) -- confirmed by reading all 10 tsconfig.json files, not
// assumed. Plain `node dist/server.js` in production cannot resolve that:
// Node's TypeScript type-stripping does not remap a relative `./foo.js`
// import specifier to a sibling `foo.ts` file the way tsx/vitest do -- this
// was confirmed empirically in this repo's own sandbox (`node` throws
// ERR_MODULE_NOT_FOUND for exactly this case; see 14-06-SUMMARY.md) and is
// also the exact gap plan 14-04's own SUMMARY flagged forward to this plan.
//
// The fix is confined to the IMAGE, never to git-tracked source: compile
// every shared package to a real `dist/` (overriding its tsconfig's
// `noEmit: true` for this one build), then rewrite that package's
// `main`/`types`/`exports` to point at `dist/` instead of `src/`. Every
// package gets the SAME `exports` shape regardless of whether it already had
// one, so ANY current or future deep-import specifier of the form
// `@mega-crm/<pkg>/src/<path>.js` (this repo's own established deep-import
// convention -- see e.g. scripts/migrate-runner.mjs, apps/worker/src/shutdown-budget.ts)
// keeps resolving after this patch, not just the specific ones grepped for
// while writing this script.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// Every `packages/*` workspace apps/api or apps/worker imports in production.
// Deliberately excludes `test-support` (devDependency only, never a runtime
// "dependencies" entry of either app -- confirmed via both package.json
// files before writing this list).
const PACKAGES = [
  "contacts-core",
  "db",
  "delivery-core",
  "flows-core",
  "kms",
  "queue-core",
  "redaction",
  "segments-core",
  "shared-schemas",
  "tenant-context",
];

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

for (const name of PACKAGES) {
  const pkgDir = path.join(ROOT, "packages", name);
  const buildTsconfigPath = path.join(pkgDir, "tsconfig.build.json");

  // Explicit rootDir + an exclude of __tests__/*.test.ts, generated fresh
  // per build rather than baked into the committed tsconfig.json: without an
  // explicit rootDir, TypeScript infers it from every file it ends up
  // compiling, and packages/db's own __tests__ files import sibling
  // packages/db/scripts/*.ts CLIs -- once those are pulled in transitively,
  // tsc's inferred common root widens from `src` to the package root and
  // every output path shifts under an extra `src/`/`scripts/` prefix,
  // breaking every relative resolution downstream. Reproduced and fixed
  // empirically while writing this script (see 14-06-SUMMARY.md).
  fs.writeFileSync(
    buildTsconfigPath,
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: { noEmit: false, outDir: "dist", rootDir: "src" },
        exclude: ["src/**/__tests__/**", "src/**/*.test.ts"],
      },
      null,
      2,
    ) + "\n",
  );

  try {
    run("npx", ["tsc", "-p", buildTsconfigPath], ROOT);
  } finally {
    fs.rmSync(buildTsconfigPath, { force: true });
  }

  const indexJsPath = path.join(pkgDir, "dist", "index.js");
  if (!fs.existsSync(indexJsPath)) {
    console.error(`patch-workspace-mains: ${name} did not produce dist/index.js -- aborting build`);
    process.exit(1);
  }

  const pkgJsonPath = path.join(pkgDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  pkgJson.main = "./dist/index.js";
  pkgJson.types = "./dist/index.d.ts";
  // Uniform shape for every package: the root import, plus the wildcard that
  // makes every `@mega-crm/<pkg>/src/<leaf>.js` deep-import specifier resolve
  // to the compiled `dist/<leaf>.js` instead of the (now type-stripping-
  // incompatible) `.ts` source -- see this file's header comment.
  pkgJson.exports = {
    ".": "./dist/index.js",
    "./src/*.js": "./dist/*.js",
  };
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
  console.log(`patch-workspace-mains: ${name} -> dist/, package.json patched`);
}

console.log(`patch-workspace-mains: done (${String(PACKAGES.length)} packages)`);
