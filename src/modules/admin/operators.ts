import type { Request } from "express";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { HttpError } from "../../lib/http.js";
import { notify } from "../../lib/notify.js";
import { toPublicAssignment, withProgress } from "../assignments/service.js";

/** GET /admin/operators – every registered DEO with location and work summary. */
export async function listOperators(q?: string) {
  const where: Prisma.UserWhereInput = { role: "deo" };
  const s = q?.trim();
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
    take: 1000,
    select: {
      id: true, name: true, mobile: true, email: true, status: true, createdAt: true, lastLoginAt: true,
      profile: { select: { district: true, state: true, pincode: true, qualification: true } },
      assignments: { select: { id: true, status: true, pincode: true, taskType: true, deadline: true }, orderBy: { createdAt: "desc" } },
    },
  });
  return users.map((u) => {
    const active = u.assignments.find((a) => a.status === "active");
    return {
      id: u.id,
      name: u.name,
      mobile: u.mobile,
      email: u.email,
      status: u.status,
      joinedAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      location: u.profile ? { district: u.profile.district, state: u.profile.state, pincode: u.profile.pincode } : null,
      qualification: u.profile?.qualification ?? null,
      assignments: { total: u.assignments.length, completed: u.assignments.filter((a) => a.status === "completed").length },
      currentAssignment: active ? { id: active.id, pincode: active.pincode, taskType: active.taskType, deadline: active.deadline.toISOString().slice(0, 10) } : null,
      eligible: u.status === "active" && !active,
    };
  });
}

/** GET /admin/operators/:id – full profile (masked) + documents + assignments. */
export async function getOperator(id: string) {
  const u = await prisma().user.findUnique({
    where: { id: id.toUpperCase() },
    include: {
      profile: true,
      documents: { where: { attachedAt: { not: null } }, select: { id: true, kind: true, fileName: true, mimeType: true, size: true, createdAt: true } },
      assignments: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!u || u.role !== "deo") throw new HttpError(404, "Operator not found.", "NOT_FOUND");
  const p = u.profile;
  return {
    id: u.id, name: u.name, mobile: u.mobile, email: u.email, status: u.status, joinedAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    profile: p && {
      fatherName: p.fatherName, motherName: p.motherName, dob: p.dob.toISOString().slice(0, 10), gender: p.gender, category: p.category,
      religion: p.religion, altMobile: p.altMobile, qualification: p.qualification, country: p.country, state: p.state, district: p.district,
      subDistrict: p.subDistrict, postOffice: p.postOffice, pincode: p.pincode, policeStation: p.policeStation, address: p.address,
      aadhaar: `XXXX XXXX ${p.aadhaarLast4}`, pan: p.pan,
      bank: { bankName: p.bankName, accountHolder: p.accountHolder, account: `XXXXXX${p.accountLast4}`, ifsc: p.ifsc, proofType: p.bankProofType },
    },
    documents: u.documents,
    assignments: await withProgress(u.assignments.map(toPublicAssignment)),
    eligible: u.status === "active" && !u.assignments.some((a) => a.status === "active"),
  };
}

/** PATCH /admin/operators/:id/status – block (also logs the DEO out everywhere) or unblock. */
export async function setOperatorStatus(req: Request, adminId: string, id: string, status: "active" | "blocked") {
  const db = prisma();
  const u = await db.user.findUnique({ where: { id: id.toUpperCase() }, select: { id: true, role: true, email: true } });
  if (!u || u.role !== "deo") throw new HttpError(404, "Operator not found.", "NOT_FOUND");
  await db.$transaction([
    db.user.update({ where: { id: u.id }, data: { status } }),
    ...(status === "blocked"
      ? [db.authSession.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: "blocked_by_admin" } })]
      : []),
  ]);
  await audit(req, status === "blocked" ? "user.blocked" : "user.unblocked", adminId, { userId: u.id });
  if (status === "active") await notify(u, { title: "Account active", body: "Your NASOI account has been activated by the admin.", link: "/deo" });
  return { id: u.id, status };
}
