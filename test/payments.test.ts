// Employees (pending), payouts / receipts, e-mailed exports. Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { SMTPServer } from "smtp-server";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "test";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "2591";
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
const DEO = "DEO129";
const VR = "VR102";
const txn = () => `UTR${Date.now()}${Math.floor(Math.random() * 1000)}`;

const login = async (loginId: string, password: string) =>
  (await (await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ loginId, password }) })).json()).accessToken as string;
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(base + "/api/v1" + path, { method, headers: { ...H, authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await prisma().assignment.deleteMany({ where: { deoId: DEO } });
  await prisma().verification.deleteMany({ where: { verifierId: VR } });
  await prisma().payment.deleteMany({ where: { userId: { in: [DEO, VR] } } });
  await new Promise<void>((r) => smtp.listen(2591, "127.0.0.1", r));
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [admin, deo, vr, other] = await Promise.all([login("ADMIN", "Admin@2026"), login(DEO, "Abcd@2026"), login(VR, "Abcd@2026"), login("DEO127", "Abcd@2026")]);
});
after(async () => {
  server.close();
  smtp.close();
  await prisma().$disconnect();
});

describe("employees, payouts and e-mailed files", () => {
  test("a pending employee can log in but cannot get work until activated", async () => {
    await prisma().user.update({ where: { id: DEO }, data: { status: "pending" } });
    const l = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: JSON.stringify({ loginId: DEO, password: "Abcd@2026" }) });
    assert.equal(l.status, 200);
    assert.equal((await l.json()).user.status, "pending");
    const work = {
      deoId: DEO, taskType: "Data Entry Services", recordType: "school", verifierId: VR, verifierRate: 4, target: 3, ratePerEntry: 15,
      state: "Uttar Pradesh", district: "Meerut", pincode: String(300000 + Math.floor(Math.random() * 600000)),
      deadline: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    };
    assert.equal((await call(admin, "POST", "/admin/assignments", work)).status, 409);
    mails.length = 0;
    assert.equal((await call(admin, "PATCH", `/admin/operators/${DEO}/status`, { status: "active" })).status, 200);
    assert.ok(mails.some((m) => m.raw.includes("is active")), "activation e-mail");
    assert.equal((await call(admin, "POST", "/admin/assignments", work)).status, 201);
    // Two approved entries → DEO earned 2 × ₹15, verifier 2 × ₹4.
    for (let i = 0; i < 2; i++) {
      const r = await call(deo, "POST", "/me/entries", schoolRecord());
      const id = (await r.json()).entry.id;
      assert.equal((await call(vr, "POST", `/verifier/entries/${id}/decision`, { decision: "approved" })).status, 200);
    }
  });

  test("admin records a payment receipt; employee is told; duplicates refused", async () => {
    assert.equal((await call(deo, "POST", "/admin/payments", {})).status, 403);
    const bad = await call(admin, "POST", "/admin/payments", { userId: DEO, amount: 0, transactionId: "!", mode: "Barter", paidOn: "2999-01-01" });
    assert.equal(bad.status, 400);
    const paths = (await bad.json()).error.fields.map((f: { path: string }) => f.path);
    for (const p of ["amount", "transactionId", "mode", "paidOn"]) assert.ok(paths.includes(p), p);
    mails.length = 0;
    const t = txn();
    const r = await call(admin, "POST", "/admin/payments", { userId: DEO, amount: 20, transactionId: t, mode: "UPI", paidOn: today(), entriesCount: 2, notes: "October part payment" });
    assert.equal(r.status, 201);
    const { payment } = await r.json();
    assert.match(payment.id, /^PAY\d{6}$/);
    assert.equal(payment.payeeName.length > 0, true, "payee name defaults to the bank account holder");
    assert.ok(mails.some((m) => m.raw.includes("Payment received") && m.raw.includes(t)), "receipt e-mail");
    const dup = await call(admin, "POST", "/admin/payments", { userId: DEO, amount: 5, transactionId: t, mode: "UPI", paidOn: today() });
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).error.fields[0].path, "transactionId");
    assert.equal((await call(admin, "POST", "/admin/payments", { userId: VR, amount: 8, transactionId: txn(), mode: "NEFT", paidOn: today() })).status, 201);
  });

  test("payouts: earned, paid, balance per role", async () => {
    const d = await (await call(admin, "GET", "/admin/payouts?role=deo")).json();
    const row = d.rows.find((x: { id: string }) => x.id === DEO);
    assert.equal(row.earned, 30);
    assert.equal(row.paid, 20);
    assert.equal(row.balance, 10);
    assert.equal(row.workCount, 2);
    assert.ok(d.rows.every((x: { role: string }) => x.role === "deo"));
    const v = await (await call(admin, "GET", "/admin/payouts?role=verifier")).json();
    const vrow = v.rows.find((x: { id: string }) => x.id === VR);
    assert.equal(vrow.earned, 8);
    assert.equal(vrow.balance, 0);
    const x = await fetch(base + "/api/v1/admin/payouts/export?role=deo", { headers: { ...H, authorization: `Bearer ${admin}` } });
    assert.equal(x.status, 200);
    assert.match(x.headers.get("content-disposition") ?? "", /nasoi-deo-payouts_/);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()) as never);
    assert.ok(wb.getWorksheet("DEO Payouts") && wb.getWorksheet("DEO Payments"));
  });

  test("employees see only their own payments", async () => {
    const mine = await (await call(deo, "GET", "/payments/me")).json();
    assert.deepEqual(mine.summary, { earned: 30, paid: 20, balance: 10, payments: 1 });
    assert.equal(mine.payments[0].notes, "October part payment");
    const others = await (await call(other, "GET", "/payments/me")).json();
    assert.ok(!others.payments.some((p: { userId: string }) => p.userId === DEO));
    assert.equal((await call(admin, "GET", "/payments/me")).status, 403);
    const f = await fetch(base + "/api/v1/payments/me/export", { headers: { ...H, authorization: `Bearer ${deo}` } });
    assert.equal(f.status, 200);
    assert.match(f.headers.get("content-disposition") ?? "", /nasoi-payments_deo129_/);
  });

  test("files can be e-mailed (as attachments); employees only to their own e-mail", async () => {
    mails.length = 0;
    const a = await call(admin, "POST", "/admin/payouts/export/email", { role: "verifier", to: "Accounts@Example.org" });
    assert.equal(a.status, 200);
    const e = await call(admin, "POST", "/admin/entries/export/email", {
      to: "accounts@example.org, boss@example.org",
      cc: "audit@example.org; accounts@example.org",
      subject: "Custom report {date}",
      message: "Hello team,\n\n{details}\nFile {file}",
      format: "csv",
      filters: { deoId: DEO, to: "2099-12-31" },
    });
    assert.equal(e.status, 200);
    const ej = await e.json();
    assert.equal(ej.count, 2);
    assert.deepEqual(ej.to, ["accounts@example.org", "boss@example.org"]);
    assert.deepEqual(ej.cc, ["audit@example.org"], "a To address is not repeated in CC");
    const bad = await call(admin, "POST", "/admin/entries/export/email", { to: "ok@example.org, not-an-email" });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(await bad.json()), /not-an-email/);
    assert.equal((await call(admin, "POST", "/admin/entries/export/email", { to: "" })).status, 400);
    const m = await call(deo, "POST", "/payments/me/export/email", { to: "someone@else.com", cc: "x@else.com" });
    assert.equal(m.status, 200);
    assert.deepEqual((await m.json()).to, ["meena.demo@example.com"], "always the employee's own e-mail");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mails.length, 3);
    assert.ok(mails[0].to === "accounts@example.org" && /filename="?nasoi-verifier-payouts_/.test(mails[0].raw), "payouts xlsx attached");
    assert.ok(mails[0].raw.includes("Verifier payouts report"), "default template filled");
    assert.equal(mails[1].to, "accounts@example.org,boss@example.org,audit@example.org");
    assert.ok(/filename="?nasoi-approved-entries_deo129_/.test(mails[1].raw), "entries csv attached");
    assert.ok(/Subject: Custom report \d{2} \w{3} \d{4}/.test(mails[1].raw), "custom subject with {date}");
    assert.ok(mails[1].raw.includes("Hello team") && mails[1].raw.includes("DEO DEO129"), "custom message with {details}");
    assert.ok(mails[2].to === "meena.demo@example.com" && /filename="?nasoi-payments_deo129_/.test(mails[2].raw));
  });

  test("admin can save and reset the default e-mail template", async () => {
    const s0 = await (await call(admin, "GET", "/admin/settings")).json();
    assert.equal(s0.settings.mailTemplate.isDefault, true);
    assert.match(s0.settings.mailTemplate.message, /\{report\}/);
    assert.equal((await call(admin, "PATCH", "/admin/settings/mail-template", { subject: "a\nb", message: "short" })).status, 400);
    assert.equal((await call(deo, "PATCH", "/admin/settings/mail-template", { reset: true })).status, 403);
    const s1 = await call(admin, "PATCH", "/admin/settings/mail-template", { subject: "GrowVika {report}", message: "Namaste,\n\nSee {file}.\n\nNASOI" });
    assert.equal(s1.status, 200);
    assert.equal((await s1.json()).settings.mailTemplate.isDefault, false);
    mails.length = 0;
    assert.equal((await call(admin, "POST", "/admin/payouts/export/email", { role: "deo", to: "a@example.org" })).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(/Subject: GrowVika DEO payouts report/.test(mails[0].raw) && mails[0].raw.includes("Namaste"), "saved template used");
    const s2 = await (await call(admin, "PATCH", "/admin/settings/mail-template", { reset: true })).json();
    assert.equal(s2.settings.mailTemplate.isDefault, true);
  });
});
