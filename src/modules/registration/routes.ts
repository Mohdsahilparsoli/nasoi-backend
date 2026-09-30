import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config.js";
import { HttpError, clientIp } from "../../lib/http.js";
import { noStore } from "../../middleware/security.js";
import { registrationSchema } from "./schema.js";
import { register } from "./service.js";
import { DOCUMENT_KINDS, MAX_UPLOAD_BYTES, storeUpload } from "./uploads.js";

export const registrationRouter = Router();
registrationRouter.use(noStore);

const limiter = (limit: () => number, windowMin: number, message: string) =>
  rateLimit({
    windowMs: windowMin * 60 * 1000,
    limit: () => limit(),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => clientIp(req),
    message: { error: { code: "RATE_LIMITED", message } },
  });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 100 },
});

/** Wraps multer so its errors become clean JSON responses. */
function singleFile(req: Parameters<ReturnType<typeof upload.single>>[0], res: Parameters<ReturnType<typeof upload.single>>[1]) {
  return new Promise<void>((resolve, reject) =>
    upload.single("file")(req, res, (err: unknown) => {
      if (!err) return resolve();
      if (err instanceof multer.MulterError) {
        return reject(
          err.code === "LIMIT_FILE_SIZE"
            ? new HttpError(413, "File must be under 2 MB.", "FILE_TOO_LARGE")
            : new HttpError(400, "Upload one file at a time.", "BAD_UPLOAD"),
        );
      }
      reject(err);
    }),
  );
}

/**
 * POST /api/v1/registrations/uploads   (multipart: kind, file)
 * Stores one document (encrypted) and returns { id, token } for the final submit.
 */
registrationRouter.post("/uploads", limiter(() => config().UPLOADS_PER_HOUR, 60, "Too many uploads. Please try again after some time."), async (req, res) => {
  if (!req.is("multipart/form-data")) throw new HttpError(415, "Send the file as multipart/form-data.", "BAD_UPLOAD");
  await singleFile(req, res);
  const kind = z.enum(DOCUMENT_KINDS, { error: "Unknown document type" }).parse(req.body?.kind);
  if (!req.file) throw new HttpError(400, "Please choose a file to upload.", "NO_FILE");
  const r = await storeUpload(req, kind, req.file);
  res.status(201).json({ upload: r });
});

/**
 * POST /api/v1/registrations   (JSON)
 * Creates a Data Entry Operator or Verifier account with profile and documents.
 */
registrationRouter.post("/", limiter(() => config().REGISTRATIONS_PER_HOUR, 60, "Too many registration attempts. Please try again after some time."), async (req, res) => {
  const input = registrationSchema.parse(req.body);
  const user = await register(req, input);
  res.status(201).json({ user, message: "Registration successful." });
});
