// Registration confirmation e-mail – captured by a local SMTP server. Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { SMTPServer } from "smtp-server";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "test";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "2589";
process.env.SMTP_FROM = "NASOI <no-reply@nasoi.test>";
process.env.APP_URL = "https://portal.nasoi.test";
process.env.UPLOADS_PER_HOUR = "1000";
process.env.REGISTRATIONS_PER_HOUR = "1000";
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
const { isValidAadhaar } = await import("../src/modules/registration/schema.js");

let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const H = { "x-nasoi-client": "web" };

before(async () => {
  await new Promise<void>((r) => smtp.listen(2589, "127.0.0.1", r));
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  smtp.close();
  await prisma().$disconnect();
});

const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
async function up(kind: string) {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", new Blob([new Uint8Array(jpg())]), `${kind}.jpg`);
  const r = await fetch(base + "/api/v1/registrations/uploads", { method: "POST", headers: H, body: fd });
  const { upload } = await r.json();
  return { id: upload.id as string, token: upload.token as string };
}
function aadhaar(): string {
  for (;;) {
    const n = String(2 + Math.floor(Math.random() * 8)) + String(Math.floor(Math.random() * 1e10)).padStart(10, "0");
    for (let d = 0; d < 10; d++) if (isValidAadhaar(n + d)) return n + d;
  }
}
/** Decode quoted-printable soft breaks so the content can be searched. */
const decode = (raw: string) => raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=").replace(/=E2=80=93/g, "–");

test("registration sends a professional confirmation e-mail (no password, no Aadhaar)", async () => {
  const r = String(Math.floor(10000000 + Math.random() * 89999999));
  const body = {
    role: "verifier", name: "Kavya Nair", fatherName: "Mohan Nair", motherName: "Lata Nair", dob: "1996-02-10",
    email: `kavya${r}@test.nasoi.in`, mobile: "95" + r, gender: "Female", category: "GEN", religion: "Hindu",
    country: "India", state: "Kerala", district: "Ernakulam", subDistrict: "Kochi", postOffice: "Edappally",
    pincode: "682024", policeStation: "Edappally", address: "House 7, MG Road, Edappally, Kochi",
    bankName: "Federal Bank", accountHolder: "Kavya Nair", accountNumber: "77001234" + r.slice(0, 4), ifsc: "FDRL0001234",
    qualification: "Graduation", aadhaar: aadhaar(), bankProofType: "Bank Passbook",
    documents: { aadhaar_front: await up("aadhaar_front"), aadhaar_back: await up("aadhaar_back"), bank_proof: await up("bank_proof"), photo: await up("photo"), signature: await up("signature") },
    password: "Kavya2026Secret", declaration: true, terms: true,
  };
  const res = await fetch(base + "/api/v1/registrations", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 201, await res.clone().text());
  const j = await res.json();
  assert.equal(j.emailSent, true);
  assert.match(j.user.id, /^VR\d+$/);
  assert.equal(j.user.createdAt, undefined);

  await new Promise((r2) => setTimeout(r2, 300));
  const mail = mails.find((m) => m.to === body.email);
  assert.ok(mail, "e-mail sent to the registered address");
  const raw = decode(mail!.raw);
  assert.match(raw, new RegExp(`Subject: .*${j.user.id}`), "ID in subject");
  assert.ok(raw.includes(j.user.id) && raw.includes("KAVYA NAIR") && raw.includes("Verifier (VR)"), "details in body");
  assert.ok(raw.includes(`XXXXXX${body.mobile.slice(-4)}`), "mobile masked");
  assert.ok(raw.includes(`https://portal.nasoi.test/login?id=${j.user.id}`), "login button link");
  assert.ok(raw.includes("Content-Type: text/plain") && raw.includes("Content-Type: text/html"), "text + html parts");
  assert.ok(!raw.includes("Kavya2026Secret"), "password never e-mailed");
  assert.ok(!raw.includes(body.aadhaar), "Aadhaar never e-mailed");
  assert.ok(!raw.includes(body.accountNumber), "account number never e-mailed");
});
