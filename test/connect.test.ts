// Meetings (Zoom / Google Meet), requests, meeting links, photos, admin overview. Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { SMTPServer } from "smtp-server";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "test";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "2592";
process.env.SMTP_FROM = "NASOI <no-reply@nasoi.test>";
delete process.env.SMTP_USER;

const mails: { to: string; raw: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  size: 30 * 1024 * 1024,
  disabledCommands: ["STARTTLS", "AUTH"],
  onData(stream, session, cb) {
    let raw = "";
    stream.on("data", (c) => (raw += c.toString()));
    stream.on("end", () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(","), raw }); cb(); });
  },
});

const { createApp } = await import("../src/create-app.js");
const { prisma } = await import("../src/db.js");
const { schoolRecord } = await import("./fixtures.js");

let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const H = { "content-type": "application/json", "x-nasoi-client": "web" };
let admin = "", deo = "", vr = "", other = "";
const DEO = "DEO-03-2026";
const VR = "VR-02-2026";
const OTHER = "DEO-02-2026"; // a DEO who does not work with VR-02-2026
let entryId = "";
const soon = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

const login = async (loginId: string, password: string) =>
  (await (await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ loginId, password }) })).json()).accessToken as string;
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(base + "/api/v1" + path, { method, headers: { ...H, authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  const db = prisma();
  await db.assignment.deleteMany({ where: { deoId: DEO } });
  await db.connectRequest.deleteMany({ where: { OR: [{ fromId: { in: [DEO, VR, OTHER] } }, { toId: { in: [DEO, VR, OTHER] } }] } });
  await db.meeting.deleteMany({ where: { createdById: { in: [DEO, VR, "ADMIN"] } } });
  await db.user.updateMany({ where: { id: { in: [DEO, VR] } }, data: { meetingLink: null } });
  const a = await db.assignment.create({
    data: {
      id: `ASG-TEST-${Date.now()}`, deoId: DEO, assignedById: "ADMIN", taskType: "Data Entry Services", target: 5, ratePerEntry: 10,
      verifierId: VR, verifierRate: 2, state: "Uttar Pradesh", district: "Meerut", block: "", village: "", pincode: "250499",
      deadline: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const rec = schoolRecord();
  entryId = `ENT9${String(Date.now()).slice(-8)}`;
  await db.entry.create({
    data: { id: entryId, assignmentId: a.id, deoId: DEO, state: a.state, district: a.district, pincode: a.pincode, recordCode: rec.udiseCode, recordName: "GPS Connect", data: rec, ratePerEntry: 10, verifierId: VR },
  });
  await new Promise<void>((r) => smtp.listen(2592, "127.0.0.1", r));
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [admin, deo, vr, other] = await Promise.all([login("ADMIN", "Admin@2026"), login(DEO, "Abcd@2026"), login(VR, "Abcd@2026"), login(OTHER, "Abcd@2026")]);
});
after(async () => {
  await prisma().assignment.deleteMany({ where: { deoId: DEO } });
  server.close();
  smtp.close();
  await prisma().$disconnect();
});

const wait = () => new Promise((r) => setTimeout(r, 300));

describe("connect: meetings and requests", () => {
  test("personal meeting link: only Zoom / Google Meet / Teams, shown on cards", async () => {
    assert.equal((await call(deo, "PATCH", "/profile/me/meeting-link", { link: "http://zoom.us/j/1" })).status, 400);
    assert.equal((await call(deo, "PATCH", "/profile/me/meeting-link", { link: "https://evil.example.com/j/1" })).status, 400);
    const ok = await call(vr, "PATCH", "/profile/me/meeting-link", { link: "https://meet.google.com/abc-defg-hij" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).platform, "google_meet");
    const me = await (await call(vr, "GET", "/profile/me")).json();
    assert.equal(JSON.stringify(me).includes("meet.google.com/abc-defg-hij"), true);
    const work = await (await call(deo, "GET", "/me/assignments")).json();
    assert.equal(work.current.verifier.platform, "google_meet", "the DEO sees the verifier's meeting room");
  });

  test("contacts: DEO ↔ their verifier and the admin only; photos follow the same rule", async () => {
    const c = (await (await call(deo, "GET", "/connect/contacts")).json()).contacts as { id: string; role: string; mobile: string | null }[];
    assert.ok(c.some((x) => x.id === VR) && c.some((x) => x.id === "ADMIN"));
    assert.ok(!c.some((x) => x.id === OTHER), "other DEOs are not contacts");
    assert.equal(c.find((x) => x.id === "ADMIN")!.mobile, null, "admin mobile hidden from employees");
    const v = (await (await call(vr, "GET", "/connect/contacts")).json()).contacts as { id: string }[];
    assert.ok(v.some((x) => x.id === DEO));
    assert.notEqual((await call(other, "GET", `/users/${VR}/photo`)).status, 200, "a stranger cannot see the photo");
  });

  test("schedule a Zoom meeting: participants get a notification and an e-mail", async () => {
    mails.length = 0;
    const bad = await call(vr, "POST", "/connect/meetings", { title: "Check", link: "https://zoom.us/j/123", startsAt: soon(60), participantIds: [OTHER] });
    assert.equal(bad.status, 403, "only people you work with");
    const past = await call(vr, "POST", "/connect/meetings", { title: "Check", link: "https://zoom.us/j/123", startsAt: soon(-60), participantIds: [DEO] });
    assert.equal(past.status, 400);
    const r = await call(vr, "POST", "/connect/meetings", {
      title: "Entry corrections", link: "https://us02web.zoom.us/j/8123456789?pwd=abc", startsAt: soon(90), durationMin: 45,
      notes: "Bring the school register", participantIds: [DEO, "ADMIN"], entryId,
    });
    assert.equal(r.status, 201);
    const m = (await r.json()).meeting;
    assert.match(m.id, /^MTG\d{6}$/);
    assert.equal(m.platform, "zoom");
    assert.equal(m.state, "upcoming");
    assert.equal(m.participants.length, 3);
    await wait();
    assert.equal(mails.length, 2, "DEO and admin are e-mailed, not the organiser");
    const toDeo = mails.find((x) => x.to === "sunil.demo@example.com")!;
    assert.ok(/Subject: .*Zoom meeting: Entry corrections/.test(toDeo.raw.replace(/=\r?\n/g, "")) || toDeo.raw.includes("Zoom"), "subject names Zoom");
    assert.ok(toDeo.raw.replace(/=\r?\n/g, "").includes("us02web.zoom.us/j/8123456789"), "join link in the e-mail");
    const n = await (await call(deo, "GET", "/notifications")).json();
    assert.ok(n.notifications.some((x: { title: string; link: string }) => x.title.includes("Zoom meeting: Entry corrections") && x.link === "/deo/connect"));
    const list = (await (await call(deo, "GET", "/connect/meetings?view=upcoming")).json()).meetings;
    assert.ok(list.some((x: { id: string }) => x.id === m.id));
    const sum = await (await call(deo, "GET", "/connect/summary")).json();
    assert.ok(sum.upcoming >= 1 && sum.next[0].link);
    // Only the organiser (or admin) cancels; everyone is told.
    assert.equal((await call(deo, "POST", `/connect/meetings/${m.id}/cancel`)).status, 403);
    mails.length = 0;
    const c = await call(vr, "POST", `/connect/meetings/${m.id}/cancel`);
    assert.equal(c.status, 200);
    assert.equal((await c.json()).meeting.state, "cancelled");
    await wait();
    assert.equal(mails.length, 2);
    assert.ok(mails.every((x) => x.raw.includes("Cancelled")));
  });

  test("requests: entry request and meeting request, answered with a Google Meet", async () => {
    mails.length = 0;
    const noEntry = await call(deo, "POST", "/connect/requests", { kind: "entry", toId: VR, message: "Please check again" });
    assert.equal(noEntry.status, 400, "entry request needs the entry ID");
    const notMine = await call(other, "POST", "/connect/requests", { kind: "entry", toId: "ADMIN", entryId, message: "Please check" });
    assert.equal(notMine.status, 404, "only your own entries");
    const er = await call(deo, "POST", "/connect/requests", { kind: "entry", toId: VR, entryId, message: "I corrected the UDISE code, please verify first." });
    assert.equal(er.status, 201);
    const req1 = (await er.json()).request;
    assert.match(req1.id, /^REQ\d{6}$/);
    assert.equal(req1.subject, `Request about an entry – ${entryId}`);
    await wait();
    assert.ok(mails.some((x) => x.to === "verifier2.demo@example.com" && x.raw.includes("Entry request")));
    const inbox = (await (await call(vr, "GET", "/connect/requests?box=inbox")).json()).requests;
    assert.ok(inbox.some((x: { id: string; incoming: boolean }) => x.id === req1.id && x.incoming));
    assert.equal((await call(deo, "POST", `/connect/requests/${req1.id}/respond`, { action: "accept" })).status, 403, "sender cannot accept");
    assert.equal((await call(vr, "POST", `/connect/requests/${req1.id}/respond`, { action: "decline" })).status, 400, "decline needs a reason");
    mails.length = 0;
    const acc = await call(vr, "POST", `/connect/requests/${req1.id}/respond`, { action: "accept", reply: "OK, checking it today." });
    assert.equal((await acc.json()).request.status, "accepted");
    await wait();
    assert.ok(mails.some((x) => x.to === "sunil.demo@example.com" && x.raw.includes("accepted")));

    const mr = await call(deo, "POST", "/connect/requests", { kind: "meeting", toId: VR, message: "Can we discuss the rejected entries?", preferredAt: soon(120) });
    const req2 = (await mr.json()).request;
    const sched = await call(vr, "POST", "/connect/meetings", { title: "Rejected entries", link: "https://meet.google.com/abc-defg-hij", startsAt: soon(120), participantIds: [], requestId: req2.id });
    assert.equal(sched.status, 201, "the requester is added automatically");
    const meeting = (await sched.json()).meeting;
    assert.equal(meeting.platform, "google_meet");
    assert.ok(meeting.participants.some((p: { id: string }) => p.id === DEO));
    const sent = (await (await call(deo, "GET", "/connect/requests?box=sent")).json()).requests;
    const r2 = sent.find((x: { id: string }) => x.id === req2.id);
    assert.equal(r2.status, "accepted");
    assert.equal(r2.meetingId, meeting.id);
  });
});

describe("admin overview", () => {
  test("contacts come only from CURRENT work: old areas are not visible", async () => {
    const db = prisma();
    const old = await db.assignment.create({
      data: {
        id: `ASG-OLD-${Date.now()}`, deoId: OTHER, assignedById: "ADMIN", taskType: "Data Entry Services", target: 1, ratePerEntry: 10,
        verifierId: VR, state: "Uttar Pradesh", district: "Meerut", block: "", village: "", pincode: "250498",
        deadline: new Date(Date.now() + 86_400_000), status: "completed",
      },
    });
    const ids = (await (await call(vr, "GET", "/connect/contacts")).json()).contacts.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(DEO) && ids.includes("ADMIN"), "current DEO and admin");
    assert.ok(!ids.includes(OTHER), "DEO of a completed area is not a contact");
    assert.ok(!ids.some((id: string) => id.startsWith("VR-")), "no other verifier");
    const deoIds = (await (await call(deo, "GET", "/connect/contacts")).json()).contacts.map((c: { id: string }) => c.id);
    assert.deepEqual(deoIds.sort(), ["ADMIN", VR].sort());
    await db.assignment.delete({ where: { id: old.id } });
  });

  test("admin sends to all / all DEOs / all verifiers / chosen people; employees cannot", async () => {
    const db = prisma();
    const activeDeos = await db.user.count({ where: { role: "deo", status: "active" } });
    const activeVrs = await db.user.count({ where: { role: "verifier", status: "active" } });
    mails.length = 0;
    const m = await call(admin, "POST", "/connect/meetings", { title: "All DEO briefing", link: "https://meet.google.com/abc-defg-hij", startsAt: soon(90), audience: "all_deo" });
    assert.equal(m.status, 201);
    const mj = (await m.json()).meeting;
    assert.equal(mj.participants.filter((p: { role: string }) => p.role === "deo").length, activeDeos);
    assert.ok(mj.participants.every((p: { role: string }) => p.role !== "verifier"));
    await wait();
    assert.ok(mails.length >= activeDeos, "every DEO is e-mailed");
    const allM = await call(admin, "POST", "/connect/meetings", { title: "Everyone", link: "https://zoom.us/j/123456789", startsAt: soon(120), audience: "all" });
    assert.equal((await allM.json()).meeting.participants.length, activeDeos + activeVrs + 1);

    const r = await call(admin, "POST", "/connect/requests", { kind: "general", audience: "all_vr", subject: "Speed up", message: "Please finish pending verification today." });
    assert.equal(r.status, 201);
    const rj = await r.json();
    assert.equal(rj.sent, activeVrs);
    assert.ok(rj.request.groupId?.startsWith("GRP"));
    const inbox = (await (await call(vr, "GET", "/connect/requests")).json()).requests;
    assert.ok(inbox.some((x: { subject: string }) => x.subject === "Speed up"), "verifier received it");
    const pick = await call(admin, "POST", "/connect/requests", { kind: "general", toIds: [DEO, VR], message: "Two people only, please." });
    assert.equal((await pick.json()).sent, 2);

    assert.equal((await call(deo, "POST", "/connect/meetings", { title: "Everyone call", link: "https://zoom.us/j/123456789", startsAt: soon(30), audience: "all" })).status, 403);
    assert.equal((await call(vr, "POST", "/connect/requests", { kind: "general", audience: "all_deo", message: "Hello everyone" })).status, 403);
    assert.equal((await call(vr, "POST", "/connect/requests", { kind: "general", toIds: [DEO, "ADMIN"], message: "Hello both of you" })).status, 403);
    assert.equal((await call(admin, "POST", "/connect/requests", { kind: "general", message: "No receiver here" })).status, 400);
    await db.meeting.deleteMany({ where: { title: { in: ["All DEO briefing", "Everyone"] } } });
    await db.connectRequest.deleteMany({ where: { fromId: "ADMIN", subject: { in: ["Speed up", "Request"] } } });
  });

  test("numbers come from the database", async () => {
    const r = await call(admin, "GET", "/admin/overview");
    assert.equal(r.status, 200);
    const o = await r.json();
    const db = prisma();
    assert.equal(o.entries.total, await db.entry.count());
    assert.equal(o.entries.pending, await db.entry.count({ where: { status: "pending" } }));
    assert.equal(o.employees.deo.total, await db.user.count({ where: { role: "deo" } }));
    assert.equal(o.work.active, await db.assignment.count({ where: { status: "active" } }));
    const vrEarned = await db.verification.aggregate({ where: { decision: "approved" }, _sum: { rate: true } });
    assert.equal(o.money.verifierEarned, vrEarned._sum.rate ?? 0);
    assert.equal(o.money.balance, o.money.earned - o.money.paid);
    assert.ok(Array.isArray(o.monthly) && Array.isArray(o.topDeos) && Array.isArray(o.recentEmployees));
    assert.equal((await call(deo, "GET", "/admin/overview")).status, 403);
  });
});
