// Assign work: rules, notifications, e-mail, access control. Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { SMTPServer } from "smtp-server";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "test";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "2590";
process.env.SMTP_FROM = "NASOI <no-reply@nasoi.test>";
process.env.APP_URL = "https://portal.nasoi.test";
delete process.env.SMTP_USER;

const mails: { to: string; raw: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS", "AUTH"],
  onData(stream, session, cb) {
    let raw = "";
    stream.on("data", (c) => (raw += c.toString()));
    stream.on("end", () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(","), raw }); cb(); });
  },
});

const { createApp } = await import("../src/create-app.js");
const { prisma } = await import("../src/db.js");

let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const H = { "content-type": "application/json", "x-nasoi-client": "web" };
let admin = "";
let deo1 = "";
let deo2 = "";
let vr = "";
const pin = () => String(100000 + Math.floor(Math.random() * 899999)).replace(/^0/, "1");
const PIN1 = pin();
const PIN2 = pin();

const login = async (loginId: string, password: string) =>
  (await (await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ loginId, password }) })).json()).accessToken as string;
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(base + "/api/v1" + path, { method, headers: { ...H, authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const work = (over: Record<string, unknown> = {}) => ({
  deoId: "DEO126", taskType: "Data Entry Services", recordType: "school", verifierId: "VR101", verifierRate: 2, target: 50, ratePerEntry: 10, state: "Uttar Pradesh", district: "Meerut",
  block: "Mawana", village: "Kithore", pincode: PIN1, deadline: tomorrow(), instructions: "Cover all government schools.\nStart with Class 10.", ...over,
});

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await prisma().assignment.deleteMany({ where: { deoId: { in: ["DEO126", "DEO127"] } } });
  await prisma().notification.deleteMany({ where: { userId: { in: ["DEO126", "DEO127"] } } });
  await new Promise<void>((r) => smtp.listen(2590, "127.0.0.1", r));
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [admin, deo1, deo2, vr] = await Promise.all([login("ADMIN", "Admin@2026"), login("DEO126", "Abcd@2026"), login("DEO127", "Abcd@2026"), login("VR101", "Abcd@2026")]);
});
after(async () => {
  server.close();
  smtp.close();
  await prisma().$disconnect();
});

describe("admin: operators and assignments", () => {
  test("only the admin can use admin APIs", async () => {
    assert.equal((await call(deo1, "GET", "/admin/operators")).status, 403);
    assert.equal((await call(vr, "POST", "/admin/assignments", work())).status, 403);
    assert.equal((await fetch(base + "/api/v1/admin/operators")).status, 401);
  });

  test("operators list comes from the database", async () => {
    const r = await call(admin, "GET", "/admin/operators");
    assert.equal(r.status, 200);
    const { operators } = await r.json();
    const d = operators.find((o: { id: string }) => o.id === "DEO126");
    assert.ok(d, "DEO126 listed");
    assert.equal(d.eligible, true);
    assert.equal(d.currentAssignment, null);
    assert.ok(operators.some((o: { id: string }) => o.id === "VR101"), "verifiers are employees too");
    assert.ok(!operators.some((o: { id: string }) => o.id === "ADMIN"), "the admin is not an employee");
    const s = await (await call(admin, "GET", "/admin/operators?q=priya")).json();
    assert.deepEqual(s.operators.map((o: { id: string }) => o.id), ["DEO127"]);
  });

  test("validation", async () => {
    for (const [over, msg] of [
      [{ pincode: "12345" }, /PIN code/], [{ pincode: "012345" }, /PIN code/], [{ deadline: "2020-01-01" }, /past/],
      [{ district: "Patna" }, /district/], [{ target: 0 }, /at least 1/], [{ taskType: "Other" }, /Select the service/],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = await call(admin, "POST", "/admin/assignments", work(over));
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.match((await r.json()).error.message, msg);
    }
    assert.equal((await call(admin, "POST", "/admin/assignments", work({ deoId: "VR101" }))).status, 404, "verifier cannot get DEO work");
  });

  let first = "";
  test("assign work → ID with PIN code, notification + e-mail to the DEO", async () => {
    const r = await call(admin, "POST", "/admin/assignments", work());
    assert.equal(r.status, 201, await r.clone().text());
    const j = await r.json();
    first = j.assignment.id;
    assert.equal(first, `ASG-${PIN1}-001`);
    assert.equal(j.assignment.area.pincode, PIN1);
    assert.equal(j.emailed, true);
    await new Promise((res) => setTimeout(res, 300));
    const mail = mails.find((m) => m.to === "rahul.demo@example.com");
    assert.ok(mail, "e-mail to DEO");
    assert.match(mail!.raw.replace(/=\r?\n/g, ""), new RegExp(first));

    const n = await (await call(deo1, "GET", "/notifications")).json();
    assert.equal(n.unread, 1);
    assert.match(n.notifications[0].body, new RegExp(PIN1));
    assert.equal(n.notifications[0].link, "/deo/work");
  });

  test("DEO sees the work; only the Work page (?seen=1) marks it seen", async () => {
    const peek = await (await call(deo1, "GET", "/me/assignments")).json();
    assert.equal(peek.current.id, first);
    assert.equal(peek.current.seenAt, null);
    const r = await (await call(deo1, "GET", "/me/assignments?seen=1")).json();
    assert.equal(r.current.id, first);
    assert.equal(r.current.target, 50);
    assert.ok(r.current.seenAt);
    assert.equal((await call(admin, "GET", "/me/assignments")).status, 403);
  });

  test("one active assignment per DEO and per PIN code", async () => {
    const busy = await call(admin, "POST", "/admin/assignments", work({ pincode: PIN2 }));
    assert.equal(busy.status, 409);
    assert.match((await busy.json()).error.message, /already has active work/);
    const pinBusy = await call(admin, "POST", "/admin/assignments", work({ deoId: "DEO127" }));
    assert.equal(pinBusy.status, 409);
    assert.match((await pinBusy.json()).error.message, new RegExp(`PIN code ${PIN1} is already assigned to DEO126`));
    const list = await (await call(admin, "GET", "/admin/operators")).json();
    const d = list.operators.find((o: { id: string }) => o.id === "DEO126");
    assert.equal(d.eligible, false);
    assert.equal(d.currentAssignment.id, first);
  });

  test("parallel requests cannot double-assign a DEO", async () => {
    const [a, b] = await Promise.all([
      call(admin, "POST", "/admin/assignments", work({ deoId: "DEO127", pincode: PIN2 })),
      call(admin, "POST", "/admin/assignments", work({ deoId: "DEO127", pincode: pin() })),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    const active = await prisma().assignment.count({ where: { deoId: "DEO127", status: "active" } });
    assert.equal(active, 1);
  });

  test("complete → DEO eligible again; PIN can be assigned again", async () => {
    const done = await call(admin, "PATCH", `/admin/assignments/${first}`, { status: "completed" });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).assignment.status, "completed");
    assert.equal((await call(admin, "PATCH", `/admin/assignments/${first}`, { status: "cancelled" })).status, 409);
    const again = await call(admin, "POST", "/admin/assignments", work());
    assert.equal(again.status, 201);
    assert.equal((await again.json()).assignment.id, `ASG-${PIN1}-002`);
    const mine = await (await call(deo1, "GET", "/me/assignments")).json();
    assert.equal(mine.current.id, `ASG-${PIN1}-002`);
    assert.equal(mine.history[0].id, first);
    const all = await (await call(admin, "GET", `/admin/assignments?q=${PIN1}`)).json();
    assert.equal(all.assignments.length, 2);
  });

  test("employee detail; inactive / rejected / active", async () => {
    const d = await (await call(admin, "GET", "/admin/operators/deo126")).json();
    assert.equal(d.operator.id, "DEO126");
    assert.equal(d.operator.role, "deo");
    assert.equal(d.operator.assignments.length, 2);
    const v = await (await call(admin, "GET", "/admin/operators/VR101")).json();
    assert.equal(v.operator.role, "verifier", "verifiers are employees too");
    const list = await (await call(admin, "GET", "/admin/operators")).json();
    assert.ok(list.operators.some((o: { id: string }) => o.id === "VR101") && list.operators.some((o: { id: string }) => o.id === "DEO126"));
    const deosOnly = await (await call(admin, "GET", "/admin/operators?role=deo")).json();
    assert.ok(deosOnly.operators.every((o: { role: string }) => o.role === "deo"));

    await prisma().assignment.updateMany({ where: { deoId: "DEO127", status: "active" }, data: { status: "cancelled" } });
    // Inactive: can still log in, but gets no work.
    assert.equal((await call(admin, "PATCH", "/admin/operators/DEO127/status", { status: "inactive" })).status, 200);
    assert.equal((await call(deo2, "GET", "/notifications")).status, 200, "inactive employee stays logged in");
    const inactiveAssign = await call(admin, "POST", "/admin/assignments", work({ deoId: "DEO127", pincode: pin() }));
    assert.equal(inactiveAssign.status, 409);
    assert.match((await inactiveAssign.json()).error.message, /inactive/);
    // Reject needs a reason and logs the employee out.
    assert.equal((await call(admin, "PATCH", "/admin/operators/DEO127/status", { status: "rejected" })).status, 400);
    const rej = await call(admin, "PATCH", "/admin/operators/DEO127/status", { status: "rejected", reason: "Aadhaar photo not readable" });
    assert.equal(rej.status, 200);
    assert.equal((await call(deo2, "GET", "/notifications")).status, 401, "rejected employee is logged out");
    const l = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ loginId: "DEO127", password: "Abcd@2026" }) });
    assert.equal(l.status, 403);
    const le = (await l.json()).error;
    assert.equal(le.code, "ACCOUNT_REJECTED");
    assert.match(le.message, /Aadhaar photo not readable/);
    assert.equal((await call(admin, "PATCH", "/admin/operators/DEO127/status", { status: "active" })).status, 200);
    deo2 = await login("DEO127", "Abcd@2026");
    // Block and village are not needed any more.
    const { block: _b, village: _v, ...noArea } = work({ deoId: "DEO127", pincode: pin() });
    const ok = await call(admin, "POST", "/admin/assignments", noArea);
    assert.equal(ok.status, 201);
    await prisma().assignment.updateMany({ where: { deoId: "DEO127", status: "active" }, data: { status: "cancelled" } });
  });

  test("notifications can be marked read", async () => {
    const r = await call(deo1, "POST", "/notifications/read", { all: true });
    assert.equal(r.status, 200);
    assert.equal((await (await call(deo1, "GET", "/notifications")).json()).unread, 0);
  });
});
