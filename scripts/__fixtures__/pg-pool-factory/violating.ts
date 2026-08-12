import { Pool } from "pg";

// A bare pool construction with no error listener -- exactly what
// DB-14/lint:pg-pool-factory exists to catch.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export { pool };
