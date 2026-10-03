import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { randomBytes } from "node:crypto";
import multer from "multer";
import { decryptBytes, encryptBytes, encryptText } from "../../lib/crypto.js";
import { HttpError, clientIp } from "../../lib/http.js";
import { canSeePhoto } from "../../lib/people.js";
import { MAX_UPLOAD_BYTES, sha256, sniff } from "../registration/uploads.js";
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
      id: u.id, role: u.role, name: u.name, mobile: u.mobile, email: u.email, status: u.status, statusReason: u.statusReason, joinedAt: u.createdAt,
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

/** GET /api/v1/documents/:id – only the owner or an admin can view a document (Aadhaar, bank proof …). */
documentsRouter.get("/:id", requireAuth(), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, "Document not found.", "NOT_FOUND");
  const d = await prisma().document.findUnique({ where: { id: id.data } });
  const me = req.auth!;
  if (!d || !d.attachedAt || (d.userId !== me.sub && me.role !== "admin")) throw new HttpError(404, "Document not found.", "NOT_FOUND");
  if (d.userId !== me.sub) await audit(req, "document.viewed", me.sub, { documentId: d.id, owner: d.userId ?? "" });
  res.setHeader("Content-Type", d.mimeType);
  res.setHeader("Content-Disposition", `inline; filename="${d.fileName}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(decryptBytes(d.data));
});

/* ---------- Profile photo ---------- */

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 } });

/** POST /api/v1/profile/me/photo (multipart "file") – replace my profile photo (JPG / PNG, max 2 MB). */
profileRouter.post("/me/photo", requireAuth(), async (req, res) => {
  await new Promise<void>((resolve, reject) =>
    photoUpload.single("file")(req, res, (err: unknown) =>
      !err ? resolve() : reject(err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE" ? new HttpError(413, "Photo must be under 2 MB.", "FILE_TOO_LARGE") : new HttpError(400, "Upload one photo.", "BAD_UPLOAD")),
    ),
  );
  const file = req.file;
  if (!file?.buffer.length) throw new HttpError(400, "Please choose a photo.", "NO_FILE");
  const type = sniff(file.buffer);
  if (type !== "jpg" && type !== "png") throw new HttpError(415, "Only JPG or PNG photos are allowed.", "BAD_FILE_TYPE");
  const userId = req.auth!.sub;
  const db = prisma();
  const doc = await db.$transaction(async (tx) => {
    await tx.document.deleteMany({ where: { userId, kind: "photo" } });
    return tx.document.create({
      data: {
        kind: "photo",
        userId,
        attachedAt: new Date(),
        fileName: `photo.${type}`,
        mimeType: type === "jpg" ? "image/jpeg" : "image/png",
        size: file.buffer.length,
        sha256: sha256(file.buffer),
        data: new Uint8Array(encryptBytes(file.buffer)),
        // Attached straight away, so the one-time upload token is never used: store a random unusable hash.
        uploadTokenHash: sha256(randomBytes(32)),
        ip: clientIp(req),
      },
      select: { id: true, kind: true, fileName: true, mimeType: true, size: true, createdAt: true },
    });
  });
  await audit(req, "profile.photo_changed", userId);
  res.status(201).json({ document: doc });
});

/**
 * GET /api/v1/users/:id/photo – profile photo. Visible to the person, the admin,
 * and the DEO / verifier who work on the same area.
 */
export const usersRouter = Router();
usersRouter.get("/:id/photo", requireAuth(), async (req, res) => {
  const id = z.string().regex(/^[A-Z]{2,5}\d{0,8}$/).safeParse(String(req.params.id).toUpperCase());
  if (!id.success || !(await canSeePhoto(req.auth!, id.data))) throw new HttpError(404, "Photo not found.", "NOT_FOUND");
  const d = await prisma().document.findFirst({ where: { userId: id.data, kind: "photo", attachedAt: { not: null } }, orderBy: { createdAt: "desc" } });
  if (!d) throw new HttpError(404, "Photo not found.", "NOT_FOUND");
  res.setHeader("Content-Type", d.mimeType);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("ETag", `"${d.sha256.slice(0, 16)}"`);
  res.send(decryptBytes(d.data));
});
