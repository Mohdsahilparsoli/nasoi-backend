// DEO school entries: rules, ownership, summary. Run: npm test
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
let admin = "", deo = "", other = "";
const DEO = "DEO128";
const PIN = String(300000 + Math.floor(Math.random() * 600000));
const udise = () => String(Math.floor(1e10 + Math.random() * 8.9e10));

const login = async (loginId: string, password: string) =>
  (await (await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ loginId, password }) })).json()).accessToken as string;
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(base + "/api/v1" + path, { method, headers: { ...H, authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
const school = (over: Record<string, unknown> = {}) => ({
  udiseCode: udise(), schoolName: "  Govt.   Primary School Kithore ", educationalBlock: "Mawana", ruralUrban: "Rural", cluster: "Kithore",
  lgdBlock: "Mawana", lgdPanchayat: "Kithore", lgdVillage: "Kithore", schoolCategory: "Primary only (1-5)",
  schoolManagement: "Department of Education", yearEstablished: 1965, yearRecognitionPri: 1970, schoolType: "Co-educational", ...over,
});
let asgId = "";

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await prisma().assignment.deleteMany({ where: { deoId: DEO } }); // cascades to entries
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [admin, deo, other] = await Promise.all([login("ADMIN", "Admin@2026"), login(DEO, "Abcd@2026"), login("VR101", "Abcd@2026")]);
});
after(async () => {
  server.close();
  await prisma().$disconnect();
});

describe("DEO school entries", () => {
  test("no active work → cannot add entries", async () => {
    const r = await call(deo, "POST", "/me/entries", school());
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "NO_ACTIVE_WORK");
  });

  test("only a DEO can use entry APIs", async () => {
    assert.equal((await call(other, "GET", "/me/entries")).status, 403);
    assert.equal((await fetch(base + "/api/v1/me/summary")).status, 401);
  });

  test("validation: UDISE 11 digits, choices, years", async () => {
    const r = await call(deo, "POST", "/me/entries", school({ udiseCode: "12345", ruralUrban: "City", yearEstablished: 2990, schoolType: "" }));
    assert.equal(r.status, 400);
    const paths = (await r.json()).error.fields.map((f: { path: string }) => f.path);
    for (const p of ["udiseCode", "ruralUrban", "yearEstablished", "schoolType"]) assert.ok(paths.includes(p), p);
    const r2 = await call(deo, "POST", "/me/entries", school({ yearEstablished: 1990, yearRecognitionPri: 1980 }));
    assert.equal(r2.status, 400);
    assert.match(JSON.stringify(await r2.json()), /cannot be before/);
  });

  test("entry goes into the current assignment with its state, district, PIN and rate", async () => {
    const a = await call(admin, "POST", "/admin/assignments", {
      deoId: DEO, taskType: "Data Entry Services", target: 2, ratePerEntry: 12, state: "Uttar Pradesh", district: "Meerut",
      block: "Mawana", village: "Kithore", pincode: PIN, deadline: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    });
    assert.equal(a.status, 201);
    asgId = (await a.json()).assignment.id;
    const r = await call(deo, "POST", "/me/entries", school({ yearRecognitionPri: "" }));
    assert.equal(r.status, 201);
    const { entry } = await r.json();
    assert.match(entry.id, /^ENT\d{6}$/);
    assert.equal(entry.assignmentId, asgId);
    assert.deepEqual(entry.area, { state: "Uttar Pradesh", district: "Meerut", pincode: PIN });
    assert.equal(entry.ratePerEntry, undefined, "DEO must not see the per-entry rate");
    assert.equal(entry.status, "pending");
    assert.equal(entry.school.schoolName, "Govt. Primary School Kithore");
    assert.equal(entry.school.yearRecognitionPri, null);
  });

  test("same UDISE code cannot be entered twice", async () => {
    const code = udise();
    assert.equal((await call(deo, "POST", "/me/entries", school({ udiseCode: code }))).status, 201);
    const r = await call(deo, "POST", "/me/entries", school({ udiseCode: code }));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "DUPLICATE_UDISE");
  });

  test("target reached → no more entries", async () => {
    const r = await call(deo, "POST", "/me/entries", school());
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "TARGET_REACHED");
  });

  test("list, get, edit pending; rejected entry can be fixed and resubmitted", async () => {
    const { entries } = await (await call(deo, "GET", "/me/entries")).json();
    assert.equal(entries.length, 2);
    const id = entries[0].id;
    assert.equal((await (await call(deo, "GET", `/me/entries/${id}`)).json()).entry.id, id);
    const u = await call(deo, "PATCH", `/me/entries/${id}`, school({ udiseCode: entries[0].school.udiseCode, schoolName: "GPS Kithore" }));
    assert.equal(u.status, 200);
    assert.equal((await u.json()).entry.school.schoolName, "GPS Kithore");

    // A verifier rejects it (verifier module comes later – simulate in the DB).
    await prisma().entry.update({ where: { id }, data: { status: "rejected", rejectReason: "UDISE code does not match", verifiedAt: new Date() } });
    const s1 = await (await call(deo, "GET", "/me/summary")).json();
    assert.equal(s1.totals.rejected, 1);
    assert.equal(s1.currentProgress.submitted, 1);
    const re = await call(deo, "PATCH", `/me/entries/${id}`, school({ udiseCode: entries[0].school.udiseCode }));
    assert.equal(re.status, 200);
    const e = (await re.json()).entry;
    assert.equal(e.status, "pending");
    assert.equal(e.resubmitCount, 1);
  });

  test("approved entries are final; other users' entries are not visible", async () => {
    const { entries } = await (await call(deo, "GET", "/me/entries")).json();
    await prisma().entry.update({ where: { id: entries[1].id }, data: { status: "approved", verifiedAt: new Date() } });
    const r = await call(deo, "PATCH", `/me/entries/${entries[1].id}`, school({ udiseCode: entries[1].school.udiseCode }));
    assert.equal(r.status, 409);
    const deo2 = await login("DEO127", "Abcd@2026");
    assert.equal((await call(deo2, "GET", `/me/entries/${entries[1].id}`)).status, 404);
  });

  test("summary: totals, earnings = approved × rate, month-wise; admin sees progress", async () => {
    const s = await (await call(deo, "GET", "/me/summary")).json();
    assert.equal(s.totals.total, 2);
    assert.equal(s.totals.approved, 1);
    assert.equal(s.totals.pending, 1);
    assert.equal(s.totals.earnings, 12);
    assert.equal(s.totals.pendingValue, undefined);
    const work = await (await call(deo, "GET", "/me/assignments")).json();
    assert.equal(work.current.ratePerEntry, undefined, "DEO must not see the rate of the work");
    assert.equal(s.monthly.length, 1);
    assert.deepEqual(s.currentProgress, { assignmentId: asgId, target: 2, submitted: 2, approved: 1, pending: 1, rejected: 0 });
    const { assignments } = await (await call(admin, "GET", `/admin/assignments?deoId=${DEO}`)).json();
    assert.deepEqual(assignments[0].progress, { submitted: 2, approved: 1, rejected: 0 });
  });

  test("closed work: entries can no longer be changed", async () => {
    await call(admin, "PATCH", `/admin/assignments/${asgId}`, { status: "completed" });
    const { entries } = await (await call(deo, "GET", "/me/entries?status=pending")).json();
    const r = await call(deo, "PATCH", `/me/entries/${entries[0].id}`, school({ udiseCode: entries[0].school.udiseCode }));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "WORK_CLOSED");
  });
});
