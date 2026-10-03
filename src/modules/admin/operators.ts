import type { Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { HttpError } from "../../lib/http.js";
import { accountStatusEmail } from "../../lib/mailer.js";
import { notify } from "../../lib/notify.js";
import { toPublicAssignment, withProgress } from "../assignments/service.js";

/*
 * Employees = Data Entry Operators and Verifiers. The admin activates,
 * deactivates or rejects them; only active employees get work.
 */

export type EmployeeRole = "deo" | "verifier";

const workSelect = { id: true, status: true, pincode: true, taskType: true, deadline: true } as const;

/** GET /admin/operators?role=deo|verifier&q= – employees with location, work and status. */
export async function listEmployees(f: { q?: string; role?: EmployeeRole }) {
  const where: Prisma.UserWhereInput = { role: f.role ? f.role : { in: ["deo", "verifier"] } };
  const s = f.q?.trim();
  if (s) {
    where.OR = [
      { id: { contains: s, mode: "insensitive" } },
      { name: { contains: s, mode: "insensitive" } },
      { mobile: { contains: s } },
      { email: { contains: s.toLowerCase() } },
      { profile: { is: { district: { contains: s, mode: "insensitive" } } } },
      { profile: { is: { pincode: { startsWith: s } } } },
    ];
  }
  const users = await prisma().user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 2000,
    select: {
      id: true, role: true, name: true, mobile: true, email: true, status: true, statusReason: true, createdAt: true, lastLoginAt: true,
      profile: { select: { district: true, state: true, pincode: true, qualification: true } },
      assignments: { select: workSelect, orderBy: { createdAt: "desc" } },
      areasToVerify: { select: workSelect, orderBy: { createdAt: "desc" } },
    },
  });
  return users.map((u) => {
    const work = u.role === "verifier" ? u.areasToVerify : u.assignments;
    const active = work.filter((a) => a.status === "active");
    const current = u.role === "deo" ? active[0] : undefined;
    return {
      id: u.id,
      role: u.role as EmployeeRole,
      name: u.name,
      mobile: u.mobile,
      email: u.email,
      status: u.status,
      statusReason: u.statusReason,
      joinedAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      location: u.profile ? { district: u.profile.district, state: u.profile.state, pincode: u.profile.pincode } : null,
      qualification: u.profile?.qualification ?? null,
      assignments: { total: work.length, completed: work.filter((a) => a.status === "completed").length, active: active.length },
      currentAssignment: current ? { id: current.id, pincode: current.pincode, taskType: current.taskType, deadline: current.deadline.toISOString().slice(0, 10) } : null,
      // A DEO gets one work at a time; a verifier can verify several areas.
      eligible: u.status === "active" && (u.role === "verifier" || !current),
    };
  });
}

/** GET /admin/operators/:id – full profile (masked) + documents + work (DEO or verifier). */
export async function getEmployee(id: string) {
  const u = await prisma().user.findUnique({
    where: { id: id.toUpperCase() },
    include: {
      profile: true,
      documents: { where: { attachedAt: { not: null } }, select: { id: true, kind: true, fileName: true, mimeType: true, size: true, createdAt: true } },
      assignments: { orderBy: { createdAt: "desc" } },
      areasToVerify: { orderBy: { createdAt: "desc" }, include: { deo: { select: { id: true, name: true, mobile: true } } } },
    },
  });
  if (!u || (u.role !== "deo" && u.role !== "verifier")) throw new HttpError(404, "Employee not found.", "NOT_FOUND");
  const p = u.profile;
  const work = u.role === "verifier" ? u.areasToVerify : u.assignments;
  return {
    id: u.id, role: u.role as EmployeeRole, name: u.name, mobile: u.mobile, email: u.email, status: u.status, statusReason: u.statusReason,
    statusChangedAt: u.statusChangedAt, joinedAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    profile: p && {
      fatherName: p.fatherName, motherName: p.motherName, dob: p.dob.toISOString().slice(0, 10), gender: p.gender, category: p.category,
      religion: p.religion, altMobile: p.altMobile, qualification: p.qualification, country: p.country, state: p.state, district: p.district,
      subDistrict: p.subDistrict, postOffice: p.postOffice, pincode: p.pincode, policeStation: p.policeStation, address: p.address,
      aadhaar: `XXXX XXXX ${p.aadhaarLast4}`, pan: p.pan,
      bank: { bankName: p.bankName, accountHolder: p.accountHolder, account: `XXXXXX${p.accountLast4}`, ifsc: p.ifsc, proofType: p.bankProofType },
    },
    documents: u.documents,
    assignments: await withProgress(work.map(toPublicAssignment)),
    eligible: u.status === "active" && (u.role === "verifier" || !u.assignments.some((a) => a.status === "active")),
  };
}

export const employeeStatusSchema = z
  .object({
    status: z.enum(["active", "inactive", "rejected"], { error: "Choose active, inactive or rejected" }),
    reason: z.string().trim().max(300, "Reason is too long").optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "rejected" && (v.reason ?? "").length < 5) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Write the reason for rejection (at least 5 characters)" });
    }
  });

const MESSAGE: Record<"active" | "inactive" | "rejected", { title: string; body: (reason?: string) => string }> = {
  active: { title: "Account active", body: () => "Your NASOI account has been activated by the admin. You can now be assigned work." },
  inactive: { title: "Account inactive", body: (r) => `Your account has been made inactive by the admin${r ? `: ${r}` : ""}. You will not get new work until it is activated again.` },
  rejected: { title: "Registration not approved", body: (r) => `Your registration was not approved${r ? `: ${r}` : ""}.` },
};

/**
 * PATCH /admin/operators/:id/status – activate, deactivate or reject an employee.
 * Rejected employees are logged out everywhere and cannot log in.
 */
export async function setEmployeeStatus(req: Request, adminId: string, id: string, v: z.infer<typeof employeeStatusSchema>) {
  const db = prisma();
  const u = await db.user.findUnique({ where: { id: id.toUpperCase() }, select: { id: true, role: true, email: true, name: true, status: true } });
  if (!u || (u.role !== "deo" && u.role !== "verifier")) throw new HttpError(404, "Employee not found.", "NOT_FOUND");
  const reason = v.status === "active" ? null : (v.reason || null);
  await db.$transaction([
    db.user.update({ where: { id: u.id }, data: { status: v.status, statusReason: reason, statusChangedAt: new Date() } }),
    ...(v.status === "rejected"
      ? [db.authSession.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: "rejected_by_admin" } })]
      : []),
  ]);
  await audit(req, `user.${v.status === "active" ? "activated" : v.status === "inactive" ? "deactivated" : "rejected"}`, adminId, { userId: u.id });
  const m = MESSAGE[v.status];
  await notify(
    u,
    { title: m.title, body: m.body(reason ?? undefined), link: u.role === "verifier" ? "/verifier" : "/deo" },
    // A rejected employee cannot log in, so e-mail is the only way to tell them; activation is good news worth an e-mail.
    v.status !== "inactive" ? accountStatusEmail({ name: u.name, id: u.id, role: u.role as EmployeeRole, status: v.status, reason: reason ?? undefined }) : undefined,
  );
  return { id: u.id, status: v.status, statusReason: reason };
}
