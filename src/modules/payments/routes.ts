import { Router } from "express";
import { emailToSchema } from "../../lib/files.js";
import { HttpError } from "../../lib/http.js";
import { noStore, requireAuth } from "../../middleware/security.js";
import {
  emailMyPayments, emailPayoutWorkbook, listPayments, myPayments, myPaymentsWorkbook, payoutSummary, payoutWorkbook, paymentSchema, recordPayment, type PayRole,
} from "./service.js";

const role = (v: unknown): PayRole => (v === "verifier" ? "verifier" : "deo");
const sendFile = (res: import("express").Response, f: { filename: string; content: Buffer; contentType: string }) => {
  res.setHeader("Content-Type", f.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(f.content);
};

/* ---------- Admin: /api/v1/admin/payouts, /api/v1/admin/payments (mounted inside adminRouter, which checks the admin login) ---------- */
export const adminPayoutsRouter = Router();

/** GET /admin/payouts?role=deo|verifier&q= – earned, paid and balance of every employee of the role. */
adminPayoutsRouter.get("/payouts", async (req, res) => {
  res.json(await payoutSummary(role(req.query.role), typeof req.query.q === "string" ? req.query.q.slice(0, 60) : undefined));
});

/** GET /admin/payouts/export?role= – Excel (payouts + payments sheets). */
adminPayoutsRouter.get("/payouts/export", async (req, res) => {
  sendFile(res, await payoutWorkbook(role(req.query.role)));
});

/** POST /admin/payouts/export/email { role, to, cc, subject, message } */
adminPayoutsRouter.post("/payouts/export/email", async (req, res) => {
  res.json(await emailPayoutWorkbook(req, req.auth!.sub, role(req.body?.role), emailToSchema.parse(req.body)));
});

/** GET /admin/payments?role=&userId= – payment receipts. */
adminPayoutsRouter.get("/payments", async (req, res) => {
  const r = req.query.role === "deo" || req.query.role === "verifier" ? req.query.role : undefined;
  const userId = typeof req.query.userId === "string" && /^[A-Za-z]{2,5}(-\d{2,6}-\d{4}|\d{0,8})$/.test(req.query.userId) ? req.query.userId : undefined;
  res.json({ payments: await listPayments({ role: r, userId }) });
});

/** POST /admin/payments – record a payout receipt. */
adminPayoutsRouter.post("/payments", async (req, res) => {
  res.status(201).json({ payment: await recordPayment(req, req.auth!.sub, paymentSchema.parse(req.body)) });
});

/* ---------- DEO / verifier: /api/v1/payments/me ---------- */
export const myPaymentsRouter = Router();
myPaymentsRouter.use(noStore, requireAuth("deo", "verifier"));
const me = (req: import("express").Request) => {
  const r = req.auth!.role;
  if (r !== "deo" && r !== "verifier") throw new HttpError(403, "Not allowed.", "FORBIDDEN");
  return { id: req.auth!.sub, role: r as PayRole };
};

/** GET /payments/me – my totals (earned / received / balance) and every receipt. */
myPaymentsRouter.get("/me", async (req, res) => {
  const u = me(req);
  res.json(await myPayments(u.id, u.role));
});

/** GET /payments/me/export – my payments as Excel. */
myPaymentsRouter.get("/me/export", async (req, res) => {
  const u = me(req);
  sendFile(res, await myPaymentsWorkbook(u.id, u.role));
});

/** POST /payments/me/export/email – sent only to my registered e-mail. */
myPaymentsRouter.post("/me/export/email", async (req, res) => {
  const u = me(req);
  res.json(await emailMyPayments(req, u.id, u.role));
});
