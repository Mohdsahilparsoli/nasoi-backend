import bcrypt from "bcryptjs";
import type { Request } from "express";
import { prisma } from "../../db.js";
import { Prisma, type DocumentKind, type Role } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { encryptText, lookupHash } from "../../lib/crypto.js";
import { HttpError } from "../../lib/http.js";
import { mailEnabled, registrationEmail, sendMail } from "../../lib/mailer.js";
import { BCRYPT_COST } from "../auth/service.js";
import type { RegistrationInput } from "./schema.js";
import { sha256 } from "./uploads.js";

const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Readable IDs: DEO1001, DEO1002 … and VR201, VR202 … */
const ID_FORMAT: Record<"deo" | "verifier", { key: string; prefix: string; start: number }> = {
  deo: { key: "deo", prefix: "DEO", start: 1000 },
  verifier: { key: "verifier", prefix: "VR", start: 200 },
};

const DOC_LABEL: Record<DocumentKind, string> = {
  aadhaar: "Aadhaar card",
  aadhaar_front: "Aadhaar card (front)",
  aadhaar_back: "Aadhaar card (back)",
  pan: "PAN card",
  bank_proof: "Bank passbook / cancelled cheque",
  photo: "Photo",
  signature: "Signature",
};

const duplicate = (message: string, field: string) => new HttpError(409, message, `DUPLICATE_${field.toUpperCase()}`);

export async function register(req: Request, v: RegistrationInput) {
  const db = prisma();
  const aadhaarHash = lookupHash(`aadhaar:${v.aadhaar}`);

  // Friendly duplicate messages (the unique indexes below are the real guarantee).
  const [byMobile, byEmail, byAadhaar] = await Promise.all([
    db.user.findUnique({ where: { mobile: v.mobile }, select: { id: true } }),
    db.user.findUnique({ where: { email: v.email }, select: { id: true } }),
    db.profile.findUnique({ where: { aadhaarHash }, select: { userId: true } }),
  ]);
  if (byMobile) throw duplicate("This mobile number is already registered. Please log in instead.", "mobile");
  if (byEmail) throw duplicate("This email ID is already registered. Please log in instead.", "email");
  if (byAadhaar) throw duplicate("This Aadhaar number is already registered.", "aadhaar");

  // Every referenced upload must exist, match its slot, be unused, recent, and carry the right token.
  const refs = Object.entries(v.documents).filter(([, r]) => r) as [DocumentKind, { id: string; token: string }][];
  const docs = await db.document.findMany({
    where: { id: { in: refs.map(([, r]) => r.id) } },
    select: { id: true, kind: true, attachedAt: true, uploadTokenHash: true, createdAt: true },
  });
  for (const [kind, ref] of refs) {
    const d = docs.find((x) => x.id === ref.id);
    const ok =
      d && d.kind === kind && !d.attachedAt && d.uploadTokenHash === sha256(ref.token) && Date.now() - d.createdAt.getTime() < UPLOAD_MAX_AGE_MS;
    if (!ok) throw new HttpError(400, `${DOC_LABEL[kind]} upload has expired. Please upload it again.`, "BAD_DOCUMENT");
  }

  const passwordHash = await bcrypt.hash(v.password, BCRYPT_COST);
  const fmt = ID_FORMAT[v.role];

  try {
    const user = await db.$transaction(async (tx) => {
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        insert into id_counters (key, value) values (${fmt.key}, ${fmt.start + 1}::int)
        on conflict (key) do update set value = id_counters.value + 1
        returning value`;
      const id = `${fmt.prefix}${value}`;

      const u = await tx.user.create({
        data: {
          id,
          role: v.role as Role,
          name: v.name,
          mobile: v.mobile,
          email: v.email,
          passwordHash,
          // New employees wait for the admin to activate them before they get work.
          status: "pending",
          profile: {
            create: {
              fatherName: v.fatherName,
              motherName: v.motherName,
              dob: new Date(`${v.dob}T00:00:00Z`),
              gender: v.gender,
              category: v.category,
              religion: v.religion,
              country: v.country,
              state: v.state,
              district: v.district,
              subDistrict: v.subDistrict,
              postOffice: v.postOffice,
              pincode: v.pincode,
              policeStation: v.policeStation,
              address: v.address,
              qualification: v.qualification,
              aadhaarLast4: v.aadhaar.slice(-4),
              aadhaarHash,
              aadhaarEnc: encryptText(v.aadhaar),
              pan: v.pan ?? null,
              bankName: v.bankName,
              accountHolder: v.accountHolder,
              accountLast4: v.accountNumber.slice(-4),
              accountEnc: encryptText(v.accountNumber),
              ifsc: v.ifsc,
              bankProofType: v.bankProofType,
              termsAcceptedAt: new Date(),
            },
          },
        },
        select: { id: true, role: true, name: true, mobile: true, email: true, createdAt: true },
      });

      // Attach uploads atomically; a concurrent submit with the same files fails here.
      const attached = await tx.document.updateMany({
        where: { id: { in: refs.map(([, r]) => r.id) }, attachedAt: null },
        data: { userId: u.id, attachedAt: new Date() },
      });
      if (attached.count !== refs.length) throw new HttpError(409, "Documents were already used. Please upload them again.", "BAD_DOCUMENT");
      return u;
    });

    await audit(req, "user.registered", user.id, { role: user.role });
    const emailSent = await sendRegistrationEmail(user);
    const { createdAt: _c, ...pub } = user;
    return { user: pub, emailSent };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = JSON.stringify(err.meta ?? {});
      if (target.includes("mobile")) throw duplicate("This mobile number is already registered. Please log in instead.", "mobile");
      if (target.includes("email")) throw duplicate("This email ID is already registered. Please log in instead.", "email");
      if (target.includes("aadhaar")) throw duplicate("This Aadhaar number is already registered.", "aadhaar");
      throw duplicate("These details are already registered.", "record");
    }
    throw err;
  }
}

/** Confirmation e-mail. A mail problem never undoes or fails the registration. */
async function sendRegistrationEmail(u: { id: string; role: Role; name: string; email: string | null; mobile: string | null; createdAt: Date }) {
  if (!mailEnabled() || !u.email || (u.role !== "deo" && u.role !== "verifier")) return false;
  try {
    const mail = registrationEmail({ id: u.id, name: u.name, role: u.role, email: u.email, mobile: u.mobile ?? "", createdAt: u.createdAt });
    await sendMail({ to: u.email, ...mail });
    return true;
  } catch (err) {
    console.error("[mail] registration e-mail failed", u.id, (err as Error).message);
    return false;
  }
}
