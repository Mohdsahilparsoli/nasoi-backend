import { Router } from "express";
import { z } from "zod";
import { noStore, requireAuth } from "../../middleware/security.js";
import { changeVerifierSchema, createAssignmentSchema, updateAssignmentSchema } from "../assignments/schema.js";
import { changeVerifier, createAssignment, listAssignments, listVerifiers, updateAssignmentStatus } from "../assignments/service.js";
import { audit } from "../../lib/audit.js";
import { getSettings, mailTemplateSchema, settingsSchema, updateMailTemplate, updateSettings } from "../../lib/settings.js";
import { emailToSchema } from "../../lib/files.js";
import { adminPayoutsRouter } from "../payments/routes.js";
import { emailApproved, exportApproved, exportOptions, listAdminEntries, parseFilter } from "./entries.js";
import { employeeStatusSchema, getEmployee, listEmployees, setEmployeeStatus } from "./operators.js";

/** Everything under /api/v1/admin requires a Super Admin login. */
export const adminRouter = Router();
adminRouter.use(noStore, requireAuth("admin"));
adminRouter.use(adminPayoutsRouter);

const q = (v: unknown) => (typeof v === "string" && v.length <= 60 ? v : undefined);

/** GET /admin/operators?role=deo|verifier&q= – employees (DEOs and verifiers). */
adminRouter.get("/operators", async (req, res) => {
  const role = req.query.role === "deo" || req.query.role === "verifier" ? req.query.role : undefined;
  res.json({ operators: await listEmployees({ q: q(req.query.q), role }) });
});

adminRouter.get("/operators/:id", async (req, res) => {
  res.json({ operator: await getEmployee(String(req.params.id)) });
});

/** PATCH /admin/operators/:id/status – { status: active | inactive | rejected, reason? } */
adminRouter.patch("/operators/:id/status", async (req, res) => {
  res.json(await setEmployeeStatus(req, req.auth!.sub, String(req.params.id), employeeStatusSchema.parse(req.body)));
});

adminRouter.get("/assignments", async (req, res) => {
  res.json({ assignments: await listAssignments({ status: q(req.query.status), deoId: q(req.query.deoId), q: q(req.query.q) }) });
});

adminRouter.post("/assignments", async (req, res) => {
  const input = createAssignmentSchema.parse(req.body);
  const r = await createAssignment(req, req.auth!.sub, input);
  res.status(201).json(r);
});

adminRouter.patch("/assignments/:id", async (req, res) => {
  const { status } = updateAssignmentSchema.parse(req.body);
  res.json({ assignment: await updateAssignmentStatus(req, req.auth!.sub, String(req.params.id), status) });
});

/** PATCH /admin/assignments/:id/verifier – change the verifier of an area. */
adminRouter.patch("/assignments/:id/verifier", async (req, res) => {
  const { verifierId } = changeVerifierSchema.parse(req.body);
  res.json(await changeVerifier(req, req.auth!.sub, String(req.params.id), verifierId));
});

/** GET /admin/verifiers – verifiers with their active areas and pending entries. */
adminRouter.get("/verifiers", async (_req, res) => {
  res.json({ verifiers: await listVerifiers() });
});

/** Portal settings: verifier rate, default DEO rate, payout window. */
adminRouter.get("/settings", async (_req, res) => {
  res.json({ settings: await getSettings() });
});

/** PATCH /admin/settings/mail-template { subject, message } | { reset: true } – default e-mail template. */
adminRouter.patch("/settings/mail-template", async (req, res) => {
  const v = mailTemplateSchema.parse(req.body);
  const settings = await updateMailTemplate(v);
  await audit(req, "settings.updated", req.auth!.sub, { mailTemplate: "reset" in v ? "reset" : "saved" });
  res.json({ settings });
});

adminRouter.patch("/settings", async (req, res) => {
  const settings = await updateSettings(settingsSchema.parse(req.body));
  await audit(req, "settings.updated", req.auth!.sub, { verifierRate: settings.verifierRate, defaultDeoRate: settings.defaultDeoRate });
  res.json({ settings });
});

/* ---------- Entries: list and export ---------- */

/** GET /admin/entries?status=&pincode=&deoId=&verifierId=&assignmentId=&taskType=&state=&district=&from=&to=&q= */
adminRouter.get("/entries", async (req, res) => {
  res.json(await listAdminEntries(parseFilter(req.query as Record<string, unknown>)));
});

/** GET /admin/entries/export-options – PIN codes, DEOs, verifiers … that have approved entries. */
adminRouter.get("/entries/export-options", async (_req, res) => {
  res.json(await exportOptions());
});

/** POST /admin/entries/export/email { to, cc, subject, message, format, filters: {…} } – send the export as an e-mail attachment. */
adminRouter.post("/entries/export/email", async (req, res) => {
  const mail = emailToSchema.parse(req.body);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filters = body.filters && typeof body.filters === "object" ? (body.filters as Record<string, unknown>) : {};
  res.json(await emailApproved(req, req.auth!.sub, parseFilter(filters), body.format === "csv" ? "csv" : "xlsx", mail));
});

/** GET /admin/entries/export?format=xlsx|csv&<filters> – approved entries only. No filters = export all. */
adminRouter.get("/entries/export", async (req, res) => {
  const format = req.query.format === "csv" ? "csv" : "xlsx";
  const { format: _f, ...rest } = req.query as Record<string, unknown>;
  await exportApproved(req, res, req.auth!.sub, parseFilter(rest), format);
});
