import { Router } from "express";
import { z } from "zod";
import { noStore, requireAuth } from "../../middleware/security.js";
import { createAssignmentSchema, updateAssignmentSchema } from "../assignments/schema.js";
import { createAssignment, listAssignments, updateAssignmentStatus } from "../assignments/service.js";
import { audit } from "../../lib/audit.js";
import { getSettings, settingsSchema, updateSettings } from "../../lib/settings.js";
import { exportApproved, exportOptions, listAdminEntries, parseFilter } from "./entries.js";
import { getOperator, listOperators, setOperatorStatus } from "./operators.js";

/** Everything under /api/v1/admin requires a Super Admin login. */
export const adminRouter = Router();
adminRouter.use(noStore, requireAuth("admin"));

const q = (v: unknown) => (typeof v === "string" && v.length <= 60 ? v : undefined);

adminRouter.get("/operators", async (req, res) => {
  res.json({ operators: await listOperators(q(req.query.q)) });
});

adminRouter.get("/operators/:id", async (req, res) => {
  res.json({ operator: await getOperator(String(req.params.id)) });
});

adminRouter.patch("/operators/:id/status", async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "blocked"]) }).parse(req.body);
  res.json(await setOperatorStatus(req, req.auth!.sub, String(req.params.id), status));
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

/** Portal settings: verifier rate, default DEO rate, payout window. */
adminRouter.get("/settings", async (_req, res) => {
  res.json({ settings: await getSettings() });
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

/** GET /admin/entries/export?format=xlsx|csv&<filters> – approved entries only. No filters = export all. */
adminRouter.get("/entries/export", async (req, res) => {
  const format = req.query.format === "csv" ? "csv" : "xlsx";
  const { format: _f, ...rest } = req.query as Record<string, unknown>;
  await exportApproved(req, res, req.auth!.sub, parseFilter(rest), format);
});
