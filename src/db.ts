import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config.js";
import { PrismaClient } from "./generated/prisma/client.js";

let client: PrismaClient | undefined;

/** TLS settings for the pg driver. Default: encrypted and certificate verified. */
function ssl() {
  const c = config();
  if (c.DATABASE_SSL === "disable") return false;
  if (c.DATABASE_SSL === "require") return { rejectUnauthorized: false }; // encrypted, not verified
  return c.DATABASE_SSL_CA ? { ca: c.DATABASE_SSL_CA, rejectUnauthorized: true } : { rejectUnauthorized: true };
}

/**
 * One Prisma client per serverless instance, using the `pg` driver adapter.
 * Works with any PostgreSQL URL (Prisma Postgres pooled URL recommended).
 */
export function prisma(): PrismaClient {
  if (client) return client;
  const c = config();
  const url = new URL(c.DATABASE_URL);
  // TLS is configured explicitly below, so sslmode in the URL cannot weaken it.
  url.searchParams.delete("sslmode");
  const adapter = new PrismaPg({
    connectionString: url.toString(),
    ssl: ssl(),
    max: c.isProd ? 3 : 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  client = new PrismaClient({ adapter });
  return client;
}
