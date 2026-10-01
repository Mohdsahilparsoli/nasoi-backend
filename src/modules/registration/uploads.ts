import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { prisma } from "../../db.js";
import type { DocumentKind } from "../../generated/prisma/client.js";
import { encryptBytes } from "../../lib/crypto.js";
import { HttpError, clientIp } from "../../lib/http.js";

/** Kinds that can be uploaded now ("aadhaar" single-file is kept only for older registrations). */
export const DOCUMENT_KINDS = ["aadhaar_front", "aadhaar_back", "pan", "bank_proof", "photo", "signature"] as const satisfies readonly DocumentKind[];

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB after client-side compression

/** Photo / signature must be images; ID documents may also be PDF. */
const ALLOWED: Record<DocumentKind, readonly ("jpg" | "png" | "pdf")[]> = {
  aadhaar: ["jpg", "png", "pdf"],
  aadhaar_front: ["jpg", "png"],
  aadhaar_back: ["jpg", "png"],
  pan: ["jpg", "png", "pdf"],
  bank_proof: ["jpg", "png", "pdf"],
  photo: ["jpg", "png"],
  signature: ["jpg", "png"],
};
const MIME = { jpg: "image/jpeg", png: "image/png", pdf: "application/pdf" } as const;

/** Detect the real file type from its first bytes (never trust the name or browser MIME). */
export function sniff(buf: Buffer): "jpg" | "png" | "pdf" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  return null;
}

function safeName(name: string, type: "jpg" | "png" | "pdf") {
  const base = name.replace(/\.[^.]*$/, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "document";
  return `${base}.${type}`;
}

export const sha256 = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");

/** Stores an uploaded file (encrypted) and returns a one-time token to attach it on submit. */
export async function storeUpload(req: Request, kind: DocumentKind, file: { buffer: Buffer; originalname: string }) {
  if (!file.buffer.length) throw new HttpError(400, "The file is empty.", "EMPTY_FILE");
  if (file.buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "File must be under 2 MB.", "FILE_TOO_LARGE");
  const type = sniff(file.buffer);
  if (!type || !ALLOWED[kind].includes(type)) {
    const allowed = ALLOWED[kind].map((t) => t.toUpperCase()).join(", ");
    throw new HttpError(415, `Only ${allowed} files are allowed here.`, "BAD_FILE_TYPE");
  }
  const token = randomBytes(24).toString("base64url");
  const doc = await prisma().document.create({
    data: {
      kind,
      fileName: safeName(file.originalname, type),
      mimeType: MIME[type],
      size: file.buffer.length,
      sha256: sha256(file.buffer),
      data: new Uint8Array(encryptBytes(file.buffer)),
      uploadTokenHash: sha256(token),
      ip: clientIp(req),
    },
    select: { id: true, fileName: true, size: true, mimeType: true },
  });
  return { ...doc, kind, token };
}
