import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { noStore, requireAuth } from "../../middleware/security.js";
import { myAssignments } from "../assignments/service.js";
import { entrySchema } from "../entries/schema.js";
import { createEntry, getMyEntry, listMyEntries, mySummary, updateEntry } from "../entries/service.js";

/** Notifications for the logged-in user (any role). */
export const notificationsRouter = Router();
notificationsRouter.use(noStore, requireAuth());

/** GET /api/v1/notifications – latest 50 + unread count. */
notificationsRouter.get("/", async (req, res) => {
  const userId = req.auth!.sub;
  const [items, unread] = await Promise.all([
    prisma().notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma().notification.count({ where: { userId, readAt: null } }),
  ]);
  res.json({ notifications: items.map(({ userId: _u, ...n }) => n), unread });
});

/** POST /api/v1/notifications/read – { ids: [...] } or { all: true }. */
notificationsRouter.post("/read", async (req, res) => {
  const b = z.object({ ids: z.array(z.string().uuid()).max(100).optional(), all: z.boolean().optional() }).parse(req.body);
  const where = { userId: req.auth!.sub, readAt: null, ...(b.all ? {} : { id: { in: b.ids ?? [] } }) };
  const r = await prisma().notification.updateMany({ where, data: { readAt: new Date() } });
  res.json({ ok: true, updated: r.count });
});

/** DEO work: GET /api/v1/me/assignments → { current, history }. */
export const meRouter = Router();
meRouter.use(noStore, requireAuth("deo"));
meRouter.get("/assignments", async (req, res) => {
  res.json(await myAssignments(req.auth!.sub, req.query.seen === "1"));
});

/* ---------- DEO entries (school records) ---------- */
const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 100) : undefined);
const entryId = (v: unknown) => z.string().regex(/^ENT\d{6,}$/, "Invalid entry ID").parse(v);

/** GET /api/v1/me/summary – dashboard counts, earnings and month-wise history. */
meRouter.get("/summary", async (req, res) => {
  res.json(await mySummary(req.auth!.sub));
});

/** GET /api/v1/me/entries?status=&q=&assignmentId= */
meRouter.get("/entries", async (req, res) => {
  res.json({ entries: await listMyEntries(req.auth!.sub, { status: str(req.query.status), q: str(req.query.q), assignmentId: str(req.query.assignmentId) }) });
});

meRouter.get("/entries/:id", async (req, res) => {
  res.json({ entry: await getMyEntry(req.auth!.sub, entryId(req.params.id)) });
});

/** POST /api/v1/me/entries – new school record in the current assignment. */
meRouter.post("/entries", async (req, res) => {
  res.status(201).json({ entry: await createEntry(req, req.auth!.sub, entrySchema.parse(req.body)) });
});

/** PATCH /api/v1/me/entries/:id – correct a pending entry, or fix and resubmit a rejected one. */
meRouter.patch("/entries/:id", async (req, res) => {
  res.json({ entry: await updateEntry(req, req.auth!.sub, entryId(req.params.id), entrySchema.parse(req.body)) });
});
