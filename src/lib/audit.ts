import type { Request } from "express";
import { prisma } from "../db.js";
import { clientIp, userAgent } from "./http.js";

export type AuditAction =
  | "login.success"
  | "login.failed"
  | "login.locked"
  | "login.blocked"
  | "token.reuse_detected"
  | "logout"
  | "password.changed";

/** Append-only security log. Never stores passwords or tokens. */
export async function audit(req: Request, action: AuditAction, userId: string | null, meta: Record<string, string | number | boolean> = {}) {
  try {
    await prisma().auditLog.create({ data: { userId, action, ip: clientIp(req), userAgent: userAgent(req), meta } });
  } catch (err) {
    // Auditing must never break the request.
    console.error("[audit] failed to write", action, (err as Error).message);
  }
}
