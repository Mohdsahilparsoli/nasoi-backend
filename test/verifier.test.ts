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
const raw = (token: string, path: string) => fetch(base + "/api/v1" + path, { headers: { ...H, authorization: `Bearer ${token}` } });
const { schoolRecord: school } = await import("./fixtures.js");
const ids: string[] = [];
const summary = async () => (await call(vr, "GET", "/verifier/summary")).json();

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await prisma().assignment.deleteMany({ where: { deoId: DEO } });
  await prisma().verification.deleteMany({ where: { verifierId: "VR101" } });
  // VR101 starts empty: hand its old entries and any unassigned pending entries to VR102.
  await prisma().entry.updateMany({ where: { OR: [{ verifierId: "VR101" }, { verifierId: null, status: "pending" }] }, data: { verifierId: "VR102" } });
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

  test("entries go to the verifier the admin chose for the area", async () => {
    const a = await call(admin, "POST", "/admin/assignments", {
      deoId: DEO, taskType: "Data Entry Services", recordType: "school", verifierId: "VR101", verifierRate: 2, target: 5, ratePerEntry: 10, state: "Uttar Pradesh", district: "Meerut",
      block: "Mawana", village: "Kithore", pincode: PIN, deadline: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    });
    assert.equal(a.status, 201);
    for (let i = 0; i < 3; i++) {
      const r = await call(deo, "POST", "/me/entries", school());
      assert.equal(r.status, 201);
      ids.push((await r.json()).entry.id);
    }
    const rows = await prisma().entry.findMany({ where: { id: { in: ids } } });
    assert.ok(rows.every((r) => r.verifierId === "VR101"), "all entries with the area's verifier");
    // The DEO sees the verifier's basic card – never the amounts.
    const work = await (await call(deo, "GET", "/me/assignments")).json();
    assert.equal(work.current.verifier.id, "VR101");
    assert.ok(work.current.verifier.name && work.current.verifier.mobile);
    assert.equal(work.current.verifierRate, undefined);
    assert.equal(work.current.ratePerEntry, undefined);
    // …and the verifier sees the area with the DEO's card.
    const { areas } = await (await call(vr, "GET", "/verifier/areas")).json();
    const area = areas.find((x: { id: string }) => x.id === work.current.id);
    assert.equal(area.deo.id, DEO);
    assert.ok(area.deo.mobile);
    assert.equal(area.progress.submitted, 3);
  });

  test("summary and pending queue", async () => {
    const s = await summary();
    assert.equal(s.totalAssigned, 3);
    assert.equal(s.pending, 3);
    assert.equal(s.approved + s.rejected + s.income, 0);
    assert.equal(s.rate, undefined, "verifier must not see the per-entry rate");
    const { entries } = await (await call(vr, "GET", "/verifier/entries")).json();
    assert.deepEqual(entries.map((e: { id: string }) => e.id), ids); // oldest first
    assert.equal(entries[0].deo.id, DEO);
    assert.equal(entries[0].assignment.taskType, "Data Entry Services");
    assert.equal(entries[0].ratePerEntry, undefined, "verifier must not see the DEO rate");
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
    const r = await call(deo, "PATCH", `/me/entries/${ids[0]}`, { ...e.data, schoolName: "GPS Test Corrected" });
    assert.equal(r.status, 200);
    const row = await prisma().entry.findUniqueOrThrow({ where: { id: ids[0] } });
    assert.equal(row.status, "pending");
    assert.equal(row.verifierId, "VR101");
    const detail = await (await call(vr, "GET", `/verifier/entries/${ids[0]}`)).json();
    assert.equal(detail.entry.history.length, 1);
    assert.equal(detail.entry.history[0].decision, "rejected");
  });

  test("income = verifier amount of the area per verified entry", async () => {
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
    assert.equal(s.income, 6, "the area's verifier amount (₹2) is used, not the default in Settings");
    const h = await (await call(vr, "GET", "/verifier/history?decision=approved")).json();
    assert.equal(h.history.length, 2);
    assert.equal(h.history[0].entry.id, ids[2]);
    assert.equal(h.history[0].entry.code.length, 11);
    assert.equal(h.history[0].rate, undefined);
    await call(admin, "PATCH", "/admin/settings", { verifierRate: 2, defaultDeoRate: 10, payoutWindow: "15th – 25th of every month" });
  });

  test("entries without a verifier are picked up by the next verifier who opens the queue", async () => {
    const r = await call(deo, "POST", "/me/entries", school());
    const id = (await r.json()).entry.id;
    await prisma().entry.update({ where: { id }, data: { verifierId: null } });
    const { entries } = await (await call(vr, "GET", "/verifier/entries?view=all")).json();
    assert.ok(entries.some((e: { id: string }) => e.id === id));
  });

  test("admin export: approved only, filters, CSV + Excel, formula-safe", async () => {
    // One more approved entry whose name starts with "=" (must not become a formula).
    const r = await call(deo, "POST", "/me/entries", school({ schoolName: "=HYPERLINK(1)" }));
    const id = (await r.json()).entry.id;
    await prisma().entry.update({ where: { id }, data: { verifierId: "VR101" } });
    assert.equal((await call(vr, "POST", `/verifier/entries/${id}/decision`, { decision: "approved" })).status, 200);
    const approved = await prisma().entry.count({ where: { deoId: DEO, status: "approved" } });

    assert.equal((await raw(vr, `/admin/entries/export?deoId=${DEO}`)).status, 403);
    assert.equal((await raw(admin, "/admin/entries/export?pincode=12")).status, 400);

    const csv = await raw(admin, `/admin/entries/export?format=csv&deoId=${DEO}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-disposition") ?? "", /nasoi-approved-entries_deo129_.*\.csv/);
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for Excel");
    const text = bytes.subarray(3).toString("utf8");
    const lines = text.trim().split("\r\n");
    assert.ok(lines[0].startsWith("S.No,Entry ID,Assignment ID,Service"));
    assert.equal(lines.length - 1, approved, "only approved entries");
    assert.ok(text.includes("'=HYPERLINK(1)"), "formula is neutralised");

    const pinCsv = await (await raw(admin, `/admin/entries/export?format=csv&pincode=${PIN}&verifierId=VR101`)).text();
    assert.equal(pinCsv.trim().split("\r\n").length - 1, approved);
    const none = await (await raw(admin, `/admin/entries/export?format=csv&deoId=${DEO}&from=2099-01-01`)).text();
    assert.equal(none.trim().split("\r\n").length, 1, "date filter: header only");

    const x = await raw(admin, `/admin/entries/export?deoId=${DEO}`);
    assert.equal(x.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()) as never);
    const ws = wb.getWorksheet("Schools")!;
    assert.equal(ws.rowCount - 1, approved);
    assert.equal(ws.getRow(1).getCell(9).value, "UDISE Code");
    assert.equal(typeof ws.getRow(2).getCell(9).value, "string", "UDISE kept as text");
    assert.ok(ws.getRow(1).values!.toString().includes("Medium 1"), "all form fields exported");

    const opts = await (await call(admin, "GET", "/admin/entries/export-options")).json();
    assert.ok(opts.pincodes.some((p: { value: string }) => p.value === PIN));
    assert.ok(opts.deos.some((d: { value: string }) => d.value === DEO));
    const list = await (await call(admin, "GET", `/admin/entries?deoId=${DEO}&status=approved`)).json();
    assert.equal(list.total, approved);
    assert.equal(typeof list.entries[0].ratePerEntry, "number", "admin sees rates");
  });

  test("photos: DEO and the area's verifier see each other's photo; documents stay private", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "me.png");
    const up = await fetch(base + "/api/v1/profile/me/photo", { method: "POST", headers: { "x-nasoi-client": "web", authorization: `Bearer ${deo}` }, body: form });
    assert.equal(up.status, 201);
    const photo = await raw(vr, `/users/${DEO}/photo`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get("content-type"), "image/png");
    assert.equal((await raw(vr2, `/users/${DEO}/photo`)).status, 404, "unrelated verifier cannot see it");
    const bad = new FormData();
    bad.append("file", new Blob([Buffer.from("%PDF-1.4 test")], { type: "image/png" }), "x.png");
    assert.equal((await fetch(base + "/api/v1/profile/me/photo", { method: "POST", headers: { "x-nasoi-client": "web", authorization: `Bearer ${deo}` }, body: bad })).status, 415);
    // A verifier can no longer open a DEO's documents (Aadhaar etc.).
    const doc = await prisma().document.findFirst({ where: { userId: DEO, kind: "photo" } });
    assert.equal((await raw(vr, `/documents/${doc!.id}`)).status, 404);
    assert.equal((await raw(admin, `/documents/${doc!.id}`)).status, 200);
  });

  test("admin can change the verifier of an area; pending entries move", async () => {
    const work = await (await call(deo, "GET", "/me/assignments")).json();
    const r = await call(admin, "PATCH", `/admin/assignments/${work.current.id}/verifier`, { verifierId: "VR102" });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.movedEntries >= 1);
    assert.equal(await prisma().entry.count({ where: { assignmentId: work.current.id, status: "pending", NOT: { verifierId: "VR102" } } }), 0);
    const { verifiers } = await (await call(admin, "GET", "/admin/verifiers")).json();
    assert.ok(verifiers.find((v: { id: string; activeAreas: number }) => v.id === "VR102").activeAreas >= 1);
  });
});
