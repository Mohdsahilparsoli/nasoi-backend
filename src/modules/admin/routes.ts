import { Router } from "express";
import { z } from "zod";
import { noStore, requireAuth } from "../../middleware/security.js";
import { createAssignmentSchema, updateAssignmentSchema } from "../assignments/schema.js";
import { createAssignment, listAssignments, updateAssignmentStatus } from "../assignments/service.js";
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
