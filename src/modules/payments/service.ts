import type { Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { Prisma, type Payment } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { buildWorkbook, emailFile, XLSX_TYPE, type EmailRequest, type SheetSpec } from "../../lib/files.js";
import { HttpError, fieldError } from "../../lib/http.js";
import { paymentEmail } from "../../lib/mailer.js";
import { notify } from "../../lib/notify.js";

/*
 * Payouts. Earned = DEO: approved entries × the work's DEO amount;
 * verifier: verified entries × the area's verifier amount. Paid = receipts the
 * admin recorded. Balance = earned − paid.
 */

export type PayRole = "deo" | "verifier";
export const PAYMENT_MODES = ["UPI", "NEFT", "IMPS", "RTGS", "Bank Transfer", "Cheque", "Cash"] as const;

const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid date");

export const paymentSchema = z
  .object({
    userId: z.string().trim().min(1, "Select the employee").max(20).transform((v) => v.toUpperCase()),
    amount: z.coerce.number({ error: "Enter the amount" }).int("Enter the amount in whole rupees").min(1, "Amount must be at least ₹1").max(10_000_000, "Amount is too high"),
    transactionId: z
      .string()
      .trim()
      .min(3, "Enter the transaction / UTR / cheque number")
      .max(60, "Transaction ID is too long")
      .regex(/^[A-Za-z0-9][A-Za-z0-9\-/_. ]*$/, "Use letters, numbers, - / _ . only"),
    payeeName: z.string().trim().max(80, "Name is too long").optional(),
    mode: z.enum(PAYMENT_MODES, { error: "Select the payment mode" }),
    paidOn: date.refine((d) => d <= todayIST(), "Payment date cannot be in the future"),
    entriesCount: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int("Whole number").min(0).max(1_000_000).optional()),
    periodFrom: z.preprocess((v) => (v === "" ? undefined : v), date.optional()),
    periodTo: z.preprocess((v) => (v === "" ? undefined : v), date.optional()),
    notes: z.string().trim().max(300, "Notes are too long").optional(),
  })
  .superRefine((v, ctx) => {
    if (v.periodFrom && v.periodTo && v.periodFrom > v.periodTo) ctx.addIssue({ code: "custom", path: ["periodTo"], message: "End date cannot be before start date" });
  });

export function toPublicPayment(p: Payment & { user?: { id: string; name: string } }) {
  return {
    id: p.id,
    userId: p.userId,
    user: p.user ? { id: p.user.id, name: p.user.name } : undefined,
    role: p.role as PayRole,
    amount: p.amount,
    transactionId: p.transactionId,
    payeeName: p.payeeName,
    mode: p.mode,
    paidOn: day(p.paidOn)!,
    entriesCount: p.entriesCount,
    periodFrom: day(p.periodFrom),
    periodTo: day(p.periodTo),
    notes: p.notes,
    createdAt: p.createdAt,
  };
}

/** Earned (₹) and work count per user. */
async function earnings(role: PayRole, userIds?: string[]) {
  const db = prisma();
  const map = new Map<string, { earned: number; work: number }>();
  if (role === "deo") {
    const g = await db.entry.groupBy({ by: ["deoId"], where: { status: "approved", ...(userIds ? { deoId: { in: userIds } } : {}) }, _sum: { ratePerEntry: true }, _count: { _all: true } });
    for (const r of g) map.set(r.deoId, { earned: r._sum.ratePerEntry ?? 0, work: r._count._all });
  } else {
    const g = await db.verification.groupBy({ by: ["verifierId"], where: userIds ? { verifierId: { in: userIds } } : {}, _sum: { rate: true }, _count: { _all: true } });
    for (const r of g) map.set(r.verifierId, { earned: r._sum.rate ?? 0, work: r._count._all });
  }
  return map;
}

async function paidTotals(userIds?: string[]) {
  const g = await prisma().payment.groupBy({
    by: ["userId"],
    where: userIds ? { userId: { in: userIds } } : {},
    _sum: { amount: true },
    _count: { _all: true },
    _max: { paidOn: true },
  });
  return new Map(g.map((r) => [r.userId, { paid: r._sum.amount ?? 0, count: r._count._all, last: day(r._max.paidOn) }]));
}

/** GET /admin/payouts?role= – every employee of the role with earned / paid / balance. */
export async function payoutSummary(role: PayRole, q?: string) {
  const db = prisma();
  const where: Prisma.UserWhereInput = { role };
  const s = q?.trim();
  if (s) where.OR = [{ id: { contains: s, mode: "insensitive" } }, { name: { contains: s, mode: "insensitive" } }, { mobile: { contains: s } }];
  const users = await db.user.findMany({
    where,
    orderBy: { id: "asc" },
    take: 2000,
    select: { id: true, name: true, mobile: true, email: true, status: true, profile: { select: { bankName: true, accountHolder: true, accountLast4: true, ifsc: true } } },
  });
  const ids = users.map((u) => u.id);
  const [earned, paid] = await Promise.all([earnings(role, ids), paidTotals(ids)]);
  const rows = users.map((u) => {
    const e = earned.get(u.id) ?? { earned: 0, work: 0 };
    const p = paid.get(u.id) ?? { paid: 0, count: 0, last: null };
    return {
      id: u.id,
      role,
      name: u.name,
      mobile: u.mobile,
      email: u.email,
      status: u.status,
      bank: u.profile ? { bankName: u.profile.bankName, accountHolder: u.profile.accountHolder, account: `XXXXXX${u.profile.accountLast4}`, ifsc: u.profile.ifsc } : null,
      workCount: e.work,
      earned: e.earned,
      paid: p.paid,
      balance: e.earned - p.paid,
      payments: p.count,
      lastPaidOn: p.last,
    };
  });
  const total = rows.reduce((t, r) => ({ earned: t.earned + r.earned, paid: t.paid + r.paid, balance: t.balance + r.balance }), { earned: 0, paid: 0, balance: 0 });
  return { rows, total };
}

/** GET /admin/payments?role=&userId= – receipts (newest first). */
export async function listPayments(f: { role?: PayRole; userId?: string }) {
  const rows = await prisma().payment.findMany({
    where: { ...(f.role ? { role: f.role } : {}), ...(f.userId ? { userId: f.userId.toUpperCase() } : {}) },
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    take: 2000,
    include: { user: { select: { id: true, name: true } } },
  });
  return rows.map(toPublicPayment);
}

/** POST /admin/payments – record a payout receipt and tell the employee. */
export async function recordPayment(req: Request, adminId: string, v: z.infer<typeof paymentSchema>) {
  const db = prisma();
  const u = await db.user.findUnique({ where: { id: v.userId }, select: { id: true, role: true, name: true, email: true, profile: { select: { accountHolder: true } } } });
  if (!u || (u.role !== "deo" && u.role !== "verifier")) throw fieldError(404, "EMPLOYEE_NOT_FOUND", "userId", "Employee not found.");
  try {
    const p = await db.$transaction(async (tx) => {
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        insert into id_counters (key, value) values ('payment', 1)
        on conflict (key) do update set value = id_counters.value + 1
        returning value`;
      return tx.payment.create({
        data: {
          id: `PAY${String(value).padStart(6, "0")}`,
          userId: u.id,
          role: u.role,
          amount: v.amount,
          transactionId: v.transactionId,
          payeeName: v.payeeName || u.profile?.accountHolder || u.name,
          mode: v.mode,
          paidOn: new Date(`${v.paidOn}T00:00:00Z`),
          entriesCount: v.entriesCount ?? null,
          periodFrom: v.periodFrom ? new Date(`${v.periodFrom}T00:00:00Z`) : null,
          periodTo: v.periodTo ? new Date(`${v.periodTo}T00:00:00Z`) : null,
          notes: v.notes || null,
          createdById: adminId,
        },
        include: { user: { select: { id: true, name: true } } },
      });
    });
    await audit(req, "payment.recorded", adminId, { paymentId: p.id, userId: u.id, amount: p.amount });
    const pub = toPublicPayment(p);
    await notify(
      u,
      { title: "Payment received", body: `₹${p.amount.toLocaleString("en-IN")} paid on ${pub.paidOn} (${p.mode}, Txn ${p.transactionId}).`, link: u.role === "verifier" ? "/verifier/payments" : "/deo/payments" },
      paymentEmail({ name: u.name, ...pub }),
    );
    return pub;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw fieldError(409, "DUPLICATE_TRANSACTION", "transactionId", "This transaction ID is already recorded.");
    }
    throw err;
  }
}

/** The employee's own payouts: totals and every receipt. */
export async function myPayments(userId: string, role: PayRole) {
  const [earned, paid, payments] = await Promise.all([earnings(role, [userId]), paidTotals([userId]), listPayments({ userId })]);
  const e = earned.get(userId)?.earned ?? 0;
  const p = paid.get(userId)?.paid ?? 0;
  return { summary: { earned: e, paid: p, balance: e - p, payments: payments.length }, payments: payments.map(({ user: _u, ...x }) => x) };
}

/* ---------------- Excel files ---------------- */

const ROLE_NAME: Record<PayRole, string> = { deo: "DEO", verifier: "Verifier" };
const stamp = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const paymentColumns = [
  { header: "Payment ID", width: 12 },
  { header: "Paid On", width: 12 },
  { header: "Amount (₹)", width: 12 },
  { header: "Transaction ID", width: 22 },
  { header: "Mode", width: 12 },
  { header: "Paid To (Name)", width: 22 },
  { header: "Entries Covered", width: 10 },
  { header: "Period From", width: 12 },
  { header: "Period To", width: 12 },
  { header: "Notes", width: 30 },
];
const paymentRow = (p: Omit<ReturnType<typeof toPublicPayment>, "user">) => [p.id, p.paidOn, p.amount, p.transactionId, p.mode, p.payeeName, p.entriesCount, p.periodFrom, p.periodTo, p.notes];

/** Admin: Summary + Payments sheets for one role. */
export async function payoutWorkbook(role: PayRole) {
  const [{ rows }, payments] = await Promise.all([payoutSummary(role), listPayments({ role })]);
  const sheets: SheetSpec[] = [
    {
      name: `${ROLE_NAME[role]} Payouts`,
      columns: [
        { header: "ID", width: 10 }, { header: "Name", width: 22 }, { header: "Mobile", width: 12 }, { header: "Status", width: 10 },
        { header: role === "deo" ? "Approved Entries" : "Verified Entries", width: 12 },
        { header: "Earned (₹)", width: 12 }, { header: "Paid (₹)", width: 12 }, { header: "Balance (₹)", width: 12 }, { header: "Payments", width: 10 },
        { header: "Last Paid On", width: 12 }, { header: "Bank", width: 20 }, { header: "Account Holder", width: 20 }, { header: "Account No.", width: 14 }, { header: "IFSC", width: 12 },
      ],
      rows: rows.map((r) => [r.id, r.name, r.mobile, r.status, r.workCount, r.earned, r.paid, r.balance, r.payments, r.lastPaidOn, r.bank?.bankName, r.bank?.accountHolder, r.bank?.account, r.bank?.ifsc]),
    },
    {
      name: `${ROLE_NAME[role]} Payments`,
      columns: [{ header: "Employee ID", width: 12 }, { header: "Employee Name", width: 22 }, ...paymentColumns],
      rows: payments.map((p) => [p.userId, p.user?.name, ...paymentRow(p)]),
    },
  ];
  return { filename: `nasoi-${role === "deo" ? "deo" : "verifier"}-payouts_${stamp()}.xlsx`, content: await buildWorkbook(sheets), contentType: XLSX_TYPE };
}

/** Employee: own payments. */
export async function myPaymentsWorkbook(userId: string, role: PayRole) {
  const { summary, payments } = await myPayments(userId, role);
  const sheets: SheetSpec[] = [
    {
      name: "My Payments",
      columns: paymentColumns,
      rows: [...payments.map(paymentRow), [], ["Total earned", "", summary.earned], ["Total received", "", summary.paid], ["Balance", "", summary.balance]],
    },
  ];
  return { filename: `nasoi-payments_${userId.toLowerCase()}_${stamp()}.xlsx`, content: await buildWorkbook(sheets), contentType: XLSX_TYPE };
}

export async function emailPayoutWorkbook(req: Request, adminId: string, role: PayRole, mail: EmailRequest) {
  const file = await payoutWorkbook(role);
  return emailFile(req, adminId, mail, file, {
    report: `${ROLE_NAME[role]} payouts report`,
    details: `Earned, paid and balance of every ${ROLE_NAME[role]}, with all payment receipts (Excel).`,
  });
}

/** Sends the employee's own payments to their registered e-mail only. */
export async function emailMyPayments(req: Request, userId: string, role: PayRole) {
  const u = await prisma().user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!u?.email) throw new HttpError(400, "No e-mail is registered on your account.", "NO_EMAIL");
  const file = await myPaymentsWorkbook(userId, role);
  return emailFile(
    req,
    userId,
    {
      to: [u.email],
      subject: "Your NASOI payments – {date}",
      message: "Hello,\n\nAttached is every payment you have received from NASOI, with your total earned and balance.\n\nRegards,\nNASOI",
    },
    file,
    { report: "your payments", details: "" },
  );
}
