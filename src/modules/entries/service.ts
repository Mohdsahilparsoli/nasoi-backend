import type { Request } from "express";
import { prisma } from "../../db.js";
import { Prisma, type Entry } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { HttpError } from "../../lib/http.js";
import type { EntryInput } from "./schema.js";

/** Entries that count towards an assignment's target (rejected ones do not, until resubmitted). */
const COUNTED = ["pending", "approved"] as const;

export function toPublicEntry(e: Entry) {
  return {
    id: e.id,
    assignmentId: e.assignmentId,
    deoId: e.deoId,
    area: { state: e.state, district: e.district, pincode: e.pincode },
    school: {
      udiseCode: e.udiseCode,
      schoolName: e.schoolName,
      educationalBlock: e.educationalBlock,
      ruralUrban: e.ruralUrban,
      cluster: e.cluster,
      lgdBlock: e.lgdBlock,
      lgdPanchayat: e.lgdPanchayat,
      lgdVillage: e.lgdVillage,
      schoolCategory: e.schoolCategory,
      schoolManagement: e.schoolManagement,
      yearEstablished: e.yearEstablished,
      yearRecognitionPri: e.yearRecognitionPri,
      schoolType: e.schoolType,
    },
    ratePerEntry: e.ratePerEntry,
    status: e.status,
    rejectReason: e.rejectReason,
    verifiedAt: e.verifiedAt,
    resubmitCount: e.resubmitCount,
    submittedAt: e.submittedAt,
    updatedAt: e.updatedAt,
  };
}

const schoolData = (v: EntryInput) => ({
  udiseCode: v.udiseCode,
  schoolName: v.schoolName,
  educationalBlock: v.educationalBlock,
  ruralUrban: v.ruralUrban,
  cluster: v.cluster,
  lgdBlock: v.lgdBlock,
  lgdPanchayat: v.lgdPanchayat,
  lgdVillage: v.lgdVillage,
  schoolCategory: v.schoolCategory,
  schoolManagement: v.schoolManagement,
  yearEstablished: v.yearEstablished,
  yearRecognitionPri: v.yearRecognitionPri ?? null,
  schoolType: v.schoolType,
});

/** UDISE code is unique across the portal: one school is entered only once. */
async function assertUdiseFree(tx: Prisma.TransactionClient, udiseCode: string, deoId: string, exceptId?: string) {
  const other = await tx.entry.findUnique({ where: { udiseCode }, select: { id: true, deoId: true } });
  if (other && other.id !== exceptId) {
    throw new HttpError(
      409,
      other.deoId === deoId
        ? `You have already entered this school (UDISE ${udiseCode}) as ${other.id}.`
        : `This school (UDISE ${udiseCode}) has already been entered on the portal.`,
      "DUPLICATE_UDISE",
    );
  }
}

async function assertBelowTarget(tx: Prisma.TransactionClient, a: { id: string; target: number }) {
  const done = await tx.entry.count({ where: { assignmentId: a.id, status: { in: [...COUNTED] } } });
  if (done >= a.target) {
    throw new HttpError(409, `Target reached: ${done} of ${a.target} entries already submitted for ${a.id}.`, "TARGET_REACHED");
  }
}

const lockAssignment = (tx: Prisma.TransactionClient, id: string) => tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${"entry:asg:" + id}))`;

const isUdiseConflict = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && JSON.stringify(err.meta ?? {}).includes("udise");

/** POST /me/entries – always goes into the DEO's current (active) assignment. */
export async function createEntry(req: Request, deoId: string, v: EntryInput) {
  try {
    const entry = await prisma().$transaction(
      async (tx) => {
        const a = await tx.assignment.findFirst({ where: { deoId, status: "active" } });
        if (!a) throw new HttpError(409, "You have no active work. Entries can be added only for work assigned to you.", "NO_ACTIVE_WORK");
        await lockAssignment(tx, a.id);
        await assertUdiseFree(tx, v.udiseCode, deoId);
        await assertBelowTarget(tx, a);

        const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
          insert into id_counters (key, value) values ('entry', 1)
          on conflict (key) do update set value = id_counters.value + 1
          returning value`;
        return tx.entry.create({
          data: {
            id: `ENT${String(value).padStart(6, "0")}`,
            assignmentId: a.id,
            deoId,
            state: a.state,
            district: a.district,
            pincode: a.pincode,
            ratePerEntry: a.ratePerEntry,
            ...schoolData(v),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
    );
    await audit(req, "entry.created", deoId, { entryId: entry.id, assignmentId: entry.assignmentId });
    return toPublicEntry(entry);
  } catch (err) {
    if (isUdiseConflict(err)) throw new HttpError(409, `This school (UDISE ${v.udiseCode}) has already been entered on the portal.`, "DUPLICATE_UDISE");
    throw err;
  }
}

/**
 * PATCH /me/entries/:id – a pending entry can be corrected; a rejected entry is
 * corrected and goes back to "pending" (resubmitted). Approved entries are final.
 */
export async function updateEntry(req: Request, deoId: string, id: string, v: EntryInput) {
  try {
    const { entry, resubmitted } = await prisma().$transaction(
      async (tx) => {
        const e = await tx.entry.findUnique({ where: { id }, include: { assignment: { select: { id: true, status: true, target: true } } } });
        if (!e || e.deoId !== deoId) throw new HttpError(404, "Entry not found.", "NOT_FOUND");
        if (e.status === "approved") throw new HttpError(409, "Approved entries cannot be changed.", "ENTRY_FINAL");
        if (e.assignment.status !== "active") throw new HttpError(409, `Work ${e.assignmentId} is closed, so its entries cannot be changed.`, "WORK_CLOSED");
        await lockAssignment(tx, e.assignmentId);
        const resubmit = e.status === "rejected";
        await assertUdiseFree(tx, v.udiseCode, deoId, e.id);
        if (resubmit) await assertBelowTarget(tx, e.assignment);
        const updated = await tx.entry.update({
          where: { id },
          data: {
            ...schoolData(v),
            ...(resubmit ? { status: "pending", verifiedAt: null, verifiedById: null, resubmitCount: { increment: 1 }, submittedAt: new Date() } : {}),
          },
        });
        return { entry: updated, resubmitted: resubmit };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
    );
    await audit(req, resubmitted ? "entry.resubmitted" : "entry.updated", deoId, { entryId: id });
    return toPublicEntry(entry);
  } catch (err) {
    if (isUdiseConflict(err)) throw new HttpError(409, `This school (UDISE ${v.udiseCode}) has already been entered on the portal.`, "DUPLICATE_UDISE");
    throw err;
  }
}

export async function listMyEntries(deoId: string, f: { status?: string; q?: string; assignmentId?: string }) {
  const where: Prisma.EntryWhereInput = { deoId };
  if (f.status === "pending" || f.status === "approved" || f.status === "rejected") where.status = f.status;
  if (f.assignmentId) where.assignmentId = f.assignmentId;
  const q = f.q?.trim();
  if (q) {
    where.OR = [
      { id: { contains: q, mode: "insensitive" } },
      { udiseCode: { startsWith: q } },
      { schoolName: { contains: q, mode: "insensitive" } },
      { lgdVillage: { contains: q, mode: "insensitive" } },
    ];
  }
  const rows = await prisma().entry.findMany({ where, orderBy: { submittedAt: "desc" }, take: 2000 });
  return rows.map(toPublicEntry);
}

export async function getMyEntry(deoId: string, id: string) {
  const e = await prisma().entry.findUnique({ where: { id } });
  if (!e || e.deoId !== deoId) throw new HttpError(404, "Entry not found.", "NOT_FOUND");
  return toPublicEntry(e);
}

type Counts = { total: number; pending: number; approved: number; rejected: number; earnings: number; pendingValue: number; rejectedValue: number };
const zero = (): Counts => ({ total: 0, pending: 0, approved: 0, rejected: 0, earnings: 0, pendingValue: 0, rejectedValue: 0 });

/**
 * GET /me/summary – dashboard numbers from the database: totals, earnings
 * (approved × rate), month-wise history (IST) and progress of the current work.
 */
export async function mySummary(deoId: string) {
  const db = prisma();
  const [rows, current] = await Promise.all([
    db.$queryRaw<{ month: string; status: "pending" | "approved" | "rejected"; n: bigint; amount: bigint }[]>`
      select to_char(submitted_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month, status::text as status,
             count(*) as n, coalesce(sum(rate_per_entry), 0) as amount
      from entries where deo_id = ${deoId}
      group by 1, 2`,
    db.assignment.findFirst({ where: { deoId, status: "active" } }),
  ]);

  const totals = zero();
  const months = new Map<string, Counts>();
  for (const r of rows) {
    const n = Number(r.n), amount = Number(r.amount);
    for (const c of [totals, months.get(r.month) ?? months.set(r.month, zero()).get(r.month)!]) {
      c.total += n;
      c[r.status] += n;
      if (r.status === "approved") c.earnings += amount;
      if (r.status === "pending") c.pendingValue += amount;
      if (r.status === "rejected") c.rejectedValue += amount;
    }
  }

  let progress = null;
  if (current) {
    const g = await db.entry.groupBy({ by: ["status"], where: { assignmentId: current.id }, _count: { _all: true } });
    const c = (s: string) => g.find((x) => x.status === s)?._count._all ?? 0;
    progress = {
      assignmentId: current.id,
      target: current.target,
      submitted: c("pending") + c("approved"),
      approved: c("approved"),
      pending: c("pending"),
      rejected: c("rejected"),
    };
  }

  return {
    totals,
    monthly: [...months.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).map(([month, c]) => ({ month, ...c })),
    currentProgress: progress,
  };
}

/** Entry counts per assignment (for admin lists and the DEO's work page). */
export async function progressFor(assignmentIds: string[]) {
  if (!assignmentIds.length) return new Map<string, { submitted: number; approved: number; rejected: number }>();
  const g = await prisma().entry.groupBy({ by: ["assignmentId", "status"], where: { assignmentId: { in: assignmentIds } }, _count: { _all: true } });
  const map = new Map<string, { submitted: number; approved: number; rejected: number }>();
  for (const id of assignmentIds) map.set(id, { submitted: 0, approved: 0, rejected: 0 });
  for (const r of g) {
    const p = map.get(r.assignmentId)!;
    if (r.status !== "rejected") p.submitted += r._count._all;
    if (r.status === "approved") p.approved += r._count._all;
    if (r.status === "rejected") p.rejected += r._count._all;
  }
  return map;
}
