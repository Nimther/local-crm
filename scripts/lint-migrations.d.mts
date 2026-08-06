// GSD 08-06: type declarations for scripts/lint-migrations.mjs.
//
// The linter is deliberately a dependency-free .mjs script (08-05), but the
// vitest suite in packages/test-support imports it directly, and
// `npm run build --workspaces` — which IS the typecheck (D-04) — fails with
// TS7016 on an untyped .mjs import. These declarations keep the script plain
// JavaScript while letting the type-checked test file import it.

export interface MigrationLintViolation {
  file: string;
  rule: "enum-add-value-used-same-file" | "destructive-ddl-unmarked";
  line: number | null;
  detail: string;
}

export function stripSqlComments(sql: string): string;
export function checkEnumAddValueSameFile(file: string, rawSql: string): MigrationLintViolation[];
export function checkDestructiveDdl(file: string, rawSql: string): MigrationLintViolation[];
export function lintMigrationFile(file: string, rawSql: string): MigrationLintViolation[];
export function lintMigrationDirectory(dir: string): MigrationLintViolation[];
