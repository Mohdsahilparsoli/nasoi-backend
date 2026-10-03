import type { Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { PLATFORM_LABEL, istDateTime } from "../../lib/email-templates.js";
import { HttpError, fieldError } from "../../lib/http.js";
import { meetingEmail, requestEmail } from "../../lib/mailer.js";
import { notify } from "../../lib/notify.js";

/* ------------------------------------------------------------------ */
/* Meeting links                                                       */
/* ------------------------------------------------------------------ */

const PLATFORM_HOSTS: [string, RegExp][] = [
  ["zoom", /(^|\.)zoom\.(us|com)$/],
  ["google_meet", /^meet\.google\.com$/],
  ["teams", /^(teams\.microsoft\.com|teams\.live\.com)$/],
];

/** zoom | google_meet | teams – or null for any other site. */
export function meetingPlatform(link: string): string | null {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return PLATFORM_HOSTS.find(([, re]) => re.test(host))?.[0] ?? null;
  } catch {
    return null;
  }
}

/** A Zoom / Google Meet / Teams link (https only). */
export const meetingLinkSchema = z
  .string()
  .trim()
  .max(500, "Link is too long")
  .refine((v) => /^https:\/\/\S+$/i.test(v), "Paste the full meeting link starting with https://")
  .refine((v) => meetingPlatform(v) !== null, "Use a Zoom, Google Meet or Microsoft Teams meeting link");

/* ------------------------------------------------------------------ */
/* Who can talk to whom                                                */
/* ------------------------------------------------------------------ */

type Me = { sub: string; role: string };
const CAN_CONTACT = ["active", "pending", "inactive"] as const;

/**
 * The people this user may send meetings / requests to:
 * - admin: every employee and other admins;
 * - DEO: the verifiers of their work and entries, and the admin;
 * - verifier: the DEOs of their areas and entries, and the admin.
 */
export async function contactIds(me: Me): Promise<Set<string>> {
  const db = prisma();
  const admins = await db.user.findMany({ where: { role: "admin", status: { in: [...CAN_CONTACT] } }, select: { id: true } });
  const ids = new Set(admins.map((a) => a.id));
  if (me.role === "admin") {
    const all = await db.user.findMany({ where: { status: { in: [...CAN_CONTACT] } }, select: { id: true } });
    all.forEach((u) => ids.add(u.id));
  } else if (me.role === "deo") {
    const [a, e] = await Promise.all([
      db.assignment.findMany({ where: { deoId: me.sub, verifierId: { not: null } }, select: { verifierId: true } }),
      db.entry.findMany({ where: { deoId: me.sub }, select: { verifierId: true, verifiedById: true }, distinct: ["verifierId", "verifiedById"] }),
    ]);
    a.forEach((x) => x.verifierId && ids.add(x.verifierId));
    e.forEach((x) => [x.verifierId, x.verifiedById].forEach((v) => v && ids.add(v)));
  } else if (me.role === "verifier") {
    const [a, e] = await Promise.all([
      db.assignment.findMany({ where: { verifierId: me.sub }, select: { deoId: true }, distinct: ["deoId"] }),
      db.entry.findMany({ where: { OR: [{ verifierId: me.sub }, { verifiedById: me.sub }] }, select: { deoId: true }, distinct: ["deoId"] }),
    ]);
    a.forEach((x) => ids.add(x.deoId));
    e.forEach((x) => ids.add(x.deoId));
  }
  ids.delete(me.sub);
  return ids;
}

export interface Contact {
  id: string;
  name: string;
  role: string;
  mobile: string | null;
  hasPhoto: boolean;
  meetingLink: string | null;
  platform: string | null;
}

/** Cards for people (photo flag, personal meeting room). The admin's mobile is not shown to employees. */
export async function contactCards(ids: Iterable<string>, viewerRole: string): Promise<Map<string, Contact>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const users = await prisma().user.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      name: true,
      role: true,
      mobile: true,
      meetingLink: true,
      documents: { where: { kind: "photo", attachedAt: { not: null } }, select: { id: true }, take: 1 },
    },
  });
  return new Map(
    users.map((u) => [
      u.id,
      {
        id: u.id,
        name: u.name,
        role: u.role,
        mobile: u.role === "admin" && viewerRole !== "admin" ? null : u.mobile,
        hasPhoto: u.documents.length > 0,
        meetingLink: u.meetingLink,
        platform: u.meetingLink ? meetingPlatform(u.meetingLink) : null,
      },
    ]),
  );
}

export async function listContacts(me: Me) {
  const cards = await contactCards(await contactIds(me), me.role);
  const order = { admin: 0, verifier: 1, deo: 2 } as Record<string, number>;
  return [...cards.values()].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.id.localeCompare(b.id));
}

async function assertContacts(me: Me, ids: string[], field: string) {
  const allowed = await contactIds(me);
  const bad = ids.find((id) => !allowed.has(id));
  if (bad) throw fieldError(403, "NOT_A_CONTACT", field, `You cannot send this to ${bad}. You can only contact the people you work with.`);
}

/** The entry must be one this user works on (admin: any). */
async function assertEntry(me: Me, entryId: string | null | undefined) {
  if (!entryId) return;
  const e = await prisma().entry.findUnique({ where: { id: entryId }, select: { deoId: true, verifierId: true, verifiedById: true } });
  const mine =
    e &&
    (me.role === "admin" ||
      (me.role === "deo" && e.deoId === me.sub) ||
      (me.role === "verifier" &&
        (e.verifierId === me.sub || e.verifiedById === me.sub || (await prisma().verification.count({ where: { entryId, verifierId: me.sub } })) > 0)));
  if (!mine) throw fieldError(404, "ENTRY_NOT_FOUND", "entryId", `Entry ${entryId} was not found in your work.`);
}

const panel = (role: string) => (role === "admin" ? "admin" : role === "verifier" ? "verifier" : "deo");

async function nextId(tx: Prisma.TransactionClient, key: string, prefix: string) {
  const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
    insert into id_counters (key, value) values (${key}, 1)
    on conflict (key) do update set value = id_counters.value + 1
    returning value`;
  return `${prefix}${String(value).padStart(6, "0")}`;
}

const entryIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^ENT\d{6,}$/, "Enter a valid entry ID (e.g. ENT000123)")
  .optional()
  .or(z.literal("").transform(() => undefined));

/* ------------------------------------------------------------------ */
/* Meetings                                                            */
/* ------------------------------------------------------------------ */

export const meetingSchema = z.object({
  title: z.string().trim().min(3, "Enter the meeting title").max(120, "Title is too long"),
  link: meetingLinkSchema,
  startsAt: z.coerce
    .date({ error: "Choose the date and time" })
    .refine((d) => d.getTime() > Date.now() - 5 * 60_000, "The meeting time is in the past")
    .refine((d) => d.getTime() < Date.now() + 366 * 86_400_000, "Choose a date within a year"),
  durationMin: z.coerce.number().int().min(5, "At least 5 minutes").max(480, "At most 8 hours").default(30),
  notes: z.string().trim().max(1000, "Notes are too long").optional().or(z.literal("")),
  participantIds: z.array(z.string().trim().toUpperCase().max(20)).max(30, "At most 30 people").default([]),
  entryId: entryIdSchema,
  requestId: z.string().trim().toUpperCase().regex(/^REQ\d{6,}$/).optional(),
});

type MeetingRow = Prisma.MeetingGetPayload<{ include: { participants: { select: { userId: true } } } }>;

async function toPublicMeetings(rows: MeetingRow[], me: Me) {
  const cards = await contactCards(rows.flatMap((m) => [m.createdById, ...m.participants.map((p) => p.userId)]), me.role);
  const now = Date.now();
  return rows.map((m) => {
    const end = m.startsAt.getTime() + m.durationMin * 60_000;
    return {
      id: m.id,
      title: m.title,
      platform: m.platform,
      link: m.link,
      startsAt: m.startsAt,
      durationMin: m.durationMin,
      notes: m.notes,
      entryId: m.entryId,
      status: m.status,
      /** upcoming | live | ended | cancelled */
      state: m.status === "cancelled" ? "cancelled" : now > end ? "ended" : now >= m.startsAt.getTime() - 5 * 60_000 ? "live" : "upcoming",
      createdBy: cards.get(m.createdById) ?? null,
      participants: m.participants.map((p) => cards.get(p.userId)).filter(Boolean),
      mine: m.createdById === me.sub,
      createdAt: m.createdAt,
    };
  });
}

/** GET /connect/meetings?view=upcoming|past|all – the meetings I organise or join (admin "all": every meeting). */
export async function listMeetings(me: Me, view: string) {
  const now = new Date();
  const mineOnly: Prisma.MeetingWhereInput = { OR: [{ createdById: me.sub }, { participants: { some: { userId: me.sub } } }] };
  const where: Prisma.MeetingWhereInput = me.role === "admin" && view === "all" ? {} : mineOnly;
  // "Upcoming" includes meetings still running (up to 8 h back, filtered precisely below).
  if (view === "upcoming") Object.assign(where, { status: "scheduled", startsAt: { gte: new Date(now.getTime() - 8 * 3_600_000) } });
  const rows = await prisma().meeting.findMany({
    where,
    orderBy: { startsAt: view === "upcoming" ? "asc" : "desc" },
    take: 300,
    include: { participants: { select: { userId: true } } },
  });
  const list = await toPublicMeetings(rows, me);
  if (view === "upcoming") return list.filter((m) => m.state === "upcoming" || m.state === "live");
  if (view === "past") return list.filter((m) => m.state === "ended" || m.state === "cancelled");
  return list;
}

/** Tells everyone in the meeting (except the person who acted) – in-app and by e-mail. */
async function sendMeetingMail(meeting: MeetingRow, organizer: string, actorId: string, cancelled = false) {
  const ids = meeting.participants.map((p) => p.userId).filter((id) => id !== actorId);
  const users = await prisma().user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, role: true } });
  const label = PLATFORM_LABEL[meeting.platform] ?? "Online";
  const when = istDateTime(meeting.startsAt);
  await Promise.all(
    users.map((u) =>
        notify(
          u,
          {
            title: cancelled ? `Meeting cancelled: ${meeting.title}` : `${label} meeting: ${meeting.title}`,
            body: cancelled ? `${when} – cancelled by ${organizer}.` : `${when} · ${meeting.durationMin} min · by ${organizer}. Open to join.`,
            link: `/${panel(u.role)}/connect`,
          },
          meetingEmail({
            name: u.name,
            id: meeting.id,
            title: meeting.title,
            platform: meeting.platform,
            link: meeting.link,
            startsAt: meeting.startsAt,
            durationMin: meeting.durationMin,
            organizer,
            notes: meeting.notes,
            entryId: meeting.entryId,
            cancelled,
            role: u.role,
          }),
        ),
      ),
  );
}

/** POST /connect/meetings – schedule a meeting; every participant gets a notification and an e-mail. */
export async function createMeeting(req: Request, me: Me, v: z.infer<typeof meetingSchema>) {
  const participants = [...new Set(v.participantIds)].filter((id) => id !== me.sub);
  if (v.requestId) {
    // Scheduling a meeting can answer a meeting request sent to me: the requester joins automatically.
    const r = await prisma().connectRequest.findUnique({ where: { id: v.requestId }, select: { toId: true, fromId: true } });
    if (!r || r.toId !== me.sub) throw new HttpError(404, "Request not found.", "NOT_FOUND");
    if (!participants.includes(r.fromId)) participants.push(r.fromId);
  }
  if (!participants.length) throw fieldError(400, "NO_PARTICIPANTS", "participantIds", "Choose who should join");
  await assertContacts(me, participants, "participantIds");
  await assertEntry(me, v.entryId);
  const db = prisma();
  const platform = meetingPlatform(v.link)!;

  const meeting = await db.$transaction(async (tx) => {
    if (v.requestId) {
      const r = await tx.connectRequest.findUniqueOrThrow({ where: { id: v.requestId }, select: { status: true } });
      if (r.status !== "open") throw new HttpError(409, `This request is already ${r.status}.`, "REQUEST_CLOSED");
    }
    const id = await nextId(tx, "meeting", "MTG");
    const m = await tx.meeting.create({
      data: {
        id,
        title: v.title,
        platform,
        link: v.link,
        startsAt: v.startsAt,
        durationMin: v.durationMin,
        notes: v.notes || null,
        entryId: v.entryId ?? null,
        createdById: me.sub,
        participants: { create: [me.sub, ...participants].map((userId) => ({ userId })) },
      },
      include: { participants: { select: { userId: true } } },
    });
    if (v.requestId) {
      await tx.connectRequest.update({
        where: { id: v.requestId },
        data: { status: "accepted", meetingId: id, respondedAt: new Date(), reply: `Meeting ${id} scheduled for ${istDateTime(v.startsAt)}.` },
      });
    }
    return m;
  });

  const organizer = (await db.user.findUnique({ where: { id: me.sub }, select: { name: true } }))?.name ?? me.sub;
  await sendMeetingMail(meeting, `${organizer} (${me.sub})`, me.sub);
  await audit(req, "meeting.created", me.sub, { meetingId: meeting.id, platform, people: participants.length });
  return (await toPublicMeetings([meeting], me))[0]!;
}

/** POST /connect/meetings/:id/cancel – organiser or admin. */
export async function cancelMeeting(req: Request, me: Me, id: string) {
  const db = prisma();
  const m = await db.meeting.findUnique({ where: { id }, include: { participants: { select: { userId: true } } } });
  if (!m || !(m.createdById === me.sub || me.role === "admin" || m.participants.some((p) => p.userId === me.sub))) throw new HttpError(404, "Meeting not found.", "NOT_FOUND");
  if (m.createdById !== me.sub && me.role !== "admin") throw new HttpError(403, "Only the organiser can cancel this meeting.", "FORBIDDEN");
  if (m.status === "cancelled") throw new HttpError(409, "This meeting is already cancelled.", "ALREADY_CANCELLED");
  const updated = await db.meeting.update({ where: { id }, data: { status: "cancelled" }, include: { participants: { select: { userId: true } } } });
  const who = (await db.user.findUnique({ where: { id: me.sub }, select: { name: true } }))?.name ?? me.sub;
  await sendMeetingMail(updated, `${who} (${me.sub})`, me.sub, true);
  await audit(req, "meeting.cancelled", me.sub, { meetingId: id });
  return (await toPublicMeetings([updated], me))[0]!;
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

const KIND_SUBJECT: Record<string, string> = { meeting: "Request for a meeting", entry: "Request about an entry", general: "Request" };

export const requestSchema = z
  .object({
    kind: z.enum(["meeting", "entry", "general"], { error: "Choose the type of request" }),
    toId: z.string().trim().toUpperCase().min(1, "Choose who to send it to").max(20),
    entryId: entryIdSchema,
    subject: z.string().trim().max(120, "Subject is too long").optional().or(z.literal("")),
    message: z.string().trim().min(5, "Write your message (at least 5 characters)").max(1000, "Message is too long (max 1000)"),
    preferredAt: z.coerce.date().optional().or(z.literal("").transform(() => undefined)),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "entry" && !v.entryId) ctx.addIssue({ code: "custom", path: ["entryId"], message: "Enter the entry ID this request is about" });
    if (v.preferredAt && v.preferredAt.getTime() < Date.now() - 5 * 60_000) ctx.addIssue({ code: "custom", path: ["preferredAt"], message: "The preferred time is in the past" });
  });

type RequestRow = Prisma.ConnectRequestGetPayload<object>;

async function toPublicRequests(rows: RequestRow[], me: Me) {
  const cards = await contactCards(rows.flatMap((r) => [r.fromId, r.toId]), me.role);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    from: cards.get(r.fromId) ?? null,
    to: cards.get(r.toId) ?? null,
    entryId: r.entryId,
    subject: r.subject,
    message: r.message,
    preferredAt: r.preferredAt,
    status: r.status,
    reply: r.reply,
    respondedAt: r.respondedAt,
    meetingId: r.meetingId,
    incoming: r.toId === me.sub,
    createdAt: r.createdAt,
  }));
}

/** GET /connect/requests?box=inbox|sent */
export async function listRequests(me: Me, box: string) {
  const where: Prisma.ConnectRequestWhereInput = box === "sent" ? { fromId: me.sub } : { toId: me.sub };
  const rows = await prisma().connectRequest.findMany({ where, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 300 });
  return toPublicRequests(rows, me);
}

/** POST /connect/requests – the receiver gets a notification and an e-mail. */
export async function createRequest(req: Request, me: Me, v: z.infer<typeof requestSchema>) {
  if (v.toId === me.sub) throw fieldError(400, "SELF", "toId", "You cannot send a request to yourself");
  await assertContacts(me, [v.toId], "toId");
  await assertEntry(me, v.entryId);
  const db = prisma();
  const recent = await db.connectRequest.count({ where: { fromId: me.sub, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
  if (recent >= 20) throw new HttpError(429, "Too many requests in the last hour. Please wait a little.", "TOO_MANY");
  const subject = v.subject || (v.entryId ? `${KIND_SUBJECT[v.kind]} – ${v.entryId}` : KIND_SUBJECT[v.kind]!);

  const row = await db.$transaction(async (tx) =>
    tx.connectRequest.create({
      data: {
        id: await nextId(tx, "request", "REQ"),
        kind: v.kind,
        fromId: me.sub,
        toId: v.toId,
        entryId: v.entryId ?? null,
        subject,
        message: v.message,
        preferredAt: v.preferredAt ?? null,
      },
    }),
  );
  const [from, to] = await Promise.all([
    db.user.findUnique({ where: { id: me.sub }, select: { name: true } }),
    db.user.findUniqueOrThrow({ where: { id: v.toId }, select: { id: true, name: true, email: true, role: true } }),
  ]);
  const fromText = `${from?.name ?? me.sub} (${me.sub})`;
  await notify(
    to,
    {
      title: `${v.kind === "meeting" ? "Meeting request" : v.kind === "entry" ? "Entry request" : "New request"} from ${from?.name ?? me.sub}`,
      body: `${subject}${row.preferredAt ? ` · preferred ${istDateTime(row.preferredAt)}` : ""}`,
      link: `/${panel(to.role)}/connect?tab=requests`,
    },
    requestEmail({ name: to.name, id: row.id, kind: v.kind, from: fromText, subject, message: v.message, entryId: row.entryId, preferredAt: row.preferredAt, role: to.role }),
  );
  await audit(req, "request.created", me.sub, { requestId: row.id, kind: v.kind, to: v.toId });
  return (await toPublicRequests([row], me))[0]!;
}

export const respondSchema = z
  .object({
    action: z.enum(["accept", "decline", "close"], { error: "Choose accept, decline or close" }),
    reply: z.string().trim().max(1000, "Reply is too long (max 1000)").optional().or(z.literal("")),
  })
  .superRefine((v, ctx) => {
    if (v.action === "decline" && (v.reply ?? "").length < 3) ctx.addIssue({ code: "custom", path: ["reply"], message: "Write why you are declining" });
  });

const ACTION_STATUS = { accept: "accepted", decline: "declined", close: "closed" } as const;

/** POST /connect/requests/:id/respond – the receiver accepts / declines; either side can close. */
export async function respondRequest(req: Request, me: Me, id: string, v: z.infer<typeof respondSchema>) {
  const db = prisma();
  const r = await db.connectRequest.findUnique({ where: { id } });
  if (!r || (r.toId !== me.sub && r.fromId !== me.sub)) throw new HttpError(404, "Request not found.", "NOT_FOUND");
  if (v.action !== "close" && r.toId !== me.sub) throw new HttpError(403, "Only the person who received the request can answer it.", "FORBIDDEN");
  if (r.status !== "open") throw new HttpError(409, `This request is already ${r.status}.`, "REQUEST_CLOSED");
  const status = ACTION_STATUS[v.action];
  const updated = await db.connectRequest.update({ where: { id }, data: { status, reply: v.reply || r.reply, respondedAt: new Date() } });

  const otherId = r.fromId === me.sub ? r.toId : r.fromId;
  const [mine, other] = await Promise.all([
    db.user.findUnique({ where: { id: me.sub }, select: { name: true } }),
    db.user.findUniqueOrThrow({ where: { id: otherId }, select: { id: true, name: true, email: true, role: true } }),
  ]);
  const who = `${mine?.name ?? me.sub} (${me.sub})`;
  await notify(
    other,
    { title: `Request ${status}: ${r.subject}`, body: `${who} ${status} request ${id}.${v.reply ? ` “${v.reply.slice(0, 200)}”` : ""}`, link: `/${panel(other.role)}/connect?tab=requests` },
    requestEmail({
      name: other.name,
      id,
      kind: r.kind,
      from: who,
      subject: r.subject,
      message: r.message,
      entryId: r.entryId,
      preferredAt: r.preferredAt,
      role: other.role,
      reply: { status, text: v.reply || null },
    }),
  );
  await audit(req, "request.answered", me.sub, { requestId: id, status });
  return (await toPublicRequests([updated], me))[0]!;
}

/** GET /connect/summary – counts for the dashboard / sidebar badge and the next meeting. */
export async function connectSummary(me: Me) {
  const [meetings, openInbox] = await Promise.all([listMeetings(me, "upcoming"), prisma().connectRequest.count({ where: { toId: me.sub, status: "open" } })]);
  return { upcoming: meetings.length, live: meetings.filter((m) => m.state === "live").length, next: meetings.slice(0, 3), openInbox };
}

/** PATCH /profile/me/meeting-link – my personal Zoom / Google Meet room ("" removes it). */
export async function setMyMeetingLink(req: Request, me: Me, link: string) {
  const value = link ? meetingLinkSchema.parse(link) : null;
  await prisma().user.update({ where: { id: me.sub }, data: { meetingLink: value } });
  await audit(req, "profile.updated", me.sub, { meetingLink: value ? meetingPlatform(value)! : "removed" });
  return { meetingLink: value, platform: value ? meetingPlatform(value) : null };
}
