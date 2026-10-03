import bcrypt from "bcryptjs";
import type { Request } from "express";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import type { User } from "../../generated/prisma/client.js";
import { audit } from "../../lib/audit.js";
import { HttpError, clientIp, userAgent } from "../../lib/http.js";
import { mailEnabled, resetPasswordEmail, sendMail } from "../../lib/mailer.js";
import { newRefreshSecret, parseRefreshToken, passwordFingerprint, sha256, signAccessToken, signResetToken, verifyResetToken, type Role } from "./tokens.js";

export const BCRYPT_COST = 12;

/** Hash of a random value: used so "user not found" takes as long as "wrong password". */
const DUMMY_HASH = "$2b$12$pBjBuxfuZQSC6p0OHOxKbOt1et0y6KXFXzOIqsTqagTsTye9BSdVW";

/** A second refresh with the just-rotated token within this window is a parallel tab, not theft. */
const ROTATION_GRACE_MS = 30_000;

const INVALID = "Invalid ID / Mobile / Email or Password.";
const EXPIRED = "Session expired. Please log in again.";

export type PublicUser = Pick<User, "id" | "role" | "name" | "email" | "mobile" | "status">;
const toPublic = (u: User): PublicUser => ({ id: u.id, role: u.role, name: u.name, email: u.email, mobile: u.mobile, status: u.status });

/**
 * Who may log in: active employees, those waiting for approval (pending) and
 * inactive ones (they still see their entries and payments, but get no work).
 * Rejected and blocked accounts cannot log in.
 */
export const CAN_LOGIN = ["active", "pending", "inactive"] as const satisfies readonly User["status"][];
const canLogin = (s: User["status"]) => (CAN_LOGIN as readonly string[]).includes(s);

/** Accepts a User ID, a 10 digit mobile (with or without +91 / spaces) or an email. */
export function normaliseLoginId(raw: string) {
  const v = raw.trim();
  const phone = v.replace(/[\s-]/g, "").match(/^(?:\+?91|0)?([6-9]\d{9})$/);
  if (phone) return { kind: "mobile" as const, value: phone[1]! };
  if (v.includes("@")) return { kind: "email" as const, value: v.toLowerCase() };
  return { kind: "id" as const, value: v.toUpperCase() };
}

function minutesLeft(until: Date) {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
}

async function createSession(req: Request, user: User) {
  const { secret, hash } = newRefreshSecret();
  const expiresAt = new Date(Date.now() + config().REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const session = await prisma().authSession.create({
    data: { userId: user.id, role: user.role, tokenHash: hash, ip: clientIp(req), userAgent: userAgent(req), expiresAt },
  });
  const access = await signAccessToken({ sub: user.id, role: user.role, sid: session.id });
  return { refreshToken: `${session.id}.${secret}`, refreshExpires: expiresAt, access };
}

export async function revokeSession(sessionId: string, reason: string) {
  await prisma().authSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
}

/* ------------------------------------------------------------------ */

export async function login(req: Request, loginId: string, password: string) {
  const c = config();
  const key = normaliseLoginId(loginId);
  const user = await prisma().user.findFirst({ where: { [key.kind]: key.value } });

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    await audit(req, "login.failed", null, { reason: "unknown_id" });
    throw new HttpError(401, INVALID, "INVALID_CREDENTIALS");
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const mins = minutesLeft(user.lockedUntil);
    await audit(req, "login.locked", user.id);
    throw new HttpError(429, `Too many failed attempts. Please try again after ${mins} minute${mins > 1 ? "s" : ""}.`, "ACCOUNT_LOCKED", {
      "Retry-After": String(mins * 60),
    });
  }

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    // Atomic counter: after MAX_FAILED_LOGINS wrong passwords the account is locked for LOCK_MINUTES.
    const rows = await prisma().$queryRaw<{ locked_until: Date | null }[]>`
      update users set
        failed_login_count = case when failed_login_count + 1 >= ${c.MAX_FAILED_LOGINS}::int then 0 else failed_login_count + 1 end,
        locked_until       = case when failed_login_count + 1 >= ${c.MAX_FAILED_LOGINS}::int
                                  then now() + make_interval(mins => ${c.LOCK_MINUTES}::int) else locked_until end
      where id = ${user.id}
      returning locked_until`;
    await audit(req, "login.failed", user.id, { reason: "bad_password" });
    const lockedUntil = rows[0]?.locked_until;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw new HttpError(429, `Too many failed attempts. Your account is locked for ${c.LOCK_MINUTES} minutes.`, "ACCOUNT_LOCKED", {
        "Retry-After": String(c.LOCK_MINUTES * 60),
      });
    }
    throw new HttpError(401, INVALID, "INVALID_CREDENTIALS");
  }

  // Only reveal "blocked" after the correct password, so it cannot be used to discover accounts.
  if (!canLogin(user.status)) {
    await audit(req, "login.blocked", user.id);
    if (user.status === "rejected") {
      throw new HttpError(403, `Your registration was not approved${user.statusReason ? `: ${user.statusReason}` : ""}. Please contact the NASOI admin.`, "ACCOUNT_REJECTED");
    }
    throw new HttpError(403, "This account has been blocked by the admin. Please contact support.", "ACCOUNT_BLOCKED");
  }

  await prisma().user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const s = await createSession(req, user);
  await audit(req, "login.success", user.id, { role: user.role });
  return { user: toPublic(user), ...s };
}

/** Rotates the refresh token and issues a new access token. */
export async function refresh(req: Request, role: Role, raw: unknown) {
  const parsed = parseRefreshToken(raw);
  if (!parsed) throw new HttpError(401, EXPIRED, "NO_SESSION");
  const db = prisma();

  const s = await db.authSession.findUnique({ where: { id: parsed.sessionId }, include: { user: true } });
  if (!s || s.role !== role || s.revokedAt || s.expiresAt.getTime() <= Date.now()) throw new HttpError(401, EXPIRED, "NO_SESSION");
  if (!canLogin(s.user.status) || s.user.role !== role) {
    await revokeSession(s.id, "user_inactive");
    throw new HttpError(401, EXPIRED, "NO_SESSION");
  }

  const presented = sha256(parsed.secret);
  const next = newRefreshSecret();
  // Compare-and-swap: only succeeds if the presented token is the current one.
  const swapped = await db.authSession.updateMany({
    where: { id: s.id, tokenHash: presented, revokedAt: null },
    data: { prevTokenHash: presented, tokenHash: next.hash, rotatedAt: new Date(), lastUsedAt: new Date() },
  });
  if (swapped.count === 1) {
    const access = await signAccessToken({ sub: s.user.id, role, sid: s.id });
    return { user: toPublic(s.user), access, refreshToken: `${s.id}.${next.secret}`, refreshExpires: s.expiresAt };
  }

  const now = await db.authSession.findUnique({ where: { id: s.id } });
  if (now && !now.revokedAt && now.prevTokenHash === presented && now.rotatedAt && Date.now() - now.rotatedAt.getTime() < ROTATION_GRACE_MS) {
    // Two tabs refreshed at the same moment; the other one already rotated the cookie.
    const access = await signAccessToken({ sub: s.user.id, role, sid: s.id });
    return { user: toPublic(s.user), access, refreshToken: null, refreshExpires: s.expiresAt };
  }

  // An old refresh token was replayed → assume it was stolen and kill the session.
  await revokeSession(s.id, "reuse_detected");
  await audit(req, "token.reuse_detected", s.user.id, { sessionId: s.id });
  throw new HttpError(401, EXPIRED, "NO_SESSION");
}

export async function logout(req: Request, raw: unknown) {
  const parsed = parseRefreshToken(raw);
  if (!parsed) return;
  const s = await prisma().authSession.findFirst({
    where: { id: parsed.sessionId, tokenHash: sha256(parsed.secret), revokedAt: null },
    select: { userId: true },
  });
  if (s) {
    await revokeSession(parsed.sessionId, "logout");
    await audit(req, "logout", s.userId);
  }
}

/** Used by requireAuth on every request: the session must still be live and the user active. */
export async function sessionIsLive(sessionId: string, userId: string) {
  const n = await prisma().authSession.count({
    where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() }, user: { status: { in: [...CAN_LOGIN] } } },
  });
  return n > 0;
}

export async function getMe(userId: string) {
  const u = await prisma().user.findUnique({ where: { id: userId } });
  if (!u) throw new HttpError(404, "User not found.", "NOT_FOUND");
  return { ...toPublic(u), lastLoginAt: u.lastLoginAt };
}

export async function changePassword(req: Request, userId: string, sessionId: string, current: string, next: string) {
  const db = prisma();
  const u = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!u || !(await bcrypt.compare(current, u.passwordHash))) {
    throw new HttpError(400, "Current password is incorrect.", "WRONG_PASSWORD");
  }
  if (await bcrypt.compare(next, u.passwordHash)) {
    throw new HttpError(400, "New password must be different from the current password.", "SAME_PASSWORD");
  }
  const passwordHash = await bcrypt.hash(next, BCRYPT_COST);
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: new Date() } }),
    // Log out every other device; keep the current session.
    db.authSession.updateMany({
      where: { userId, id: { not: sessionId }, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: "password_changed" },
    }),
  ]);
  await audit(req, "password.changed", userId);
}

/* ------------------------------------------------------------------ */
/* Forgot / reset password                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every forgot-password answer takes at least this long, so timing does not reveal which e-mails exist. */
const FORGOT_MIN_MS = 1500;

/**
 * Sends a reset link if an active account has this e-mail.
 * The caller always gets the same answer, whether or not the account exists.
 */
export async function forgotPassword(req: Request, email: string) {
  if (!mailEnabled()) throw new HttpError(503, "Password reset by e-mail is not available right now. Please contact the admin.", "MAIL_DISABLED");
  const started = Date.now();
  try {
    const user = await prisma().user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !canLogin(user.status)) {
      await audit(req, "password.reset_requested", null, { found: false });
      return;
    }
    const token = await signResetToken(user.id, user.passwordHash);
    // Token goes in the URL fragment (#), which browsers never send to servers or logs.
    const link = `${config().APP_URL.replace(/\/$/, "")}/reset-password#token=${token}`;
    const mail = resetPasswordEmail(user.name, link, config().RESET_TOKEN_TTL_MIN);
    try {
      await sendMail({ to: user.email!, ...mail });
      await audit(req, "password.reset_requested", user.id, { found: true, sent: true });
    } catch (err) {
      console.error("[mail] reset e-mail failed", (err as Error).message);
      await audit(req, "password.reset_requested", user.id, { found: true, sent: false });
      throw new HttpError(502, "We could not send the e-mail right now. Please try again in a few minutes.", "MAIL_FAILED");
    }
  } finally {
    const left = FORGOT_MIN_MS - (Date.now() - started);
    if (left > 0) await sleep(left);
  }
}

/** Sets a new password from a valid, unused reset link and logs out every device. */
export async function resetPassword(req: Request, token: string, newPassword: string) {
  const invalid = new HttpError(400, "This reset link is invalid or has expired. Please request a new one.", "BAD_RESET_LINK");
  let claims: { sub: string; pwf: string };
  try {
    claims = await verifyResetToken(token);
  } catch {
    throw invalid;
  }
  const db = prisma();
  const user = await db.user.findUnique({ where: { id: claims.sub } });
  // A changed password (including a previous reset with this link) changes the fingerprint.
  if (!user || !canLogin(user.status) || passwordFingerprint(user.passwordHash) !== claims.pwf) throw invalid;
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new HttpError(400, "New password must be different from the current password.", "SAME_PASSWORD");
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    }),
    db.authSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: "password_reset" },
    }),
  ]);
  await audit(req, "password.reset", user.id);
  return { id: user.id };
}
