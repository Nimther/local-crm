// 08-06 (D-13): consolidated into @mega-crm/test-support.
// This workspace has no fixture helpers of its own, so the file is a pure
// re-export. Kept as a shim rather than rewriting every import site: a mass
// import rewrite in the same change as the dev-DB fallback removal would make
// a regression impossible to bisect.
export { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";
