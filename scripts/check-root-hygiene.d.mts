// GSD 08-15: type declarations for scripts/check-root-hygiene.mjs.
// See scripts/lint-migrations.d.mts for why these exist.

/** The offending subset of the given directory-entry names, in the order given. */
export function checkRootHygiene(entries: string[]): string[];

/** Why a given name is blacklisted, for CLI output. */
export function hygieneReason(name: string): string;
