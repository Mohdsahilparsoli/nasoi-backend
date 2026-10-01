import type { Request } from "express";
import { prisma } from "../../db.js";
import { Prisma, type Assignment } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { HttpError } from "../../lib/http.js";
import { assignmentEmail } from "../../lib/mailer.js";
import { notify } from "../../lib/notify.js";
import { progressFor } from "../entries/service.js";
import type { CreateAssignmentInput } from "./schema.js";

/** Public shape sent to the browser. */
type Progress = { submitted: number; approved: number; rejected: number };

/** Adds entry progress (submitted / approved / rejected) to each assignment. */
export async function withProgress<T extends { id: string }>(list: T[]): Promise<(T & { progress: Progress })[]> {
  const map = await progressFor(list.map((a) => a.id));
  return list.map((a) => ({ ...a, progress: map.get(a.id)! }));
}

export function toPublicAssignment(a: Assignment & { deo?: { id: string; name: string; mobile: string | null } }) {
  return {
    id: a.id,
    deoId: a.deoId,
    deo: a.deo ? { id: a.deo.id, name: a.deo.name, mobile: a.deo.mobile } : undefined,
    taskType: a.taskType,
    target: a.target,
    ratePerEntry: a.ratePerEntry,
    area: { state: a.state, district: a.district, block: a.block, village: a.village, pincode: a.pincode },
    deadline: a.deadline.toISOString().slice(0, 10),
    instructions: a.instructions,
    status: a.status,
    seenAt: a.seenAt,
    completedAt: a.completedAt,
    cancelledAt: a.cancelledAt,
    createdAt: a.createdAt,
  };
}

/**
 * Creates an assignment. Inside one transaction we take advisory locks on the
 * DEO and on the PIN code, so two admins clicking at the same moment cannot
 * break the "one active assignment per DEO / per PIN code" rules.
 */
export async function createAssignment(req: Request, adminId: string, v: CreateAssignmentInput) {
  const db = prisma();
  const result = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${"assign:deo:" + v.deoId}))`;
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${"assign:pin:" + v.pincode}))`;

      const deo = await tx.user.findUnique({ where: { id: v.deoId }, select: { id: true, role: true, status: true, name: true, email: true } });
      if (!deo || deo.role !== "deo") throw new HttpError(404, "Data Entry Operator not found.", "DEO_NOT_FOUND");
      if (deo.status !== "active") throw new HttpError(409, `${deo.id} is blocked. Unblock the operator before assigning work.`, "DEO_BLOCKED");

      const busy = await tx.assignment.findFirst({ where: { deoId: deo.id, status: "active" }, select: { id: true, pincode: true } });
      if (busy) {
        throw new HttpError(
          409,
          `${deo.id} already has active work (${busy.id}, PIN ${busy.pincode}). A new assignment can be given only after it is completed.`,
          "DEO_BUSY",
        );
      }
      const pinTaken = await tx.assignment.findFirst({ where: { pincode: v.pincode, status: "active" }, select: { id: true, deoId: true } });
      if (pinTaken) {
        throw new HttpError(409, `PIN code ${v.pincode} is already assigned to ${pinTaken.deoId} (${pinTaken.id}).`, "PIN_BUSY");
      }

      // Readable ID that carries the PIN code: ASG-250401-001, ASG-250401-002 …
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        insert into id_counters (key, value) values (${"asg:" + v.pincode}, 1)
        on conflict (key) do update set value = id_counters.value + 1
        returning value`;
      const id = `ASG-${v.pincode}-${String(value).padStart(3, "0")}`;

      const a = await tx.assignment.create({
        data: {
          id,
          deoId: deo.id,
          assignedById: adminId,
          taskType: v.taskType,
          target: v.target,
          ratePerEntry: v.ratePerEntry,
          state: v.state,
          district: v.district,
          block: v.block,
          village: v.village,
          pincode: v.pincode,
          deadline: new Date(`${v.deadline}T00:00:00Z`),
          instructions: v.instructions,
        },
      });
      return { a, deo };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
  );

  const { a, deo } = result;
  await audit(req, "assignment.created", adminId, { assignmentId: a.id, deoId: deo.id, pincode: a.pincode });
  const { emailed } = await notify(
    deo,
    {
      title: "New work assigned",
      body: `${a.taskType} for PIN ${a.pincode} (${a.village}, ${a.district}). Target ${a.target} entries, deadline ${a.deadline.toISOString().slice(0, 10)}.`,
      link: "/deo/work",
    },
    assignmentEmail({ ...a, deoName: deo.name }),
  );
  return { assignment: toPublicAssignment(a), emailed };
}

/** Admin marks work completed (DEO becomes eligible again) or cancels it. */
export async function updateAssignmentStatus(req: Request, adminId: string, id: string, status: "completed" | "cancelled") {
  const db = prisma();
  const a = await db.assignment.findUnique({ where: { id }, include: { deo: { select: { id: true, email: true } } } });
  if (!a) throw new HttpError(404, "Assignment not found.", "NOT_FOUND");
  if (a.status !== "active") throw new HttpError(409, `This assignment is already ${a.status}.`, "NOT_ACTIVE");
  const now = new Date();
  const updated = await db.assignment.update({
    where: { id },
    data: status === "completed" ? { status, completedAt: now } : { status, cancelledAt: now },
  });
  await audit(req, status === "completed" ? "assignment.completed" : "assignment.cancelled", adminId, { assignmentId: id, deoId: a.deoId });
  await notify(a.deo, {
    title: status === "completed" ? "Work marked as completed" : "Assignment cancelled",
    body:
      status === "completed"
        ? `${id} (PIN ${a.pincode}) has been marked completed. You are now eligible for new work.`
        : `${id} (PIN ${a.pincode}) has been cancelled by the admin.`,
    link: "/deo/work",
  });
  return toPublicAssignment(updated);
}

export async function listAssignments(filter: { status?: string; deoId?: string; q?: string }) {
  const where: Prisma.AssignmentWhereInput = {};
  if (filter.status === "active" || filter.status === "completed" || filter.status === "cancelled") where.status = filter.status;
  if (filter.deoId) where.deoId = filter.deoId.toUpperCase();
  if (filter.q) {
    const q = filter.q.trim();
    where.OR = [
      { id: { contains: q, mode: "insensitive" } },
      { pincode: { startsWith: q } },
      { deoId: { contains: q, mode: "insensitive" } },
      { village: { contains: q, mode: "insensitive" } },
      { district: { contains: q, mode: "insensitive" } },
    ];
  }
  const rows = await prisma().assignment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { deo: { select: { id: true, name: true, mobile: true } } },
  });
  return withProgress(rows.map(toPublicAssignment));
}

/**
 * DEO view: the current (active) assignment and past ones.
 * With markSeen (the Work Status page) the current assignment is marked as seen;
 * the dashboard and sidebar badge only peek, so they can still show "New".
 */
export async function myAssignments(deoId: string, markSeen = false) {
  const db = prisma();
  const rows = await db.assignment.findMany({ where: { deoId }, orderBy: { createdAt: "desc" }, take: 100 });
  const current = rows.find((r) => r.status === "active") ?? null;
  if (markSeen && current && !current.seenAt) {
    await db.assignment.update({ where: { id: current.id }, data: { seenAt: new Date() } });
    current.seenAt = new Date();
  }
  // The DEO does not see the per-entry rate.
  const all = await withProgress(rows.map((r) => {
    const { ratePerEntry: _r, ...a } = toPublicAssignment(r);
    return a;
  }));
  return {
    current: current ? all.find((a) => a.id === current.id)! : null,
    history: all.filter((a) => a.status !== "active"),
  };
}
