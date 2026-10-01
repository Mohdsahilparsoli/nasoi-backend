// Test-only accounts (local database). Created if missing, password reset to the known value.
import bcrypt from "bcryptjs";

export const FIXTURES = [
  { id: "DEO126", role: "deo", name: "Rahul Kumar", mobile: "9717323761", email: "rahul.demo@example.com", password: "Abcd@2026" },
  { id: "DEO127", role: "deo", name: "Priya Sharma", mobile: "9811100022", email: "priya.demo@example.com", password: "Abcd@2026" },
  { id: "VR101", role: "verifier", name: "Anjali Verma", mobile: "9990011223", email: "verifier.demo@example.com", password: "Abcd@2026" },
  { id: "ADMIN", role: "admin", name: "Super Admin", mobile: "9000000000", email: "admin.demo@example.com", password: "Admin@2026" },
] as const;

export async function ensureFixtures() {
  const { prisma } = await import("../src/db.js");
  for (const f of FIXTURES) {
    const passwordHash = await bcrypt.hash(f.password, 10);
    const { password: _p, ...u } = f;
    await prisma().user.upsert({
      where: { id: f.id },
      create: { ...u, passwordHash },
      update: { passwordHash, status: "active", failedLoginCount: 0, lockedUntil: null },
    });
  }
}
