import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { noStore, requireAuth } from "../../middleware/security.js";
import { myAssignments } from "../assignments/service.js";

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
  res.json(await myAssignments(req.auth!.sub));
});
