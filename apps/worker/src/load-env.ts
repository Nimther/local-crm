import { resolveEnvPath } from "../../../scripts/env-path.mjs";

/**
 * 08-15 (QG-07) — load this machine's configuration, in code.
 *
 * A side-effect module, imported FIRST by server.ts. That ordering is the whole
 * mechanism: ES module evaluation follows import order, and apps/api/src/env.ts
 * parses its zod schema at module evaluation. A load placed after that import —
 * or anywhere in a function body — runs once the schema has already read an
 * empty environment, and the process refuses to boot with a validation error
 * that reads as missing configuration rather than as a load-ordering bug.
 *
 * This replaces `--env-file=../../.env` on the dev script. The flag could only
 * ever name a fixed path relative to the working directory; resolveEnvPath()
 * honours MEGA_CRM_ENV_FILE and defaults outside the repository.
 *
 * A missing file is not an error. In CI no file exists at all and every
 * variable is exported into the environment directly — throwing here would
 * break the very lane this phase is building.
 */
try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // No configuration file — rely on already-exported environment variables.
}
