import type { Request } from "express";
import { query } from "../db.js";
import { clientIp, userAgent } from "./http.js";

export type AuditAction =
  | "login.success"
  | "login.failed"
  | "login.locked"
  | "login.blocked"
  | "token.refresh"
  | "token.reuse_detected"
  | "logout"
  | "password.changed";

/** Append-only security log. Never stores passwords or tokens. */
export async function audit(req: Request, action: AuditAction, userId: string | null, meta: Record<string, unknown> = {}) {
  try {
    await query("insert into audit_logs (user_id, action, ip, user_agent, meta) values ($1, $2, $3, $4, $5)", [
      userId,
      action,
      clientIp(req),
      userAgent(req),
      JSON.stringify(meta),
    ]);
  } catch (err) {
    // Auditing must never break the request.
    console.error("[audit] failed to write", action, (err as Error).message);
  }
}
