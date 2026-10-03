import type { Request, Response } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { FORMS, RECORD_LABEL, type FieldDef, type RecordType } from "../entries/forms.js";

/* ------------------------------------------------------------------ */
/* Filters (shared by the list and the export)                         */
/* ------------------------------------------------------------------ */

const id = (re: RegExp, msg: string) => z.string().trim().toUpperCase().regex(re, msg).optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date").optional();

export const entryFilterSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "all"]).optional(),
  recordType: z.enum(["school", "college"]).optional(),
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
  if (f.recordType) w.recordType = f.recordType;
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
          { recordCode: { startsWith: f.q.toUpperCase() } },
          { recordName: { contains: f.q, mode: "insensitive" } },
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
      recordType: e.recordType,
      code: e.recordCode,
      name: e.recordName,
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
  const [pins, deos, verifiers, assignments, districts, services, total, types] = await Promise.all([
    db.entry.groupBy({ by: ["pincode"], where, _count: { _all: true }, orderBy: { pincode: "asc" } }),
    db.entry.groupBy({ by: ["deoId"], where, _count: { _all: true }, orderBy: { deoId: "asc" } }),
    db.entry.groupBy({ by: ["verifiedById"], where, _count: { _all: true }, orderBy: { verifiedById: "asc" } }),
    db.entry.groupBy({ by: ["assignmentId"], where, _count: { _all: true }, orderBy: { assignmentId: "asc" } }),
    db.entry.groupBy({ by: ["state", "district"], where, _count: { _all: true }, orderBy: [{ state: "asc" }, { district: "asc" }] }),
    db.$queryRaw<{ task_type: string; n: bigint }[]>`
      select a.task_type, count(*) as n from entries e join assignments a on a.id = e.assignment_id
      where e.status = 'approved' group by 1 order by 1`,
    db.entry.count({ where }),
    db.entry.groupBy({ by: ["recordType"], where, _count: { _all: true } }),
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
    recordTypes: types.map((t) => ({ value: t.recordType, label: RECORD_LABEL[t.recordType as RecordType] ?? t.recordType, count: t._count._all })),
  };
}

/* ------------------------------------------------------------------ */
/* Export (approved entries only) – CSV or Excel, streamed in batches   */
/* ------------------------------------------------------------------ */

type Row = Prisma.EntryGetPayload<{ include: typeof include }>;

const fmt = (d: Date | null) =>
  d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short", hour12: false }).format(d) : "";

type Column = { header: string; width: number; get: (e: Row) => string | number };

const val = (e: Row, k: string) => {
  const v = (e.data as Record<string, string | number> | null)?.[k];
  return v === undefined || v === null ? "" : v;
};

/** Columns before the form fields. */
const LEAD: Column[] = [
  { header: "Entry ID", width: 12, get: (e) => e.id },
  { header: "Assignment ID", width: 17, get: (e) => e.assignmentId },
  { header: "Service", width: 22, get: (e) => e.assignment.taskType },
  { header: "Record Type", width: 10, get: (e) => RECORD_LABEL[e.recordType as RecordType] ?? e.recordType },
  { header: "State", width: 16, get: (e) => e.state },
  { header: "Educational District", width: 20, get: (e) => e.district },
  { header: "Pincode", width: 9, get: (e) => e.pincode },
];
/** Columns after the form fields. */
const TAIL: Column[] = [
  { header: "DEO ID", width: 10, get: (e) => e.deoId },
  { header: "DEO Name", width: 20, get: (e) => e.deo.name },
  { header: "Verifier ID", width: 10, get: (e) => e.verifiedBy?.id ?? "" },
  { header: "Verifier Name", width: 20, get: (e) => e.verifiedBy?.name ?? "" },
  { header: "Submitted On", width: 17, get: (e) => fmt(e.submittedAt) },
  { header: "Approved On", width: 17, get: (e) => fmt(e.verifiedAt) },
];
const fieldColumn = (f: FieldDef): Column => ({
  header: f.label,
  width: Math.min(40, Math.max(10, f.label.length + 2, f.kind === "text" ? 18 : 0)),
  get: (e) => val(e, f.key),
});

/** Columns for one record type, or for all types together (union of fields, de-duplicated by key). */
function columnsFor(types: RecordType[]): Column[] {
  const seen = new Set<string>();
  const fields: FieldDef[] = [];
  for (const t of types) for (const f of FORMS[t].fields) if (!seen.has(f.key)) { seen.add(f.key); fields.push(f); }
  return [...LEAD, ...fields.map(fieldColumn), ...TAIL];
}

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
  for (const v of [f.recordType && `${f.recordType}s`, f.pincode && `pin-${f.pincode}`, f.deoId, f.verifierId, f.assignmentId, f.district, f.from && `from-${f.from}`, f.to && `to-${f.to}`]) {
    if (v) parts.push(String(v).toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
  }
  parts.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  return `${parts.join("_")}.${ext}`;
}

export async function exportApproved(req: Request, res: Response, adminId: string, f: EntryFilter, format: "csv" | "xlsx") {
  const where = buildWhere({ ...f, status: "approved" }, "verifiedAt");
  const types: RecordType[] = f.recordType ? [f.recordType] : ["school", "college"];
  const name = fileName(f, format);
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  let count = 0;

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    // BOM so Excel opens Hindi / special characters correctly.
    // One CSV: the chosen type's columns, or all fields of both types when exporting everything.
    const cols = columnsFor(types);
    res.write("\uFEFF" + ["S.No", ...cols.map((c) => c.header)].map(csvCell).join(",") + "\r\n");
    for await (const rows of approvedBatches(where)) {
      res.write(rows.map((e) => [++count, ...cols.map((c) => c.get(e))].map(csvCell).join(",")).join("\r\n") + "\r\n");
    }
    res.end();
  } else {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    wb.creator = "NASOI";
    // Excel: one sheet per record type (Schools / Colleges), each with its own columns.
    for (const t of types) {
      const cols = columnsFor([t]);
      const ws = wb.addWorksheet(t === "school" ? "Schools" : "Colleges", { views: [{ state: "frozen", ySplit: 1 }] });
      ws.columns = [{ header: "S.No", key: "sno", width: 6 }, ...cols.map((c, i) => ({ header: c.header, key: `c${i}`, width: c.width }))];
      const head = ws.getRow(1);
      head.font = { bold: true, color: { argb: "FFFFFFFF" } };
      head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C3F94" } };
      head.commit();
      let n = 0;
      for await (const rows of approvedBatches({ ...where, recordType: t })) {
        for (const e of rows) {
          count++;
          // Codes are written as text so leading zeros (UDISE, PIN) are kept.
          ws.addRow([++n, ...cols.map((c) => safeText(c.get(e)))]).commit();
        }
      }
      ws.commit();
    }
    await wb.commit();
  }
  await audit(req, "entries.exported", adminId, { format, count, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v)])) });
}
