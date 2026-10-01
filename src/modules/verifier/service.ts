import type { Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { HttpError } from "../../lib/http.js";
import { notify } from "../../lib/notify.js";
import { getSettings } from "../../lib/settings.js";
import { toPublicEntry } from "../entries/service.js";

export const decisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"], { error: "Choose approve or reject" }),
    reason: z.string().trim().max(300, "Reason is too long (max 300 characters)").optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "rejected" && (v.reason ?? "").length < 5) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Write a clear reason for rejection (at least 5 characters)" });
    }
  });

const withContext = {
  deo: { select: { id: true, name: true } },
  assignment: { select: { id: true, taskType: true, village: true, block: true } },
} satisfies Prisma.EntryInclude;

type EntryWithContext = Prisma.EntryGetPayload<{ include: typeof withContext }>;

const toVerifierEntry = (e: EntryWithContext) => ({
  ...toPublicEntry(e),
  deo: e.deo,
  assignment: e.assignment,
  verifierId: e.verifierId,
  assignedAt: e.assignedAt,
});

/**
 * Pending entries that have no verifier yet (they were submitted before any
 * verifier existed) are handed to the verifier who opens the portal.
 */
export async function claimOrphans(verifierId: string) {
  await prisma().$executeRaw`
    update entries set verifier_id = ${verifierId}, assigned_at = now()
    where id in (
      select id from entries where status = 'pending' and verifier_id is null
      order by submitted_at limit 200 for update skip locked)`;
}

/** Dashboard cards + month-wise income (IST). */
export async function verifierSummary(verifierId: string) {
  await claimOrphans(verifierId);
  const db = prisma();
  const [assigned, pending, decisions, monthly, settings] = await Promise.all([
    db.entry.count({ where: { verifierId } }),
    db.entry.count({ where: { verifierId, status: "pending" } }),
    db.verification.groupBy({ by: ["decision"], where: { verifierId }, _count: { _all: true }, _sum: { rate: true } }),
    db.$queryRaw<{ month: string; approved: bigint; rejected: bigint; income: bigint }[]>`
      select to_char(created_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month,
             count(*) filter (where decision = 'approved') as approved,
             count(*) filter (where decision = 'rejected') as rejected,
             coalesce(sum(rate), 0) as income
      from verifications where verifier_id = ${verifierId}
      group by 1 order by 1 desc`,
    getSettings(),
  ]);
  const d = (k: "approved" | "rejected") => decisions.find((x) => x.decision === k);
  const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const today = await db.$queryRaw<{ n: bigint }[]>`
    select count(*) as n from verifications
    where verifier_id = ${verifierId} and (created_at at time zone 'Asia/Kolkata')::date = ${todayIST}::date`;
  return {
    totalAssigned: assigned,
    pending,
    approved: d("approved")?._count._all ?? 0,
    rejected: d("rejected")?._count._all ?? 0,
    income: (d("approved")?._sum.rate ?? 0) + (d("rejected")?._sum.rate ?? 0),
    verifiedToday: Number(today[0]?.n ?? 0),
    rate: settings.verifierRate,
    monthly: monthly.map((m) => ({ month: m.month, approved: Number(m.approved), rejected: Number(m.rejected), income: Number(m.income) })),
  };
}

/** Entries assigned to this verifier: pending queue (oldest first) or all. */
export async function verifierEntries(verifierId: string, view: "pending" | "all") {
  await claimOrphans(verifierId);
  const rows = await prisma().entry.findMany({
    where: { verifierId, ...(view === "pending" ? { status: "pending" } : {}) },
    orderBy: view === "pending" ? { submittedAt: "asc" } : { submittedAt: "desc" },
    include: withContext,
    take: 2000,
  });
  return rows.map(toVerifierEntry);
}

export async function verifierEntry(verifierId: string, id: string) {
  const e = await prisma().entry.findUnique({ where: { id }, include: withContext });
  const decidedByMe = e && (await prisma().verification.count({ where: { entryId: id, verifierId } })) > 0;
  if (!e || (e.verifierId !== verifierId && !decidedByMe)) throw new HttpError(404, "Entry not found.", "NOT_FOUND");
  const history = await prisma().verification.findMany({ where: { entryId: id }, orderBy: { createdAt: "asc" }, select: { decision: true, reason: true, createdAt: true, verifierId: true } });
  return { ...toVerifierEntry(e), history };
}

/** Approve or reject a pending entry assigned to this verifier. */
export async function decide(req: Request, verifierId: string, id: string, v: z.infer<typeof decisionSchema>) {
  const { verifierRate } = await getSettings();
  const reason = v.decision === "rejected" ? v.reason! : null;
  const entry = await prisma().$transaction(async (tx) => {
    const now = new Date();
    // Only one decision can win, even if the verifier double-clicks or two tabs are open.
    const r = await tx.entry.updateMany({
      where: { id, verifierId, status: "pending" },
      data: { status: v.decision, rejectReason: reason, verifiedById: verifierId, verifiedAt: now },
    });
    if (r.count !== 1) {
      const e = await tx.entry.findUnique({ where: { id }, select: { verifierId: true, status: true } });
      if (!e || e.verifierId !== verifierId) throw new HttpError(404, "Entry not found.", "NOT_FOUND");
      throw new HttpError(409, `This entry is already ${e.status}.`, "ALREADY_VERIFIED");
    }
    const e = await tx.entry.findUniqueOrThrow({ where: { id }, include: { deo: { select: { id: true, email: true } } } });
    await tx.verification.create({ data: { entryId: id, verifierId, deoId: e.deoId, decision: v.decision, reason, rate: verifierRate } });
    return e;
  });

  await audit(req, v.decision === "approved" ? "entry.approved" : "entry.rejected", verifierId, { entryId: id, deoId: entry.deoId });
  if (v.decision === "rejected") {
    // In-app only: a rejection needs action, but an e-mail for every entry would be too much.
    await notify(entry.deo, {
      title: "Entry rejected – please correct",
      body: `${id} (${entry.schoolName}) was rejected: ${reason}`,
      link: `/deo/entries/${id}`,
    });
  }
  return { entry: toPublicEntry(entry), rate: verifierRate };
}

/** Approve / reject history of this verifier (newest first). */
export async function verifierHistory(verifierId: string, decision?: string) {
  const rows = await prisma().verification.findMany({
    where: { verifierId, ...(decision === "approved" || decision === "rejected" ? { decision } : {}) },
    orderBy: { createdAt: "desc" },
    take: 2000,
    include: { entry: { select: { id: true, udiseCode: true, schoolName: true, pincode: true, status: true, deo: { select: { id: true, name: true } } } } },
  });
  return rows.map((r) => ({
    id: r.id,
    decision: r.decision,
    reason: r.reason,
    rate: r.rate,
    createdAt: r.createdAt,
    entry: { id: r.entry.id, udiseCode: r.entry.udiseCode, schoolName: r.entry.schoolName, pincode: r.entry.pincode, currentStatus: r.entry.status },
    deo: r.entry.deo,
  }));
}
