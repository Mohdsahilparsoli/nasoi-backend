// Applies db/migrations/*.sql in order (tracked in schema_migrations).
// Usage: npm run db:migrate            → migrations only
//        npm run db:migrate -- --seed  → also inserts the demo accounts
import { existsSync, readFileSync, readdirSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const { db } = await import("../src/db.js");

const pool = db();
await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
await pool.query("alter table schema_migrations enable row level security");

const dirs = ["db/migrations", ...(process.argv.includes("--seed") ? ["db/seed"] : [])];
for (const dir of dirs) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const name = `${dir}/${file}`;
    const done = await pool.query("select 1 from schema_migrations where name = $1", [name]);
    if (done.rowCount) {
      console.log("skip ", name);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(readFileSync(name, "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [name]);
      await client.query("commit");
      console.log("apply", name);
    } catch (err) {
      await client.query("rollback");
      console.error("FAILED", name, (err as Error).message);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }
}
await pool.end();
