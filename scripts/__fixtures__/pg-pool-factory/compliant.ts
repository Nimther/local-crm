import { createPgPool } from "@mega-crm/db/src/pool.js";

// A comment mentioning `new Pool(` in prose must never trip the gate --
// only real, uncommented code does.
const pool = createPgPool({ connectionString: process.env.DATABASE_URL ?? "", name: "compliant-fixture" });

export { pool };
