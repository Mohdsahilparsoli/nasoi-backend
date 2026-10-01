import type { Request, Response } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";

/* ------------------------------------------------------------------ */
/* Filters (shared by the list and the export)                         */
/* ------------------------------------------------------------------ */

const id = (re: RegExp, msg: string) => z.string().trim().toUpperCase().regex(re, msg).optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date").optional();

export const entryFilterSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "all"]).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/, "PIN code must be 6 digits").optional(),
  deoId: id(/^DEO\d+$/, "Invalid DEO ID"),
  verifierId: id(/^VR\d+$/, "Invalid Verifier ID"),
  assignmentId: id(/^ASG-\d{6}-\d+$/, "Invalid assignment ID"),
  taskType: z.string().trim().max(100).optional(),
  state: z.string().trim().max(60).optional(),
  district: z.string().trim().max(60).optional(),
  /** Approved between (export) / submitted between (list) – India dates, inclusive. */
  from: date,
  to: date,
  q: z.string().trim().max(60).optional(),
});
export type EntryFilter = z.infer<typeof entryFilterSchema>;

/** Query-string → filter (empty strings are ignored). */
export function parseFilter(query: Record<string, unknown>) {
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
  return entryFilterSchema.parse(clean);
}

const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`);
const istEnd = (d: string) => new Date(new Date(`${d}T00:00:00+05:30`).getTime() + 86_400_000);

function buildWhere(f: EntryFilter, dateField: "verifiedAt" | "submittedAt"): Prisma.EntryWhereInput {
  const w: Prisma.EntryWhereInput = {};
  if (f.status && f.status !== "all") w.status = f.status;
  if (f.pincode) w.pincode = f.pincode;
  if (f.deoId) w.deoId = f.deoId;
  // A verifier "owns" an approved entry if they approved it; otherwise the one it is assigned to.
  if (f.verifierId) w.OR = [{ verifiedById: f.verifierId }, { verifiedById: null, verifierId: f.verifierId }];
  if (f.assignmentId) w.assignmentId = f.assignmentId;
  if (f.taskType) w.assignment = { taskType: f.taskType };
  if (f.state) w.state = f.state;
  if (f.district) w.district = f.district;
  if (f.from || f.to) w[dateField] = { ...(f.from ? { gte: istStart(f.from) } : {}), ...(f.to ? { lt: istEnd(f.to) } : {}) };
  if (f.q) {
    w.AND = [
      {
        OR: [
          { id: { contains: f.q, mode: "insensitive" } },
          { udiseCode: { startsWith: f.q } },
          { schoolName: { contains: f.q, mode: "insensitive" } },
        ],
      },
    ];
  }
  return w;
}

const include = {
  deo: { select: { id: true, name: true } },
  verifier: { select: { id: true, name: true } },
  verifiedBy: { select: { id: true, name: true } },
  assignment: { select: { taskType: true } },
} satisfies Prisma.EntryInclude;

/* ------------------------------------------------------------------ */
/* Admin list (with rates – admin only)                                */
/* ------------------------------------------------------------------ */

export async function listAdminEntries(f: EntryFilter) {
  const db = prisma();
  const where = buildWhere(f, "submittedAt");
  const [rows, total, byStatus] = await Promise.all([
    db.entry.findMany({ where, include, orderBy: { submittedAt: "desc" }, take: 1000 }),
    db.entry.count({ where }),
    db.entry.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const count = (s: string) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
  return {
    total,
    counts: { all: count("pending") + count("approved") + count("rejected"), pending: count("pending"), approved: count("approved"), rejected: count("rejected") },
    entries: rows.map((e) => ({
      id: e.id,
      assignmentId: e.assignmentId,
      taskType: e.assignment.taskType,
      area: { state: e.state, district: e.district, pincode: e.pincode },
      udiseCode: e.udiseCode,
      schoolName: e.schoolName,
      lgdVillage: e.lgdVillage,
      status: e.status,
      rejectReason: e.rejectReason,
      deo: e.deo,
      verifier: e.verifiedBy ?? e.verifier,
      ratePerEntry: e.ratePerEntry,
      submittedAt: e.submittedAt,
      verifiedAt: e.verifiedAt,
    })),
  };
}

/** Values for the export filter dropdowns (from approved entries only). */
export async function exportOptions() {
  const db = prisma();
  const where = { status: "approved" as const };
  const [pins, deos, verifiers, assignments, districts, services, total] = await Promise.all([
    db.entry.groupBy({ by: ["pincode"], where, _count: { _all: true }, orderBy: { pincode: "asc" } }),
    db.entry.groupBy({ by: ["deoId"], where, _count: { _all: true }, orderBy: { deoId: "asc" } }),
    db.entry.groupBy({ by: ["verifiedById"], where, _count: { _all: true }, orderBy: { verifiedById: "asc" } }),
    db.entry.groupBy({ by: ["assignmentId"], where, _count: { _all: true }, orderBy: { assignmentId: "asc" } }),
    db.entry.groupBy({ by: ["state", "district"], where, _count: { _all: true }, orderBy: [{ state: "asc" }, { district: "asc" }] }),
    db.$queryRaw<{ task_type: string; n: bigint }[]>`
      select a.task_type, count(*) as n from entries e join assignments a on a.id = e.assignment_id
      where e.status = 'approved' group by 1 order by 1`,
    db.entry.count({ where }),
  ]);
  const ids = [...deos.map((d) => d.deoId), ...verifiers.map((v) => v.verifiedById).filter(Boolean)] as string[];
  const names = new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return {
    totalApproved: total,
    pincodes: pins.map((p) => ({ value: p.pincode, count: p._count._all })),
    deos: deos.map((d) => ({ value: d.deoId, label: `${d.deoId} – ${names.get(d.deoId) ?? ""}`, count: d._count._all })),
    verifiers: verifiers.filter((v) => v.verifiedById).map((v) => ({ value: v.verifiedById!, label: `${v.verifiedById} – ${names.get(v.verifiedById!) ?? ""}`, count: v._count._all })),
    assignments: assignments.map((a) => ({ value: a.assignmentId, count: a._count._all })),
    districts: districts.map((d) => ({ state: d.state, district: d.district, count: d._count._all })),
    services: services.map((s) => ({ value: s.task_type, count: Number(s.n) })),
  };
}

/* ------------------------------------------------------------------ */
/* Export (approved entries only) – CSV or Excel, streamed in batches   */
/* ------------------------------------------------------------------ */

type Row = Prisma.EntryGetPayload<{ include: typeof include }>;

const fmt = (d: Date | null) =>
  d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short", hour12: false }).format(d) : "";

const COLUMNS: { header: string; width: number; get: (e: Row) => string | number }[] = [
  { header: "Entry ID", width: 12, get: (e) => e.id },
  { header: "Assignment ID", width: 17, get: (e) => e.assignmentId },
  { header: "Service", width: 28, get: (e) => e.assignment.taskType },
  { header: "State", width: 16, get: (e) => e.state },
  { header: "Educational District", width: 20, get: (e) => e.district },
  { header: "Pincode", width: 9, get: (e) => e.pincode },
  { header: "UDISE Code", width: 14, get: (e) => e.udiseCode },
  { header: "School Name", width: 36, get: (e) => e.schoolName },
  { header: "Educational Block", width: 18, get: (e) => e.educationalBlock },
  { header: "Rural / Urban", width: 10, get: (e) => e.ruralUrban },
  { header: "Cluster", width: 16, get: (e) => e.cluster },
  { header: "LGD Block", width: 16, get: (e) => e.lgdBlock },
  { header: "LGD Panchayat", width: 16, get: (e) => e.lgdPanchayat },
  { header: "LGD Village", width: 16, get: (e) => e.lgdVillage },
  { header: "School Category", width: 30, get: (e) => e.schoolCategory },
  { header: "School Management", width: 28, get: (e) => e.schoolManagement },
  { header: "Year of Establishment", width: 12, get: (e) => e.yearEstablished },
  { header: "Year of Recognition - Pri.", width: 12, get: (e) => e.yearRecognitionPri ?? "Not recognised" },
  { header: "School Type", width: 14, get: (e) => e.schoolType },
  { header: "DEO ID", width: 10, get: (e) => e.deoId },
  { header: "DEO Name", width: 20, get: (e) => e.deo.name },
  { header: "Verifier ID", width: 10, get: (e) => e.verifiedBy?.id ?? "" },
  { header: "Verifier Name", width: 20, get: (e) => e.verifiedBy?.name ?? "" },
  { header: "Submitted On", width: 17, get: (e) => fmt(e.submittedAt) },
  { header: "Approved On", width: 17, get: (e) => fmt(e.verifiedAt) },
];

/** Stops spreadsheet apps from treating a cell as a formula (CSV injection). */
const safeText = (v: string | number) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const csvCell = (v: string | number) => {
  const s = String(safeText(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function* approvedBatches(where: Prisma.EntryWhereInput) {
  let cursor: string | undefined;
  for (;;) {
    const rows: Row[] = await prisma().entry.findMany({
      where,
      include,
      orderBy: { id: "asc" },
      take: 2000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) return;
    yield rows;
    cursor = rows[rows.length - 1].id;
    if (rows.length < 2000) return;
  }
}

function fileName(f: EntryFilter, ext: string) {
  const parts = ["nasoi-approved-entries"];
  for (const v of [f.pincode && `pin-${f.pincode}`, f.deoId, f.verifierId, f.assignmentId, f.district, f.from && `from-${f.from}`, f.to && `to-${f.to}`]) {
    if (v) parts.push(String(v).toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
  }
  parts.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  return `${parts.join("_")}.${ext}`;
}

export async function exportApproved(req: Request, res: Response, adminId: string, f: EntryFilter, format: "csv" | "xlsx") {
  const where = buildWhere({ ...f, status: "approved" }, "verifiedAt");
  const name = fileName(f, format);
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  let count = 0;

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    // BOM so Excel opens Hindi / special characters correctly.
    res.write("﻿" + ["S.No", ...COLUMNS.map((c) => c.header)].map(csvCell).join(",") + "\r\n");
    for await (const rows of approvedBatches(where)) {
      res.write(rows.map((e) => [++count, ...COLUMNS.map((c) => c.get(e))].map(csvCell).join(",")).join("\r\n") + "\r\n");
    }
    res.end();
  } else {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    wb.creator = "NASOI";
    const ws = wb.addWorksheet("Approved Entries", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [{ header: "S.No", key: "sno", width: 6 }, ...COLUMNS.map((c, i) => ({ header: c.header, key: `c${i}`, width: c.width }))];
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C3F94" } };
    head.commit();
    for await (const rows of approvedBatches(where)) {
      for (const e of rows) {
        // Codes are written as text so leading zeros (UDISE, PIN) are kept.
        ws.addRow([++count, ...COLUMNS.map((c) => safeText(c.get(e)))]).commit();
      }
    }
    ws.commit();
    await wb.commit();
  }
  await audit(req, "entries.exported", adminId, { format, count, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v)])) });
}
