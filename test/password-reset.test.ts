// Forgot / reset password – uses a local SMTP server to capture the e-mail. Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { SMTPServer } from "smtp-server";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "test";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "2587";
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
    stream.on("end", () => {
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(","), raw });
      cb();
    });
  },
});

const { createApp } = await import("../src/create-app.js");
const { prisma } = await import("../src/db.js");
const bcrypt = (await import("bcryptjs")).default;

let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const H = { "content-type": "application/json", "x-nasoi-client": "web" };
const EMAIL = "priya.demo@example.com"; // DEO127

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await new Promise<void>((r) => smtp.listen(2587, "127.0.0.1", r));
  await prisma().user.update({ where: { id: "DEO127" }, data: { passwordHash: await bcrypt.hash("Abcd@2026", 12), status: "active", failedLoginCount: 0, lockedUntil: null } });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await prisma().user.update({ where: { id: "DEO127" }, data: { passwordHash: await bcrypt.hash("Abcd@2026", 12) } });
  server.close();
  smtp.close();
  await prisma().$disconnect();
});

const post = (path: string, body: unknown, ip = "10.9.0.1") =>
  fetch(base + path, { method: "POST", headers: { ...H, "x-forwarded-for": ip }, body: JSON.stringify(body) });
/** Pull the link out of the (quoted-printable) plain-text part. */
function linkFrom(raw: string) {
  const text = raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const m = text.match(/https:\/\/portal\.nasoi\.test\/reset-password#token=([\w.-]+)/);
  return m?.[1];
}

describe("forgot / reset password", () => {
  let token = "";

  test("unknown e-mail: same answer, no e-mail, not faster", async () => {
    const t0 = Date.now();
    const r = await post("/api/v1/auth/forgot-password", { email: "nobody@example.com" });
    assert.equal(r.status, 200);
    assert.match((await r.json()).message, /If an account exists/);
    assert.ok(Date.now() - t0 >= 1400, "constant-time answer");
    assert.equal(mails.length, 0);
  });

  test("known e-mail: reset link is e-mailed", async () => {
    const r = await post("/api/v1/auth/forgot-password", { email: EMAIL.toUpperCase() });
    assert.equal(r.status, 200);
    assert.match((await r.json()).message, /If an account exists/);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, EMAIL);
    assert.match(mails[0]!.raw, /Subject: Reset your NASOI password/);
    token = linkFrom(mails[0]!.raw) ?? "";
    assert.match(token, /^[\w-]+\.[\w-]+\.[\w-]+$/, "JWT in the link fragment");
  });

  test("bad tokens are refused", async () => {
    assert.equal((await post("/api/v1/auth/reset-password", { token: token.slice(0, -3) + "abc", newPassword: "Fresh2026x" })).status, 400);
    // an access token must not work as a reset token
    const login = await (await post("/api/v1/auth/login", { loginId: "DEO127", password: "Abcd@2026" })).json();
    assert.equal((await post("/api/v1/auth/reset-password", { token: login.accessToken, newPassword: "Fresh2026x" })).status, 400);
    assert.equal((await post("/api/v1/auth/reset-password", { token, newPassword: "weak" })).status, 400);
  });

  test("reset works once, logs out other sessions", async () => {
    const before = await (await post("/api/v1/auth/login", { loginId: "DEO127", password: "Abcd@2026" })).json();
    const r = await post("/api/v1/auth/reset-password", { token, newPassword: "Fresh2026x" });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await post("/api/v1/auth/login", { loginId: "DEO127", password: "Abcd@2026" }, "10.9.0.2")).status, 401);
    assert.equal((await post("/api/v1/auth/login", { loginId: EMAIL, password: "Fresh2026x" }, "10.9.0.3")).status, 200);
    const me = await fetch(base + "/api/v1/auth/me", { headers: { authorization: `Bearer ${before.accessToken}` } });
    assert.equal(me.status, 401, "old session revoked");
    const again = await post("/api/v1/auth/reset-password", { token, newPassword: "Another2026x" });
    assert.equal(again.status, 400, "link is single-use");
    assert.match((await again.json()).error.message, /invalid or has expired/);
  });

  test("rate limit per e-mail", async () => {
    const ip = "10.9.0.9";
    for (let i = 0; i < 3; i++) assert.equal((await post("/api/v1/auth/forgot-password", { email: "x@example.com" }, ip)).status, 200);
    assert.equal((await post("/api/v1/auth/forgot-password", { email: "x@example.com" }, ip)).status, 429);
  });
});
