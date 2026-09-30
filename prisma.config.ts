import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Local dev reads .env; on Vercel the variables come from Project Settings.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations prefer a direct connection when one is given; otherwise DATABASE_URL.
    url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || "",
  },
});
