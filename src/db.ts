import pg from "pg";
import { config } from "./config.js";

let pool: pg.Pool | undefined;

/**
 * One small pool per serverless instance. Use the Supabase *transaction pooler*
 * URL (port 6543) in production so many instances share few DB connections.
 */
export function db(): pg.Pool {
  if (pool) return pool;
  const c = config();
  const url = new URL(c.DATABASE_URL);
  // SSL is configured below; drop sslmode from the URL so it cannot override it.
  url.searchParams.delete("sslmode");
  pool = new pg.Pool({
    connectionString: url.toString(),
    max: c.isProd ? 3 : 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl:
      c.DATABASE_SSL === "disable"
        ? false
        : c.DATABASE_SSL_CA
          ? { ca: c.DATABASE_SSL_CA, rejectUnauthorized: true }
          : { rejectUnauthorized: false }, // encrypted; add DATABASE_SSL_CA to also verify the server
  });
  pool.on("error", (err) => console.error("[db] idle client error", err.message));
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
  return db().query<T>(text, params);
}
