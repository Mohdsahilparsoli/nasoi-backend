import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

/** Error with an HTTP status and a message that is safe to show to users. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "ERROR",
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: err.issues[0]?.message ?? "Invalid request.",
        fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === "entity.parse.failed") return res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON body." } });
  if (e?.type === "entity.too.large") return res.status(413).json({ error: { code: "TOO_LARGE", message: "Request body too large." } });
  // Unknown error: log it on the server, never leak details to the client.
  console.error("[api] unhandled error", err);
  return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong. Please try again." } });
}

export function clientIp(req: Request): string {
  return (req.ip ?? "").replace(/^::ffff:/, "").slice(0, 64);
}

export function userAgent(req: Request): string {
  return String(req.headers["user-agent"] ?? "").slice(0, 300);
}
