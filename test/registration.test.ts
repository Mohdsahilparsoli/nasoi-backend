// Registration, uploads and profile – integration tests against a real Postgres (.env). Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { deflateSync } from "node:zlib";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "test";
process.env.UPLOADS_PER_HOUR = "1000";
process.env.REGISTRATIONS_PER_HOUR = "1000";
const { createApp } = await import("../src/create-app.js");
const { prisma } = await import("../src/db.js");
const { isValidAadhaar } = await import("../src/modules/registration/schema.js");

let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const H = { "x-nasoi-client": "web" };
const JSONH = { ...H, "content-type": "application/json" };

before(async () => {
  await (await import("./fixtures.js")).ensureFixtures();
  await prisma().user.deleteMany({ where: { email: { endsWith: "@test.nasoi.in" } } });
  await prisma().document.deleteMany({ where: { userId: null } });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await prisma().$disconnect();
});

/* ---------- helpers ---------- */

/** A real (tiny) PNG, JPEG header and PDF so type sniffing passes. */
function png() {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const pdf = () => Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

async function uploadFile(kind: string, buf: Buffer, name: string) {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", new Blob([new Uint8Array(buf)]), name);
  return fetch(base + "/api/v1/registrations/uploads", { method: "POST", headers: H, body: fd });
}
async function up(kind: string, buf: Buffer, name: string) {
  const r = await uploadFile(kind, buf, name);
  assert.equal(r.status, 201, `upload ${kind}: ${await r.clone().text()}`);
  const { upload } = await r.json();
  return { id: upload.id as string, token: upload.token as string };
}

function aadhaar(): string {
  for (;;) {
    const n = String(2 + Math.floor(Math.random() * 8)) + String(Math.floor(Math.random() * 1e10)).padStart(10, "0");
    for (let d = 0; d < 10; d++) if (isValidAadhaar(n + d)) return n + d;
  }
}
const rnd = () => String(Math.floor(10000000 + Math.random() * 89999999));

async function docs(withPan = false) {
  return {
    aadhaar_front: await up("aadhaar_front", jpg(), "aadhaar-front.jpg"),
    aadhaar_back: await up("aadhaar_back", png(), "aadhaar-back.png"),
    ...(withPan ? { pan: await up("pan", jpg(), "pan.jpg") } : {}),
    bank_proof: await up("bank_proof", png(), "passbook.png"),
    photo: await up("photo", jpg(), "photo.jpg"),
    signature: await up("signature", png(), "sign.png"),
  };
}

async function payload(role: "deo" | "verifier", over: Record<string, unknown> = {}) {
  const r = rnd();
  return {
    role, name: "amit  singh", fatherName: "Rajendra Singh", motherName: "Meena Devi", dob: "2000-08-15",
    email: `amit${r}@test.nasoi.in`, mobile: "98" + r, gender: "Male", category: "GEN", religion: "Hindu",
    country: "India", state: "Uttar Pradesh", district: "Meerut", subDistrict: "Mawana", postOffice: "Kithore",
    pincode: "250401", policeStation: "Kithore", address: "House No. 12, Village Kithore, Mawana",
    bankName: "Bank of Baroda", accountHolder: "Amit Singh", accountNumber: "12345678" + r.slice(0, 4), ifsc: "barb0mawana",
    qualification: "Class 12", aadhaar: aadhaar(), pan: "", bankProofType: "Bank Passbook",
    documents: await docs(), password: "Strong123", declaration: true, terms: true,
    ...over,
  };
}
const submit = (body: unknown) => fetch(base + "/api/v1/registrations", { method: "POST", headers: JSONH, body: JSON.stringify(body) });
const login = (loginId: string, password: string) =>
  fetch(base + "/api/v1/auth/login", { method: "POST", headers: JSONH, body: JSON.stringify({ loginId, password }) });

/* ---------- tests ---------- */

describe("uploads", () => {
  test("accepts PDF / JPG / PNG and returns an id + token", async () => {
    for (const [kind, buf, name] of [["aadhaar_front", jpg(), "af.jpg"], ["aadhaar_back", png(), "ab.png"], ["bank_proof", pdf(), "b.pdf"], ["photo", jpg(), "p.jpg"], ["signature", png(), "s.png"]] as const) {
      const r = await uploadFile(kind, buf, name);
      assert.equal(r.status, 201);
      const { upload } = await r.json();
      assert.match(upload.id, /^[0-9a-f-]{36}$/);
      assert.ok(upload.token.length >= 30);
    }
  });

  test("checks the real file type, not the name", async () => {
    assert.equal((await uploadFile("bank_proof", Buffer.from("MZ fake exe"), "passbook.pdf")).status, 415);
    assert.equal((await uploadFile("aadhaar_front", pdf(), "front.pdf")).status, 415, "Aadhaar front must be a photo");
    assert.equal((await uploadFile("aadhaar", pdf(), "old.pdf")).status, 400, "single-file Aadhaar no longer accepted");
    assert.equal((await uploadFile("photo", pdf(), "photo.jpg")).status, 415, "photo must be an image");
    assert.equal((await uploadFile("unknown", pdf(), "x.pdf")).status, 400);
  });

  test("rejects files over 2 MB and requests without the client header", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(2 * 1024 * 1024 + 10)]);
    assert.equal((await uploadFile("bank_proof", big, "big.pdf")).status, 413);
    const fd = new FormData();
    fd.append("kind", "photo");
    fd.append("file", new Blob([new Uint8Array(jpg())]), "p.jpg");
    assert.equal((await fetch(base + "/api/v1/registrations/uploads", { method: "POST", body: fd })).status, 403);
  });

  test("stores files encrypted", async () => {
    const { id } = await up("bank_proof", pdf(), "enc.pdf");
    const d = await prisma().document.findUniqueOrThrow({ where: { id } });
    assert.ok(!Buffer.from(d.data).includes(Buffer.from("%PDF")));
  });
});

describe("registration", () => {
  let deo: { id: string; mobile: string; email: string; aadhaar: string };

  test("registers a Data Entry Operator", async () => {
    const body = await payload("deo");
    const r = await submit(body);
    assert.equal(r.status, 201, await r.clone().text());
    const { user } = await r.json();
    assert.match(user.id, /^DEO\d{4,}$/);
    assert.equal(user.role, "deo");
    assert.equal(user.name, "AMIT SINGH");
    deo = { id: user.id, mobile: body.mobile, email: body.email, aadhaar: body.aadhaar };
  });

  test("registers a Verifier with PAN", async () => {
    const body = await payload("verifier", { pan: "abcde1234f" });
    body.documents = await docs(true);
    const r = await submit(body);
    assert.equal(r.status, 201, await r.clone().text());
    const { user } = await r.json();
    assert.match(user.id, /^VR\d{3,}$/);
    const l = await login(user.id, "Strong123");
    assert.equal((await l.json()).user.role, "verifier");
  });

  test("new user can log in with ID, mobile and email", async () => {
    for (const id of [deo.id, deo.mobile, deo.email.toUpperCase()]) {
      const r = await login(id, "Strong123");
      assert.equal(r.status, 200, id);
      assert.equal((await r.json()).user.id, deo.id);
    }
  });

  test("sensitive numbers are encrypted in the database", async () => {
    const p = await prisma().profile.findUniqueOrThrow({ where: { userId: deo.id } });
    const row = JSON.stringify(p);
    assert.ok(!row.includes(deo.aadhaar), "Aadhaar must not be stored in clear");
    assert.equal(p.aadhaarLast4, deo.aadhaar.slice(-4));
    const docCount = await prisma().document.count({ where: { userId: deo.id } });
    assert.equal(docCount, 5);
  });

  test("duplicate mobile, email and Aadhaar are refused", async () => {
    assert.equal((await submit(await payload("deo", { mobile: deo.mobile }))).status, 409);
    assert.equal((await submit(await payload("deo", { email: deo.email }))).status, 409);
    const r = await submit(await payload("deo", { aadhaar: deo.aadhaar }));
    assert.equal(r.status, 409);
    assert.match((await r.json()).error.message, /Aadhaar/);
  });

  test("uploads cannot be reused or claimed with a wrong token", async () => {
    const body = await payload("deo");
    assert.equal((await submit(body)).status, 201);
    const again = await payload("deo");
    again.documents = body.documents; // already attached
    assert.equal((await submit(again)).status, 400);
    const bad = await payload("deo");
    bad.documents.photo = { ...bad.documents.photo, token: "x".repeat(32) };
    assert.equal((await submit(bad)).status, 400);
    const swapped = await payload("deo");
    swapped.documents.photo = swapped.documents.signature; // wrong slot
    assert.equal((await submit(swapped)).status, 400);
  });

  test("server-side validation", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ aadhaar: "123412341234" }, /Aadhaar/],
      [{ district: "Mumbai" }, /district/],
      [{ dob: "2015-01-01" }, /18 and 65/],
      [{ mobile: "12345" }, /mobile/],
      [{ ifsc: "BAD" }, /IFSC/],
      [{ password: "short" }, /8 characters/],
      [{ terms: false }, /Terms/],
      [{ role: "admin" }, /Operator or Verifier/],
      [{ pan: "ABCDE1234F" }, /PAN card/],
    ];
    for (const [over, msg] of cases) {
      const r = await submit(await payload("deo", over));
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.match((await r.json()).error.message, msg, JSON.stringify(over));
    }
  });

  test("profile: masked data, documents, updates, access control", async () => {
    const t = (await (await login(deo.id, "Strong123")).json()).accessToken;
    const auth = { authorization: `Bearer ${t}` };
    const r = await fetch(base + "/api/v1/profile/me", { headers: auth });
    assert.equal(r.status, 200);
    const { user } = await r.json();
    assert.equal(user.profile.aadhaar, `XXXX XXXX ${deo.aadhaar.slice(-4)}`);
    assert.match(user.profile.bank.account, /^XXXXXX\d{4}$/);
    assert.equal(user.profile.district, "Meerut");
    assert.equal(user.documents.length, 5);
    assert.deepEqual(user.documents.map((d: { kind: string }) => d.kind).sort(), ["aadhaar_back", "aadhaar_front", "bank_proof", "photo", "signature"]);

    // owner can open a document; it comes back decrypted with the right type
    const photo = user.documents.find((d: { kind: string }) => d.kind === "bank_proof");
    const f = await fetch(base + `/api/v1/documents/${photo.id}`, { headers: auth });
    assert.equal(f.status, 200);
    assert.equal(f.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await f.arrayBuffer()).subarray(1, 4).toString() === "PNG", "decrypted file is the original PNG");

    // another DEO and a verifier cannot (only the owner and the admin)
    const other = (await (await login("DEO127", "Abcd@2026")).json()).accessToken;
    assert.equal((await fetch(base + `/api/v1/documents/${photo.id}`, { headers: { authorization: `Bearer ${other}` } })).status, 404);
    const vr = (await (await login("VR101", "Abcd@2026")).json()).accessToken;
    assert.equal((await fetch(base + `/api/v1/documents/${photo.id}`, { headers: { authorization: `Bearer ${vr}` } })).status, 404);
    const adm = (await (await login("ADMIN", "Admin@2026")).json()).accessToken;
    assert.equal((await fetch(base + `/api/v1/documents/${photo.id}`, { headers: { authorization: `Bearer ${adm}` } })).status, 200);
    assert.equal((await fetch(base + `/api/v1/documents/${photo.id}`)).status, 401);

    // updates
    const c = await fetch(base + "/api/v1/profile/me/contact", {
      method: "PATCH", headers: { ...JSONH, ...auth },
      body: JSON.stringify({ mobile: deo.mobile, altMobile: "9123456789", email: deo.email, address: "New address line, Meerut" }),
    });
    assert.equal(c.status, 200);
    const dup = await fetch(base + "/api/v1/profile/me/contact", {
      method: "PATCH", headers: { ...JSONH, ...auth },
      body: JSON.stringify({ mobile: "9717323761", email: deo.email, address: "New address line, Meerut" }),
    });
    assert.equal(dup.status, 409, "mobile of DEO126");
    const b = await fetch(base + "/api/v1/profile/me/bank", {
      method: "PATCH", headers: { ...JSONH, ...auth },
      body: JSON.stringify({ bankName: "State Bank of India", accountHolder: "Amit Singh", accountNumber: "998877665544", ifsc: "SBIN0001234" }),
    });
    assert.equal(b.status, 200);
    const again = await (await fetch(base + "/api/v1/profile/me", { headers: auth })).json();
    assert.equal(again.user.profile.bank.account, "XXXXXX5544");
    assert.equal(again.user.profile.altMobile, "9123456789");
  });
});
