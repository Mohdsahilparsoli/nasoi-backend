import type { Request } from "express";
import { prisma } from "../../db.js";
import { Prisma, type Entry } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { HttpError, fieldError } from "../../lib/http.js";
import { FORMS, RECORD_LABEL, recordSchema, type RecordType } from "./forms.js";

/** Entries that count towards an assignment's target (rejected ones do not, until resubmitted). */
const COUNTED = ["pending", "approved"] as const;

export const asRecordType = (t: string): RecordType => (t === "college" ? "college" : "school");

export function toPublicEntry(e: Entry) {
  return {
    id: e.id,
    assignmentId: e.assignmentId,
    deoId: e.deoId,
    recordType: asRecordType(e.recordType),
    code: e.recordCode,
    name: e.recordName,
    area: { state: e.state, district: e.district, pincode: e.pincode },
    data: (e.data ?? {}) as Record<string, string | number>,
    // ratePerEntry is never sent to DEOs or verifiers – only the admin sees rates.
    status: e.status,
    rejectReason: e.rejectReason,
    verifiedAt: e.verifiedAt,
    resubmitCount: e.resubmitCount,
    submittedAt: e.submittedAt,
    updatedAt: e.updatedAt,
  };
}

/** Validates the form for this record type and returns the columns to store. */
export function parseRecord(type: RecordType, body: unknown) {
  const data = recordSchema(type).parse(body ?? {});
  const form = FORMS[type];
  return { recordType: type, recordCode: String(data[form.codeField]), recordName: String(data[form.nameField]), data };
}

/** UDISE / AISHE code is unique across the portal: one school or college is entered only once. */
async function assertCodeFree(tx: Prisma.TransactionClient, type: RecordType, code: string, deoId: string, exceptId?: string) {
  const other = await tx.entry.findUnique({ where: { recordCode: code }, select: { id: true, deoId: true } });
  if (other && other.id !== exceptId) {
    const form = FORMS[type];
    const label = form.fields.find((f) => f.key === form.codeField)!.label;
    throw fieldError(
      409,
      "DUPLICATE_CODE",
      form.codeField,
      other.deoId === deoId
        ? `You have already entered this ${RECORD_LABEL[type].toLowerCase()} (${label} ${code}) as ${other.id}.`
        : `This ${RECORD_LABEL[type].toLowerCase()} (${label} ${code}) has already been entered on the portal.`,
    );
  }
}

async function assertBelowTarget(tx: Prisma.TransactionClient, a: { id: string; target: number }) {
  const done = await tx.entry.count({ where: { assignmentId: a.id, status: { in: [...COUNTED] } } });
  if (done >= a.target) {
    throw new HttpError(409, `Target reached: ${done} of ${a.target} entries already submitted for ${a.id}.`, "TARGET_REACHED");
  }
}

const isActiveVerifier = async (tx: Prisma.TransactionClient, id?: string | null) => {
  if (!id) return false;
  const v = await tx.user.findUnique({ where: { id }, select: { role: true, status: true } });
  return v?.role === "verifier" && v.status === "active";
};

/**
 * Which verifier gets an entry: the verifier the admin chose for the area. If
 * none was chosen (older work) or that verifier is blocked, the active
 * verifier with the fewest pending entries. Null when no verifier exists yet –
 * such entries are picked up by the first verifier who opens the queue.
 */
export async function pickVerifier(tx: Prisma.TransactionClient, preferred?: (string | null)[]): Promise<string | null> {
  for (const id of preferred ?? []) if (await isActiveVerifier(tx, id)) return id!;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    select u.id from users u
    where u.role = 'verifier' and u.status = 'active'
    order by (select count(*) from entries e where e.verifier_id = u.id and e.status = 'pending'),
             (select count(*) from entries e where e.verifier_id = u.id),
             u.id
    limit 1`;
  return rows[0]?.id ?? null;
}

const lockAssignment = (tx: Prisma.TransactionClient, id: string) => tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${"entry:asg:" + id}))`;

const isCodeConflict = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && JSON.stringify(err.meta ?? {}).includes("record_code");

const conflictError = (type: RecordType) =>
  fieldError(409, "DUPLICATE_CODE", FORMS[type].codeField, `This ${RECORD_LABEL[type].toLowerCase()} has already been entered on the portal.`);

/** POST /me/entries – always goes into the DEO's current (active) assignment, using that work's form. */
export async function createEntry(req: Request, deoId: string, body: unknown) {
  const a = await prisma().assignment.findFirst({ where: { deoId, status: "active" } });
  if (!a) throw new HttpError(409, "You have no active work. Entries can be added only for work assigned to you.", "NO_ACTIVE_WORK");
  const type = asRecordType(a.recordType);
  const rec = parseRecord(type, body);
  try {
    const entry = await prisma().$transaction(
      async (tx) => {
        await lockAssignment(tx, a.id);
        const fresh = await tx.assignment.findUnique({ where: { id: a.id }, select: { status: true } });
        if (fresh?.status !== "active") throw new HttpError(409, "This work has just been closed by the admin.", "WORK_CLOSED");
        await assertCodeFree(tx, type, rec.recordCode, deoId);
        await assertBelowTarget(tx, a);

        const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
          insert into id_counters (key, value) values ('entry', 1)
          on conflict (key) do update set value = id_counters.value + 1
          returning value`;
        const verifierId = await pickVerifier(tx, [a.verifierId]);
        return tx.entry.create({
          data: {
            id: `ENT${String(value).padStart(6, "0")}`,
            verifierId,
            assignedAt: verifierId ? new Date() : null,
            assignmentId: a.id,
            deoId,
            state: a.state,
            district: a.district,
            pincode: a.pincode,
            ratePerEntry: a.ratePerEntry,
            ...rec,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
    );
    await audit(req, "entry.created", deoId, { entryId: entry.id, assignmentId: entry.assignmentId });
    return toPublicEntry(entry);
  } catch (err) {
    if (isCodeConflict(err)) throw conflictError(type);
    throw err;
  }
}

/**
 * PATCH /me/entries/:id – a pending entry can be corrected; a rejected entry is
 * corrected and goes back to "pending" (resubmitted). Approved entries are final.
 */
export async function updateEntry(req: Request, deoId: string, id: string, body: unknown) {
  const current = await prisma().entry.findUnique({ where: { id }, select: { deoId: true, recordType: true } });
  if (!current || current.deoId !== deoId) throw new HttpError(404, "Entry not found.", "NOT_FOUND");
  const type = asRecordType(current.recordType);
  const rec = parseRecord(type, body);
  try {
    const { entry, resubmitted } = await prisma().$transaction(
      async (tx) => {
        const e = await tx.entry.findUnique({ where: { id }, include: { assignment: { select: { id: true, status: true, target: true, verifierId: true } } } });
        if (!e || e.deoId !== deoId) throw new HttpError(404, "Entry not found.", "NOT_FOUND");
        if (e.status === "approved") throw new HttpError(409, "Approved entries cannot be changed.", "ENTRY_FINAL");
        if (e.assignment.status !== "active") throw new HttpError(409, `Work ${e.assignmentId} is closed, so its entries cannot be changed.`, "WORK_CLOSED");
        await lockAssignment(tx, e.assignmentId);
        const resubmit = e.status === "rejected";
        await assertCodeFree(tx, type, rec.recordCode, deoId, e.id);
        if (resubmit) await assertBelowTarget(tx, e.assignment);
        // A resubmitted entry goes back to the area's verifier (normally the one who rejected it).
        const verifierId = resubmit ? await pickVerifier(tx, [e.assignment.verifierId, e.verifierId]) : e.verifierId;
        const updated = await tx.entry.update({
          where: { id },
          data: {
            recordCode: rec.recordCode,
            recordName: rec.recordName,
            data: rec.data,
            ...(resubmit
              ? {
                  status: "pending",
                  verifiedAt: null,
                  verifiedById: null,
                  verifierId,
                  assignedAt: verifierId !== e.verifierId ? new Date() : e.assignedAt,
                  resubmitCount: { increment: 1 },
                  submittedAt: new Date(),
                }
              : {}),
          },
        });
        return { entry: updated, resubmitted: resubmit };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
    );
    await audit(req, resubmitted ? "entry.resubmitted" : "entry.updated", deoId, { entryId: id });
    return toPublicEntry(entry);
  } catch (err) {
    if (isCodeConflict(err)) throw conflictError(type);
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
      { recordCode: { startsWith: q.toUpperCase() } },
      { recordName: { contains: q, mode: "insensitive" } },
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

type Counts = { total: number; pending: number; approved: number; rejected: number; earnings: number };
const zero = (): Counts => ({ total: 0, pending: 0, approved: 0, rejected: 0, earnings: 0 });

/**
 * GET /me/summary – dashboard numbers from the database: totals, earnings
 * (total only – the per-entry rate is not shown), month-wise history (IST) and progress of the current work.
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
