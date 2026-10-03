import { Router } from "express";
import { z } from "zod";
import { noStore, requireAuth } from "../../middleware/security.js";
import {
  cancelMeeting,
  connectSummary,
  createMeeting,
  createRequest,
  listContacts,
  listMeetings,
  listRequests,
  meetingSchema,
  requestSchema,
  respondRequest,
  respondSchema,
} from "./service.js";

/** Meetings (Zoom / Google Meet) and requests between the admin, DEOs and verifiers. Any logged-in role. */
export const connectRouter = Router();
connectRouter.use(noStore, requireAuth());

const me = (req: import("express").Request) => ({ sub: req.auth!.sub, role: req.auth!.role });
const meetingId = (v: unknown) => z.string().toUpperCase().regex(/^MTG\d{6,}$/, "Invalid meeting ID").parse(v);
const requestId = (v: unknown) => z.string().toUpperCase().regex(/^REQ\d{6,}$/, "Invalid request ID").parse(v);

/** GET /connect/contacts – people I can invite / send requests to (with photo flag and personal meeting room). */
connectRouter.get("/contacts", async (req, res) => {
  res.json({ contacts: await listContacts(me(req)) });
});

/** GET /connect/summary – upcoming meetings, open requests. */
connectRouter.get("/summary", async (req, res) => {
  res.json(await connectSummary(me(req)));
});

/** GET /connect/meetings?view=upcoming|past|all */
connectRouter.get("/meetings", async (req, res) => {
  const view = ["upcoming", "past", "all"].includes(String(req.query.view)) ? String(req.query.view) : "upcoming";
  res.json({ meetings: await listMeetings(me(req), view) });
});

/** POST /connect/meetings – { title, link, startsAt, durationMin, notes, participantIds, audience? (admin: all, all_deo, all_vr), entryId?, requestId? } */
connectRouter.post("/meetings", async (req, res) => {
  res.status(201).json({ meeting: await createMeeting(req, me(req), meetingSchema.parse(req.body)) });
});

/** POST /connect/meetings/:id/cancel */
connectRouter.post("/meetings/:id/cancel", async (req, res) => {
  res.json({ meeting: await cancelMeeting(req, me(req), meetingId(req.params.id)) });
});

/** GET /connect/requests?box=inbox|sent */
connectRouter.get("/requests", async (req, res) => {
  res.json({ requests: await listRequests(me(req), req.query.box === "sent" ? "sent" : "inbox") });
});

/** POST /connect/requests – { kind, toId | toIds[] | audience (admin: all, all_deo, all_vr), entryId?, subject?, message, preferredAt? } → { request, sent } */
connectRouter.post("/requests", async (req, res) => {
  res.status(201).json(await createRequest(req, me(req), requestSchema.parse(req.body)));
});

/** POST /connect/requests/:id/respond – { action: accept|decline|close, reply? } */
connectRouter.post("/requests/:id/respond", async (req, res) => {
  res.json({ request: await respondRequest(req, me(req), requestId(req.params.id), respondSchema.parse(req.body)) });
});
