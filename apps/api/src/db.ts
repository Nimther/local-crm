// Thin re-export shim: the pooled pg client (with the CR-03 pool.on('error')
// handler) now lives in @mega-crm/tenant-context so apps/api and apps/worker
// share a single pool implementation instead of constructing two independent
// ones. See middleware/tenant-context.ts for the sibling shim.
export { pool } from "@mega-crm/tenant-context";
