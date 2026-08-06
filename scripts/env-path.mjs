#!/usr/bin/env node
// GSD 08-15 (QG-07): where the configuration file lives — decided once.
//
// Before this, six readers each hardcoded their own relative path to a file in
// the repository working root: both dev entrypoints, three vitest configs,
// check-env.mjs and migrate-dev.mjs. A location decided in six places cannot be
// moved, and each site drifts on its own.
//
// The default is deliberately OUTSIDE the repository. A file holding real
// platform secrets sitting in the working root is readable by every tool,
// script, editor extension and agent operating on this checkout — and being
// gitignored does not change that, because an ignored file still sits on disk.
//
// MEGA_CRM_ENV_FILE overrides it entirely, which is how CI (where no file
// exists and every variable is exported directly) and any non-standard local
// setup opt out without editing code.
//
// No dependencies -- Node built-ins only.

import os from "node:os";
import path from "node:path";

/** The configuration filename, kept identical to what the repo used before. */
const CONFIG_FILENAME = ".env";

/** Directory under the user's config root. */
const APP_DIR = "mega-crm";

/**
 * Absolute path to this machine's configuration file.
 *
 * @returns {string}
 */
export function resolveEnvPath() {
  const override = process.env.MEGA_CRM_ENV_FILE;
  if (override && override.trim() !== "") return override;

  // XDG_CONFIG_HOME when the user has set it, otherwise the conventional
  // ~/.config — the same precedence every XDG-aware tool uses.
  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== ""
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");

  return path.join(configHome, APP_DIR, CONFIG_FILENAME);
}
