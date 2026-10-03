import type { Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { HttpError } from "../../lib/http.js";
import { notify } from "../../lib/notify.js";
import { getSettings } from "../../lib/settings.js";
import { personCards } from "../../lib/people.js";
import { withProgress } from "../assignments/service.js";
import { FORMS } from "../entries/forms.js";
import { asRecordType, toPublicEntry } from "../entries/service.js";

export const decisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"], { error: "Choose approve or reject" }),
    reason: z.string().trim().max(3000, "Reason is too long (max 3000 characters)").optional(),
    /** Form field keys the verifier marked wrong (one by one or all). */
    fields: z.array(z.string().max(60)).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "rejected" && (v.reason ?? "").length < 5) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Write a clear reason for rejection (at least 5 characters)" });
    }
  });

const withContext = {
  assignment: { select: { id: true, taskType: true, recordType: true, village: true, block: true } },
} satisfies Prisma.EntryInclude;

type EntryWithContext = Prisma.EntryGetPayload<{ include: typeof withContext }>;

/** Adds the DEO's basic card (ID, name, mobile, photo) and the work area to each entry. */
async function toVerifierEntries(rows: EntryWithContext[]) {
  const cards = await personCards(rows.map((e) => e.deoId));
  return rows.map((e) => ({
    ...toPublicEntry(e),
    deo: cards.get(e.deoId) ?? { id: e.deoId, name: e.deoId, mobile: null, hasPhoto: false, meetingLink: null, platform: null },
    assignment: e.assignment,
    verifierId: e.verifierId,
    assignedAt: e.assignedAt,
  }));
}

/**
 * Pending entries that have no verifier yet (they were submitted before any
 * verifier existed) are handed to the verifier who opens the portal.
 */
export async function claimOrphans(verifierId: string) {
  await prisma().$executeRaw`
    update entries set verifier_id = ${verifierId}, assigned_at = now()
    where id in (
      select e.id from entries e join assignments a on a.id = e.assignment_id
      where e.status = 'pending' and e.verifier_id is null
        and (a.verifier_id is null or a.verifier_id = ${verifierId})
      order by e.submitted_at limit 200 for update of e skip locked)`;
}

/** Dashboard cards + month-wise income (IST). Totals only – the per-entry rate is not shown to verifiers. */
export async function verifierSummary(verifierId: string) {
  await claimOrphans(verifierId);
  const db = prisma();
  const [assigned, pending, decisions, monthly] = await Promise.all([
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
  return toVerifierEntries(rows);
}

export async function verifierEntry(verifierId: string, id: string) {
  const e = await prisma().entry.findUnique({ where: { id }, include: withContext });
  const decidedByMe = e && (await prisma().verification.count({ where: { entryId: id, verifierId } })) > 0;
  if (!e || (e.verifierId !== verifierId && !decidedByMe)) throw new HttpError(404, "Entry not found.", "NOT_FOUND");
  const history = await prisma().verification.findMany({ where: { entryId: id }, orderBy: { createdAt: "asc" }, select: { decision: true, reason: true, fields: true, createdAt: true, verifierId: true } });
  const [entry] = await toVerifierEntries([e]);
  return { ...entry, history };
}

/** Approve or reject a pending entry assigned to this verifier. */
export async function decide(req: Request, verifierId: string, id: string, v: z.infer<typeof decisionSchema>) {
  const reason = v.decision === "rejected" ? v.reason! : null;
  // Only real fields of this entry's form are kept (in form order).
  const current = await prisma().entry.findUnique({ where: { id }, select: { recordType: true } });
  const formKeys = FORMS[asRecordType(current?.recordType ?? "school")].fields.map((f) => f.key);
  const marked = v.decision === "rejected" ? formKeys.filter((k) => v.fields?.includes(k)) : [];
  const fields = marked.length ? marked : Prisma.DbNull;
  const entry = await prisma().$transaction(async (tx) => {
    const now = new Date();
    // Only one decision can win, even if the verifier double-clicks or two tabs are open.
    const r = await tx.entry.updateMany({
      where: { id, verifierId, status: "pending" },
      data: { status: v.decision, rejectReason: reason, rejectFields: fields, verifiedById: verifierId, verifiedAt: now },
    });
    if (r.count !== 1) {
      const e = await tx.entry.findUnique({ where: { id }, select: { verifierId: true, status: true } });
      if (!e || e.verifierId !== verifierId) throw new HttpError(404, "Entry not found.", "NOT_FOUND");
      throw new HttpError(409, `This entry is already ${e.status}.`, "ALREADY_VERIFIED");
    }
    const e = await tx.entry.findUniqueOrThrow({ where: { id }, include: { deo: { select: { id: true, email: true } }, assignment: { select: { verifierRate: true } } } });
    // Money is earned only when the entry is finally APPROVED: the verifier gets the area's rate
    // (default in Settings) and the DEO gets the work's rate. A rejection earns nothing.
    const rate = v.decision === "approved" ? (e.assignment.verifierRate ?? (await getSettings()).verifierRate) : 0;
    await tx.verification.create({ data: { entryId: id, verifierId, deoId: e.deoId, decision: v.decision, reason, fields, rate } });
    return e;
  });

  await audit(req, v.decision === "approved" ? "entry.approved" : "entry.rejected", verifierId, { entryId: id, deoId: entry.deoId });
  if (v.decision === "rejected") {
    // In-app only: a rejection needs action, but an e-mail for every entry would be too much.
    await notify(entry.deo, {
      title: "Entry rejected – please correct",
      body: `${id} (${entry.recordName}) was rejected: ${(reason ?? "").slice(0, 300)}`,
      link: `/deo/entries/${id}`,
    });
  }
  return { entry: toPublicEntry(entry) };
}

/** Approve / reject history of this verifier (newest first). */
export async function verifierHistory(verifierId: string, decision?: string) {
  const rows = await prisma().verification.findMany({
    where: { verifierId, ...(decision === "approved" || decision === "rejected" ? { decision } : {}) },
    orderBy: { createdAt: "desc" },
    take: 2000,
    include: { entry: { select: { id: true, recordType: true, recordCode: true, recordName: true, pincode: true, status: true, deo: { select: { id: true, name: true } } } } },
  });
  return rows.map((r) => ({
    id: r.id,
    decision: r.decision,
    reason: r.reason,
    createdAt: r.createdAt,
    entry: { id: r.entry.id, recordType: r.entry.recordType, code: r.entry.recordCode, name: r.entry.recordName, pincode: r.entry.pincode, currentStatus: r.entry.status },
    deo: r.entry.deo,
  }));
}

/** GET /verifier/areas – work areas the admin assigned to this verifier, with the DEO's card and progress. */
export async function verifierAreas(verifierId: string) {
  const rows = await prisma().assignment.findMany({
    where: { verifierId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
  const cards = await personCards(rows.map((a) => a.deoId));
  const withP = await withProgress(rows.map((a) => ({ id: a.id })));
  return rows.map((a, i) => ({
    id: a.id,
    taskType: a.taskType,
    recordType: a.recordType,
    target: a.target,
    area: { state: a.state, district: a.district, block: a.block, village: a.village, pincode: a.pincode },
    deadline: a.deadline.toISOString().slice(0, 10),
    status: a.status,
    deo: cards.get(a.deoId) ?? { id: a.deoId, name: a.deoId, mobile: null, hasPhoto: false, meetingLink: null, platform: null },
    progress: withP[i].progress,
  }));
}
