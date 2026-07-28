// GSD 08-15: type declarations for scripts/env-path.mjs.
//
// Needed because tsconfig.base.json uses NodeNext resolution with allowJs off,
// and apps/api/src/load-env.ts and apps/worker/src/load-env.ts are typechecked
// `src/` code importing this .mjs module. See scripts/lint-migrations.d.mts for
// the same pattern.

/**
 * Absolute path to this machine's configuration file.
 * MEGA_CRM_ENV_FILE overrides; otherwise `$XDG_CONFIG_HOME/mega-crm/.env`,
 * falling back to `~/.config/mega-crm/.env`.
 */
export function resolveEnvPath(): string;
