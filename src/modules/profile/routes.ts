import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { decryptBytes, encryptText } from "../../lib/crypto.js";
import { HttpError } from "../../lib/http.js";
import { noStore, requireAuth } from "../../middleware/security.js";
import { RX } from "../registration/schema.js";

export const profileRouter = Router();
profileRouter.use(noStore);

const maskAadhaar = (last4: string) => `XXXX XXXX ${last4}`;
const maskAccount = (last4: string) => `XXXXXX${last4}`;

/** GET /api/v1/profile/me – own profile; Aadhaar and account number are always masked. */
profileRouter.get("/me", requireAuth(), async (req, res) => {
  const u = await prisma().user.findUnique({
    where: { id: req.auth!.sub },
    include: {
      profile: true,
      documents: { where: { attachedAt: { not: null } }, select: { id: true, kind: true, fileName: true, mimeType: true, size: true, createdAt: true } },
    },
  });
  if (!u) throw new HttpError(404, "User not found.", "NOT_FOUND");
  const p = u.profile;
  res.json({
    user: {
      id: u.id, role: u.role, name: u.name, mobile: u.mobile, email: u.email, status: u.status, joinedAt: u.createdAt,
      profile: p && {
        fatherName: p.fatherName, motherName: p.motherName, dob: p.dob.toISOString().slice(0, 10), gender: p.gender,
        category: p.category, religion: p.religion, altMobile: p.altMobile, qualification: p.qualification,
        country: p.country, state: p.state, district: p.district, subDistrict: p.subDistrict, postOffice: p.postOffice,
        pincode: p.pincode, policeStation: p.policeStation, address: p.address,
        aadhaar: maskAadhaar(p.aadhaarLast4), pan: p.pan,
        bank: { bankName: p.bankName, accountHolder: p.accountHolder, account: maskAccount(p.accountLast4), ifsc: p.ifsc, proofType: p.bankProofType },
      },
      documents: u.documents,
    },
  });
});

const contactBody = z.object({
  mobile: z.string().trim().regex(RX.mobile, "Enter a valid 10-digit mobile number"),
  altMobile: z.string().trim().refine((v) => v === "" || RX.mobile.test(v), "Enter a valid 10-digit mobile number").optional(),
  email: z.string().trim().toLowerCase().max(80).email("Enter a valid email ID"),
  address: z.string().trim().min(10, "Enter full address").max(200),
});

/** PATCH /api/v1/profile/me/contact */
profileRouter.patch("/me/contact", requireAuth(), async (req, res) => {
  const b = contactBody.parse(req.body);
  const id = req.auth!.sub;
  const db = prisma();
  try {
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { mobile: b.mobile, email: b.email } });
      const hasProfile = await tx.profile.count({ where: { userId: id } });
      if (hasProfile) await tx.profile.update({ where: { userId: id }, data: { address: b.address, altMobile: b.altMobile || null } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const t = JSON.stringify(err.meta ?? {});
      throw new HttpError(409, t.includes("email") ? "This email ID is used by another account." : "This mobile number is used by another account.", "DUPLICATE");
    }
    throw err;
  }
  await audit(req, "profile.updated", id, { part: "contact" });
  res.json({ ok: true });
});

const bankBody = z.object({
  bankName: z.string().trim().min(3).max(60),
  accountHolder: z.string().trim().min(3).max(60).regex(RX.personName, "Account holder name can contain only letters and spaces"),
  accountNumber: z.string().regex(RX.account, "Account number should be 9–18 digits"),
  ifsc: z.string().trim().toUpperCase().regex(RX.ifsc, "Enter a valid 11-character IFSC code"),
});

/** PATCH /api/v1/profile/me/bank */
profileRouter.patch("/me/bank", requireAuth(), async (req, res) => {
  const b = bankBody.parse(req.body);
  const id = req.auth!.sub;
  const n = await prisma().profile.updateMany({
    where: { userId: id },
    data: {
      bankName: b.bankName,
      accountHolder: b.accountHolder.toUpperCase(),
      accountLast4: b.accountNumber.slice(-4),
      accountEnc: encryptText(b.accountNumber),
      ifsc: b.ifsc,
    },
  });
  if (!n.count) throw new HttpError(404, "Profile not found.", "NOT_FOUND");
  await audit(req, "profile.updated", id, { part: "bank" });
  res.json({ ok: true });
});

export const documentsRouter = Router();
documentsRouter.use(noStore);

/** GET /api/v1/documents/:id – the owner, a verifier or an admin can view a document. */
documentsRouter.get("/:id", requireAuth(), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, "Document not found.", "NOT_FOUND");
  const d = await prisma().document.findUnique({ where: { id: id.data } });
  const me = req.auth!;
  if (!d || !d.attachedAt || (d.userId !== me.sub && me.role === "deo")) throw new HttpError(404, "Document not found.", "NOT_FOUND");
  if (d.userId !== me.sub) await audit(req, "document.viewed", me.sub, { documentId: d.id, owner: d.userId ?? "" });
  res.setHeader("Content-Type", d.mimeType);
  res.setHeader("Content-Disposition", `inline; filename="${d.fileName}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(decryptBytes(d.data));
});
