import { z } from "zod";

/**
 * All configuration comes from environment variables.
 * Secrets (DATABASE_URL, JWT_SECRET) are never committed: set them in
 * Vercel → Project → Settings → Environment Variables, or in a local .env.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a postgres connection URL"),
  /** Optional custom CA (PEM) if the database uses a private certificate authority. */
  DATABASE_SSL_CA: z.string().optional(),
  /** "verify" (default, encrypted + certificate checked) · "require" (encrypted only) · "disable" (local Postgres only). */
  DATABASE_SSL: z.enum(["verify", "require", "disable"]).default("verify"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  /** Comma separated list of browser origins allowed to call the API. */
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(5).max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(20).default(5),
  LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
});

export type Config = z.infer<typeof schema> & { corsOrigins: string[]; isProd: boolean };

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Never print values, only which keys are wrong.
    const keys = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration → ${keys}`);
  }
  const c = parsed.data;
  cached = {
    ...c,
    isProd: c.NODE_ENV === "production",
    corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  };
  return cached;
}
