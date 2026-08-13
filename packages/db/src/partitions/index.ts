/**
 * Phase 14 plan 12 (DB-11): the partitions module's public re-export point.
 * Every other file in this directory is imported by its own direct path
 * elsewhere in the codebase (`@mega-crm/db/src/partitions/ensure-partitions.js`,
 * etc.) -- this index exists specifically so `retention.ts`'s exports have a
 * stable module entry point, per this plan's own acceptance criteria.
 */
export * from "./retention.js";
