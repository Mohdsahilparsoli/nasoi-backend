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
const DEO = "DEO-03-2026";
const PIN = String(300000 + Math.floor(Math.random() * 600000));
const udise = () => String(Math.floor(1e10 + Math.random() * 8.9e10));

const login = async (loginId: string, password: string) =>
  (await (await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ loginId, password }) })).json()).accessToken as string;
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(base + "/api/v1" + path, { method, headers: { ...H, authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
const { schoolRecord: school } = await import("./fixtures.js");
let asgId = "";

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await prisma().assignment.deleteMany({ where: { deoId: DEO } }); // cascades to entries
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [admin, deo, other] = await Promise.all([login("ADMIN", "Admin@2026"), login(DEO, "Abcd@2026"), login("VR-01-2026", "Abcd@2026")]);
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

  test("form rules: urban schools need ULB + ward, class range, pucca blocks", async () => {
    // Uses the validator directly (no active work needed).
    const { recordSchema } = await import("../src/modules/entries/forms.js");
    const urban = recordSchema("school").safeParse(school({ ruralUrban: "Urban", urbanLocalBody: "", lgdWard: "" }));
    assert.equal(urban.success, false);
    const paths = urban.error!.issues.map((i) => i.path.join("."));
    assert.ok(paths.includes("urbanLocalBody") && paths.includes("lgdWard"));
    const ok = recordSchema("school").parse(school({ ruralUrban: "Urban", urbanLocalBody: "Etah-Municipality", lgdWard: "Etah (MB) - Ward No.13" }));
    assert.equal(ok.lgdVillage, undefined, "rural-only fields dropped for urban schools");
    const bad = recordSchema("school").safeParse(school({ lowestClass: "6", highestClass: "5", buildingBlocks: 2, puccaBuildingBlocks: 3 }));
    const p2 = bad.error!.issues.map((i) => i.path.join("."));
    assert.ok(p2.includes("highestClass") && p2.includes("puccaBuildingBlocks"));
    const typed = recordSchema("school").parse(school({ medium1: "Bhojpuri", schoolManagement: "Trust run" }));
    assert.equal(typed.medium1, "Bhojpuri", "dropdown fields also accept typed values");
  });

  test("entry goes into the current assignment with its state, district, PIN and rate", async () => {
    const a = await call(admin, "POST", "/admin/assignments", {
      deoId: DEO, taskType: "Data Entry Services", recordType: "school", verifierId: "VR-01-2026", verifierRate: 2,
      target: 2, ratePerEntry: 12, state: "Uttar Pradesh", district: "Meerut",
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
    assert.equal(entry.recordType, "school");
    assert.equal(entry.name, "Govt. Primary School Kithore");
    assert.equal(entry.data.schoolName, "Govt. Primary School Kithore");
    assert.equal(entry.data.ruralUrban, "Rural", "strict choice normalised");
    assert.equal(entry.data.yearRecognitionPri, undefined, "blank optional field not stored");
    assert.equal(entry.data.urbanLocalBody, undefined);
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

  test("same UDISE code cannot be entered twice", async () => {
    const code = udise();
    assert.equal((await call(deo, "POST", "/me/entries", school({ udiseCode: code }))).status, 201);
    const r = await call(deo, "POST", "/me/entries", school({ udiseCode: code }));
    assert.equal(r.status, 409);
    const err = (await r.json()).error;
    assert.equal(err.code, "DUPLICATE_CODE");
    assert.equal(err.fields[0].path, "udiseCode");
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
    const u = await call(deo, "PATCH", `/me/entries/${id}`, school({ udiseCode: entries[0].code, schoolName: "GPS Kithore" }));
    assert.equal(u.status, 200);
    assert.equal((await u.json()).entry.name, "GPS Kithore");

    // A verifier rejects it (verifier module comes later – simulate in the DB).
    await prisma().entry.update({ where: { id }, data: { status: "rejected", rejectReason: "UDISE code does not match", verifiedAt: new Date() } });
    const s1 = await (await call(deo, "GET", "/me/summary")).json();
    assert.equal(s1.totals.rejected, 1);
    assert.equal(s1.currentProgress.submitted, 1);
    const re = await call(deo, "PATCH", `/me/entries/${id}`, school({ udiseCode: entries[0].code }));
    assert.equal(re.status, 200);
    const e = (await re.json()).entry;
    assert.equal(e.status, "pending");
    assert.equal(e.resubmitCount, 1);
  });

  test("approved entries are final; other users' entries are not visible", async () => {
    const { entries } = await (await call(deo, "GET", "/me/entries")).json();
    await prisma().entry.update({ where: { id: entries[1].id }, data: { status: "approved", verifiedAt: new Date() } });
    const r = await call(deo, "PATCH", `/me/entries/${entries[1].id}`, school({ udiseCode: entries[1].code }));
    assert.equal(r.status, 409);
    const deo2 = await login("DEO-02-2026", "Abcd@2026");
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
    const r = await call(deo, "PATCH", `/me/entries/${entries[0].id}`, school({ udiseCode: entries[0].code }));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "WORK_CLOSED");
  });

  test("college work uses the college form", async () => {
    const a = await call(admin, "POST", "/admin/assignments", {
      deoId: DEO, taskType: "Data Entry Services", recordType: "college", verifierId: "VR-01-2026", verifierRate: 3,
      target: 2, ratePerEntry: 15, state: "Uttar Pradesh", district: "Meerut", block: "Mawana", village: "Kithore", pincode: PIN,
      deadline: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    });
    assert.equal(a.status, 201);
    const school1 = await call(deo, "POST", "/me/entries", school());
    assert.equal(school1.status, 400, "school fields are not valid for college work");
    const aishe = `C-${Math.floor(10000 + Math.random() * 89999)}`;
    const r = await call(deo, "POST", "/me/entries", {
      aisheCode: aishe.toLowerCase(), collegeName: "Govt. Degree College Mawana", affiliatingUniversity: "CCS University, Meerut",
      collegeType: "Affiliated College", management: "Government", ruralUrban: "Urban", block: "Mawana", address: "Main Road, Mawana",
      yearEstablished: 1972, collegeFor: "Co-education", courseLevel: "UG & PG", contactNumber: "9876543210",
    });
    assert.equal(r.status, 201);
    const { entry } = await r.json();
    assert.equal(entry.recordType, "college");
    assert.equal(entry.code, aishe, "code upper-cased");
    assert.equal(entry.name, "Govt. Degree College Mawana");
    const forms = await (await call(deo, "GET", "/entry-forms")).json();
    assert.ok(forms.forms.school.fields.length > 30 && forms.forms.college.fields.length > 10);
  });
});
