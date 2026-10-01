// Verifier: automatic assignment, approve / reject, income, settings. Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "test";
delete process.env.SMTP_HOST;

const { createApp } = await import("../src/create-app.js");
const { prisma } = await import("../src/db.js");

let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const H = { "content-type": "application/json", "x-nasoi-client": "web" };
let admin = "", deo = "", vr = "", vr2 = "";
const DEO = "DEO129";
const PIN = String(300000 + Math.floor(Math.random() * 600000));
const udise = () => String(Math.floor(1e10 + Math.random() * 8.9e10));
const login = async (loginId: string, password: string) =>
  (await (await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ loginId, password }) })).json()).accessToken as string;
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(base + "/api/v1" + path, { method, headers: { ...H, authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
const school = (over: Record<string, unknown> = {}) => ({
  udiseCode: udise(), schoolName: "GPS Test", educationalBlock: "Mawana", ruralUrban: "Rural", cluster: "Kithore", lgdBlock: "Mawana",
  lgdPanchayat: "Kithore", lgdVillage: "Kithore", schoolCategory: "Primary only (1-5)", schoolManagement: "Department of Education",
  yearEstablished: 1980, schoolType: "Co-educational", ...over,
});
const ids: string[] = [];
const summary = async () => (await call(vr, "GET", "/verifier/summary")).json();

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await prisma().assignment.deleteMany({ where: { deoId: DEO } });
  await prisma().verification.deleteMany({ where: { verifierId: "VR101" } });
  await prisma().entry.updateMany({ where: { verifierId: "VR101" }, data: { verifierId: null, status: "approved" } });
  await prisma().notification.deleteMany({ where: { userId: DEO } });
  await prisma().appSetting.upsert({ where: { id: 1 }, create: { id: 1 }, update: { verifierRate: 2 } });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [admin, deo, vr, vr2] = await Promise.all([login("ADMIN", "Admin@2026"), login(DEO, "Abcd@2026"), login("VR101", "Abcd@2026"), login("VR102", "Abcd@2026")]);
});
after(async () => {
  server.close();
  await prisma().$disconnect();
});

describe("verifier", () => {
  test("only verifiers can use verifier APIs; only admin can change settings", async () => {
    assert.equal((await call(deo, "GET", "/verifier/summary")).status, 403);
    assert.equal((await call(vr, "GET", "/admin/settings")).status, 403);
    const s = await (await call(admin, "GET", "/admin/settings")).json();
    assert.equal(s.settings.verifierRate, 2);
  });

  test("new entries are assigned to an active verifier automatically", async () => {
    const a = await call(admin, "POST", "/admin/assignments", {
      deoId: DEO, taskType: "Data Entry Services", target: 5, ratePerEntry: 10, state: "Uttar Pradesh", district: "Meerut",
      block: "Mawana", village: "Kithore", pincode: PIN, deadline: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    });
    assert.equal(a.status, 201);
    for (let i = 0; i < 3; i++) {
      const r = await call(deo, "POST", "/me/entries", school());
      assert.equal(r.status, 201);
      ids.push((await r.json()).entry.id);
    }
    const rows = await prisma().entry.findMany({ where: { id: { in: ids } }, include: { verifier: true } });
    for (const r of rows) {
      assert.ok(r.verifierId, "has a verifier");
      assert.equal(r.verifier!.role, "verifier");
      assert.equal(r.verifier!.status, "active");
    }
    // Make the rest of the test deterministic: give them to VR101.
    await prisma().entry.updateMany({ where: { id: { in: ids } }, data: { verifierId: "VR101" } });
  });

  test("summary and pending queue", async () => {
    const s = await summary();
    assert.equal(s.totalAssigned, 3);
    assert.equal(s.pending, 3);
    assert.equal(s.approved + s.rejected + s.income, 0);
    assert.equal(s.rate, 2);
    const { entries } = await (await call(vr, "GET", "/verifier/entries")).json();
    assert.deepEqual(entries.map((e: { id: string }) => e.id), ids); // oldest first
    assert.equal(entries[0].deo.id, DEO);
    assert.equal(entries[0].assignment.taskType, "Data Entry Services");
  });

  test("reject needs a reason; DEO is notified", async () => {
    const bad = await call(vr, "POST", `/verifier/entries/${ids[0]}/decision`, { decision: "rejected", reason: "no" });
    assert.equal(bad.status, 400);
    const r = await call(vr, "POST", `/verifier/entries/${ids[0]}/decision`, { decision: "rejected", reason: "UDISE code does not match the school" });
    assert.equal(r.status, 200);
    const e = await (await call(deo, "GET", `/me/entries/${ids[0]}`)).json();
    assert.equal(e.entry.status, "rejected");
    assert.equal(e.entry.rejectReason, "UDISE code does not match the school");
    const n = await (await call(deo, "GET", "/notifications")).json();
    assert.ok(n.notifications.some((x: { title: string; link: string }) => x.title.includes("rejected") && x.link === `/deo/entries/${ids[0]}`));
  });

  test("approve once; second decision and other verifiers are refused", async () => {
    assert.equal((await call(vr2, "POST", `/verifier/entries/${ids[1]}/decision`, { decision: "approved" })).status, 404);
    assert.equal((await call(vr2, "GET", `/verifier/entries/${ids[1]}`)).status, 404);
    const [a, b] = await Promise.all([
      call(vr, "POST", `/verifier/entries/${ids[1]}/decision`, { decision: "approved" }),
      call(vr, "POST", `/verifier/entries/${ids[1]}/decision`, { decision: "approved" }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(await prisma().verification.count({ where: { entryId: ids[1] } }), 1);
  });

  test("resubmitted entry returns to the same verifier", async () => {
    const e = (await (await call(deo, "GET", `/me/entries/${ids[0]}`)).json()).entry;
    const r = await call(deo, "PATCH", `/me/entries/${ids[0]}`, { ...e.school, schoolName: "GPS Test Corrected" });
    assert.equal(r.status, 200);
    const row = await prisma().entry.findUniqueOrThrow({ where: { id: ids[0] } });
    assert.equal(row.status, "pending");
    assert.equal(row.verifierId, "VR101");
    const detail = await (await call(vr, "GET", `/verifier/entries/${ids[0]}`)).json();
    assert.equal(detail.entry.history.length, 1);
    assert.equal(detail.entry.history[0].decision, "rejected");
  });

  test("income = rate per verified entry; rate change applies to new decisions only", async () => {
    let s = await summary();
    assert.equal(s.approved, 1);
    assert.equal(s.rejected, 1);
    assert.equal(s.income, 4);
    assert.equal(s.pending, 2);
    assert.equal(s.verifiedToday, 2);
    assert.equal(s.monthly.length, 1);
    const up = await call(admin, "PATCH", "/admin/settings", { verifierRate: 3, defaultDeoRate: 10, payoutWindow: "15th – 25th of every month" });
    assert.equal(up.status, 200);
    assert.equal((await call(vr, "POST", `/verifier/entries/${ids[2]}/decision`, { decision: "approved" })).status, 200);
    s = await summary();
    assert.equal(s.income, 7);
    assert.equal(s.rate, 3);
    const h = await (await call(vr, "GET", "/verifier/history?decision=approved")).json();
    assert.equal(h.history.length, 2);
    assert.equal(h.history[0].entry.id, ids[2]);
    assert.equal(h.history[0].rate, 3);
    await call(admin, "PATCH", "/admin/settings", { verifierRate: 2, defaultDeoRate: 10, payoutWindow: "15th – 25th of every month" });
  });

  test("entries without a verifier are picked up by the next verifier who opens the queue", async () => {
    const r = await call(deo, "POST", "/me/entries", school());
    const id = (await r.json()).entry.id;
    await prisma().entry.update({ where: { id }, data: { verifierId: null } });
    const { entries } = await (await call(vr, "GET", "/verifier/entries?view=all")).json();
    assert.ok(entries.some((e: { id: string }) => e.id === id));
  });
});
