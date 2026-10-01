// Integration tests against a real Postgres (DATABASE_URL in .env). Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "test";
const { createApp } = await import("../src/create-app.js");
const { prisma } = await import("../src/db.js");
// Test-only helper for direct SQL (fixed strings, no user input).
const query = async <T = unknown>(sql: string) =>
  /^\s*select/i.test(sql) ? { rows: (await prisma().$queryRawUnsafe(sql)) as T[] } : (await prisma().$executeRawUnsafe(sql), { rows: [] as T[] });

let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const H = { "content-type": "application/json", "x-nasoi-client": "web" };

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await query("update users set status = 'active', failed_login_count = 0, locked_until = null");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await prisma().$disconnect();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("nasoi_rt_")) ?? "";
const pair = (setCookie: string) => setCookie.split(";")[0]!;

describe("auth", () => {
  test("health reports database up", async () => {
    const r = await fetch(base + "/api/v1/health");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).database, "up");
  });

  test("blocks requests without the client header (CSRF)", async () => {
    const r = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
  });

  test("blocks foreign origins", async () => {
    const r = await post("/api/v1/auth/login", { loginId: "DEO126", password: "Abcd@2026" }, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });

  test("DEO logs in by ID and gets a secure refresh cookie", async () => {
    const r = await post("/api/v1/auth/login", { loginId: "deo126", password: "Abcd@2026" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.user.role, "deo");
    assert.equal(j.user.password_hash, undefined);
    assert.match(j.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    const c = cookieOf(r);
    assert.match(c, /^nasoi_rt_deo=/);
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Path=\/api\/v1\/auth/);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  test("verifier logs in by mobile with +91, admin by email", async () => {
    const v = await (await post("/api/v1/auth/login", { loginId: "+91 99900 11223", password: "Abcd@2026" })).json();
    assert.equal(v.user.role, "verifier");
    const a = await (await post("/api/v1/auth/login", { loginId: "ADMIN.demo@example.com", password: "Admin@2026" })).json();
    assert.equal(a.user.role, "admin");
  });

  test("wrong password and unknown user give the same message", async () => {
    const a = await post("/api/v1/auth/login", { loginId: "DEO127", password: "nope" });
    const b = await post("/api/v1/auth/login", { loginId: "NOBODY", password: "nope" });
    const c = await post("/api/v1/auth/login", { loginId: "' or 1=1 --", password: "x" });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(c.status, 401);
    assert.equal((await a.json()).error.message, (await b.json()).error.message);
    await query("update users set failed_login_count = 0 where id = 'DEO127'");
  });

  test("locks the account after 5 wrong passwords", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) last = await post("/api/v1/auth/login", { loginId: "9811100022", password: "wrong" + i }, { "x-forwarded-for": `10.0.0.${i}` });
    assert.equal(last!.status, 429);
    const ok = await post("/api/v1/auth/login", { loginId: "DEO127", password: "Abcd@2026" }, { "x-forwarded-for": "10.0.1.1" });
    assert.equal(ok.status, 429, "even the right password is refused while locked");
    await query("update users set failed_login_count = 0, locked_until = null where id = 'DEO127'");
  });

  test("blocked account is refused only after the correct password", async () => {
    await query("update users set status = 'blocked' where id = 'DEO127'");
    const r = await post("/api/v1/auth/login", { loginId: "DEO127", password: "Abcd@2026" });
    assert.equal(r.status, 403);
    await query("update users set status = 'active' where id = 'DEO127'");
  });

  test("me, refresh rotation, reuse detection and logout", async () => {
    const login = await post("/api/v1/auth/login", { loginId: "VR101", password: "Abcd@2026" });
    const { accessToken } = await login.json();
    const c1 = pair(cookieOf(login));

    const me = await fetch(base + "/api/v1/auth/me", { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, "VR101");
    assert.equal((await fetch(base + "/api/v1/auth/me")).status, 401);
    assert.equal((await fetch(base + "/api/v1/auth/me", { headers: { authorization: "Bearer a.b.c" } })).status, 401);

    // wrong role cookie name → no session
    assert.equal((await post("/api/v1/auth/refresh", { role: "admin" }, { cookie: c1.replace("verifier", "admin") })).status, 401);

    const r1 = await post("/api/v1/auth/refresh", { role: "verifier" }, { cookie: c1 });
    assert.equal(r1.status, 200);
    const c2 = pair(cookieOf(r1));
    assert.notEqual(c2, c1, "refresh token rotates");

    // parallel tab with the old cookie inside the grace window: gets a token, no new cookie
    const r2 = await post("/api/v1/auth/refresh", { role: "verifier" }, { cookie: c1 });
    assert.equal(r2.status, 200);
    assert.equal(cookieOf(r2), "");

    // replay after the grace window → session revoked
    await query("update auth_sessions set rotated_at = now() - interval '5 minutes' where token_hash is not null");
    const r3 = await post("/api/v1/auth/refresh", { role: "verifier" }, { cookie: c1 });
    assert.equal(r3.status, 401);
    assert.equal((await post("/api/v1/auth/refresh", { role: "verifier" }, { cookie: c2 })).status, 401, "whole session killed");

    // logout
    const l = await post("/api/v1/auth/login", { loginId: "VR101", password: "Abcd@2026" });
    const t = (await l.json()).accessToken;
    const lc = pair(cookieOf(l));
    assert.equal((await post("/api/v1/auth/logout", { role: "verifier" }, { cookie: lc })).status, 200);
    assert.equal((await post("/api/v1/auth/refresh", { role: "verifier" }, { cookie: lc })).status, 401);
    assert.equal((await fetch(base + "/api/v1/auth/me", { headers: { authorization: `Bearer ${t}` } })).status, 401, "access token dies with session");
  });

  test("change password logs out other devices", async () => {
    const a = await (await post("/api/v1/auth/login", { loginId: "DEO126", password: "Abcd@2026" })).json();
    const b = await (await post("/api/v1/auth/login", { loginId: "DEO126", password: "Abcd@2026" })).json();
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });

    const wrong = await post("/api/v1/auth/change-password", { currentPassword: "bad", newPassword: "NewPass123" }, auth(a.accessToken));
    assert.equal(wrong.status, 400);
    const weak = await post("/api/v1/auth/change-password", { currentPassword: "Abcd@2026", newPassword: "short" }, auth(a.accessToken));
    assert.equal(weak.status, 400);
    const ok = await post("/api/v1/auth/change-password", { currentPassword: "Abcd@2026", newPassword: "NewPass123" }, auth(a.accessToken));
    assert.equal(ok.status, 200);

    assert.equal((await fetch(base + "/api/v1/auth/me", { headers: auth(a.accessToken) })).status, 200, "current device stays in");
    assert.equal((await fetch(base + "/api/v1/auth/me", { headers: auth(b.accessToken) })).status, 401, "other device logged out");
    assert.equal((await post("/api/v1/auth/login", { loginId: "DEO126", password: "NewPass123" })).status, 200);

    // restore demo password
    await post("/api/v1/auth/change-password", { currentPassword: "NewPass123", newPassword: "Abcd@2026" }, auth(a.accessToken));
    assert.equal((await post("/api/v1/auth/login", { loginId: "DEO126", password: "Abcd@2026" })).status, 200);
  });

  test("rejects oversized and malformed bodies", async () => {
    assert.equal((await post("/api/v1/auth/login", { loginId: "x".repeat(30000), password: "y" })).status, 413);
    const bad = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: H, body: "{not json" });
    assert.equal(bad.status, 400);
  });

  test("audit log records attempts without secrets", async () => {
    const { rows } = await query<{ action: string; meta: string }>("select action, meta::text from audit_logs");
    assert.ok(rows.some((r) => r.action === "login.success"));
    assert.ok(rows.some((r) => r.action === "token.reuse_detected"));
    assert.ok(!rows.some((r) => /Abcd@2026|NewPass123/.test(r.meta)));
  });
});
