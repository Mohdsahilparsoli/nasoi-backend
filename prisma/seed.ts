// Demo accounts (match the frontend demo). Runs on deploy only when SEED_DEMO_USERS=true.
// Existing users are never overwritten. Change/delete these before real launch.
import bcrypt from "bcryptjs";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

if (process.env.SEED_DEMO_USERS !== "true") {
  console.log("[seed] SEED_DEMO_USERS is not 'true' – skipping demo accounts.");
  process.exit(0);
}

const { prisma } = await import("../src/db.js");

const demo = [
  { id: "DEO126", role: "deo", name: "Rahul Kumar", mobile: "9717323761", email: "rahul.demo@example.com", password: "Abcd@2026" },
  { id: "DEO127", role: "deo", name: "Priya Sharma", mobile: "9811100022", email: "priya.demo@example.com", password: "Abcd@2026" },
  { id: "VR101", role: "verifier", name: "Anjali Verma", mobile: "9990011223", email: "verifier.demo@example.com", password: "Abcd@2026" },
  { id: "ADMIN", role: "admin", name: "Super Admin", mobile: "9000000000", email: "admin.demo@example.com", password: "Admin@2026" },
] as const;

const db = prisma();
const data = await Promise.all(
  demo.map(async ({ password, ...u }) => ({ ...u, passwordHash: await bcrypt.hash(password, 12) })),
);
const r = await db.user.createMany({ data, skipDuplicates: true });
console.log(`[seed] demo accounts added: ${r.count} (existing kept)`);
await db.$disconnect();
