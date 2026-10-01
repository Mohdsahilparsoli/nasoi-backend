import { Router } from "express";
import { z } from "zod";
import { noStore, requireAuth } from "../../middleware/security.js";
import { decide, decisionSchema, verifierEntries, verifierEntry, verifierHistory, verifierSummary } from "./service.js";

/** Everything under /api/v1/verifier requires a Verifier login. */
export const verifierRouter = Router();
verifierRouter.use(noStore, requireAuth("verifier"));

const entryId = (v: unknown) => z.string().regex(/^ENT\d{6,}$/, "Invalid entry ID").parse(v);

/** GET /verifier/summary – cards: total assigned, pending, approved, rejected, income. */
verifierRouter.get("/summary", async (req, res) => {
  res.json(await verifierSummary(req.auth!.sub));
});

/** GET /verifier/entries?view=pending|all */
verifierRouter.get("/entries", async (req, res) => {
  res.json({ entries: await verifierEntries(req.auth!.sub, req.query.view === "all" ? "all" : "pending") });
});

verifierRouter.get("/entries/:id", async (req, res) => {
  res.json({ entry: await verifierEntry(req.auth!.sub, entryId(req.params.id)) });
});

/** POST /verifier/entries/:id/decision  { decision: "approved" | "rejected", reason? } */
verifierRouter.post("/entries/:id/decision", async (req, res) => {
  res.json(await decide(req, req.auth!.sub, entryId(req.params.id), decisionSchema.parse(req.body)));
});

/** GET /verifier/history?decision=approved|rejected */
verifierRouter.get("/history", async (req, res) => {
  res.json({ history: await verifierHistory(req.auth!.sub, typeof req.query.decision === "string" ? req.query.decision : undefined) });
});
