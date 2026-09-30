import bcrypt from "bcryptjs";
import type { Request } from "express";
import { config } from "../../config.js";
import { db, query } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { HttpError, clientIp, userAgent } from "../../lib/http.js";
import { type Role, newRefreshSecret, parseRefreshToken, safeEqualHex, sha256, signAccessToken } from "./tokens.js";

export const BCRYPT_COST = 12;

/** Hash of a random value: used so "user not found" takes as long as "wrong password". */
const DUMMY_HASH = "$2b$12$pBjBuxfuZQSC6p0OHOxKbOt1et0y6KXFXzOIqsTqagTsTye9BSdVW";

/** A second refresh with the just-rotated token within this window is treated as a parallel tab, not theft. */
const ROTATION_GRACE_MS = 30_000;

const INVALID = "Invalid ID / Mobile / Email or Password.";

type UserRow = {
  id: string;
  role: Role;
  name: string;
  email: string | null;
  mobile: string | null;
  status: "active" | "blocked";
  password_hash: string;
  locked_until: Date | null;
};

export type PublicUser = Pick<UserRow, "id" | "role" | "name" | "email" | "mobile">;
const toPublic = (u: UserRow): PublicUser => ({ id: u.id, role: u.role, name: u.name, email: u.email, mobile: u.mobile });

/** Accepts a User ID, a 10 digit mobile (with or without +91 / spaces) or an email. */
export function normaliseLoginId(raw: string) {
  const v = raw.trim().toLowerCase();
  const digits = v.replace(/[\s-]/g, "");
  const phone = digits.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
  return phone ? phone[1] : v;
}

function minutesLeft(until: Date) {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
}

async function createSession(req: Request, user: UserRow) {
  const { secret, hash } = newRefreshSecret();
  const days = config().REFRESH_TOKEN_TTL_DAYS;
  const { rows } = await query<{ id: string; expires_at: Date }>(
    `insert into auth_sessions (user_id, role, token_hash, ip, user_agent, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id, expires_at`,
    [user.id, user.role, hash, clientIp(req), userAgent(req), days],
  );
  const session = rows[0]!;
  const access = await signAccessToken({ sub: user.id, role: user.role, sid: session.id });
  return { refreshToken: `${session.id}.${secret}`, refreshExpires: session.expires_at, access };
}

export async function revokeSession(sessionId: string, reason: string) {
  await query("update auth_sessions set revoked_at = now(), revoke_reason = $2 where id = $1 and revoked_at is null", [sessionId, reason]);
}

/* ------------------------------------------------------------------ */

export async function login(req: Request, loginId: string, password: string) {
  const c = config();
  const key = normaliseLoginId(loginId);
  const { rows } = await query<UserRow>(
    `select id, role, name, email, mobile, status, password_hash, locked_until
       from users
      where lower(id) = $1 or mobile = $1 or lower(email) = $1
      limit 1`,
    [key],
  );
  const user = rows[0];

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    await audit(req, "login.failed", null, { reason: "unknown_id" });
    throw new HttpError(401, INVALID, "INVALID_CREDENTIALS");
  }

  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    const mins = minutesLeft(user.locked_until);
    await audit(req, "login.locked", user.id);
    throw new HttpError(429, `Too many failed attempts. Please try again after ${mins} minute${mins > 1 ? "s" : ""}.`, "ACCOUNT_LOCKED", {
      "Retry-After": String(mins * 60),
    });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    // Atomic counter: after MAX_FAILED_LOGINS wrong passwords the account is locked for LOCK_MINUTES.
    const { rows: r } = await query<{ locked_until: Date | null }>(
      `update users set
          failed_login_count = case when failed_login_count + 1 >= $2 then 0 else failed_login_count + 1 end,
          locked_until       = case when failed_login_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
        where id = $1
        returning locked_until`,
      [user.id, c.MAX_FAILED_LOGINS, c.LOCK_MINUTES],
    );
    await audit(req, "login.failed", user.id, { reason: "bad_password" });
    const lockedUntil = r[0]?.locked_until;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw new HttpError(429, `Too many failed attempts. Your account is locked for ${c.LOCK_MINUTES} minutes.`, "ACCOUNT_LOCKED", {
        "Retry-After": String(c.LOCK_MINUTES * 60),
      });
    }
    throw new HttpError(401, INVALID, "INVALID_CREDENTIALS");
  }

  // Only reveal "blocked" after the correct password, so it cannot be used to discover accounts.
  if (user.status !== "active") {
    await audit(req, "login.blocked", user.id);
    throw new HttpError(403, "This account has been blocked by the admin. Please contact support.", "ACCOUNT_BLOCKED");
  }

  await query("update users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1", [user.id]);
  const s = await createSession(req, user);
  await audit(req, "login.success", user.id, { role: user.role });
  return { user: toPublic(user), ...s };
}

/** Rotates the refresh token and issues a new access token. */
export async function refresh(req: Request, role: Role, raw: unknown) {
  const parsed = parseRefreshToken(raw);
  if (!parsed) throw new HttpError(401, "Session expired. Please log in again.", "NO_SESSION");

  const client = await db().connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{
      id: string; user_id: string; role: Role; token_hash: string; prev_token_hash: string | null;
      rotated_at: Date | null; expires_at: Date; revoked_at: Date | null;
    }>(
      `select id, user_id, role, token_hash, prev_token_hash, rotated_at, expires_at, revoked_at
         from auth_sessions where id = $1 for update`,
      [parsed.sessionId],
    );
    const s = rows[0];
    const presented = sha256(parsed.secret);
    if (!s || s.role !== role || s.revoked_at || s.expires_at.getTime() <= Date.now()) {
      await client.query("rollback");
      throw new HttpError(401, "Session expired. Please log in again.", "NO_SESSION");
    }

    const { rows: us } = await client.query<UserRow>(
      "select id, role, name, email, mobile, status, password_hash, locked_until from users where id = $1",
      [s.user_id],
    );
    const user = us[0];
    if (!user || user.status !== "active" || user.role !== role) {
      await client.query("update auth_sessions set revoked_at = now(), revoke_reason = 'user_inactive' where id = $1", [s.id]);
      await client.query("commit");
      throw new HttpError(401, "Session expired. Please log in again.", "NO_SESSION");
    }

    if (safeEqualHex(s.token_hash, presented)) {
      // Normal case: rotate.
      const next = newRefreshSecret();
      await client.query(
        `update auth_sessions set prev_token_hash = token_hash, token_hash = $2, rotated_at = now(), last_used_at = now()
          where id = $1`,
        [s.id, next.hash],
      );
      await client.query("commit");
      const access = await signAccessToken({ sub: user.id, role: user.role, sid: s.id });
      return { user: toPublic(user), access, refreshToken: `${s.id}.${next.secret}`, refreshExpires: s.expires_at };
    }

    if (safeEqualHex(s.prev_token_hash, presented) && s.rotated_at && Date.now() - s.rotated_at.getTime() < ROTATION_GRACE_MS) {
      // Two tabs refreshed at the same moment; the other one already rotated the cookie.
      await client.query("commit");
      const access = await signAccessToken({ sub: user.id, role: user.role, sid: s.id });
      return { user: toPublic(user), access, refreshToken: null, refreshExpires: s.expires_at };
    }

    // An old refresh token was replayed → assume it was stolen and kill the session.
    await client.query("update auth_sessions set revoked_at = now(), revoke_reason = 'reuse_detected' where id = $1", [s.id]);
    await client.query("commit");
    await audit(req, "token.reuse_detected", user.id, { sessionId: s.id });
    throw new HttpError(401, "Session expired. Please log in again.", "NO_SESSION");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function logout(req: Request, raw: unknown) {
  const parsed = parseRefreshToken(raw);
  if (!parsed) return;
  const { rows } = await query<{ user_id: string; token_hash: string }>(
    "select user_id, token_hash from auth_sessions where id = $1 and revoked_at is null",
    [parsed.sessionId],
  );
  const s = rows[0];
  if (s && safeEqualHex(s.token_hash, sha256(parsed.secret))) {
    await revokeSession(parsed.sessionId, "logout");
    await audit(req, "logout", s.user_id);
  }
}

/** Used by requireAuth on every request: the session must still be live and the user active. */
export async function sessionIsLive(sessionId: string, userId: string) {
  const { rows } = await query<{ ok: boolean }>(
    `select true as ok from auth_sessions s join users u on u.id = s.user_id
      where s.id = $1 and s.user_id = $2 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'`,
    [sessionId, userId],
  );
  return rows.length > 0;
}

export async function getMe(userId: string) {
  const { rows } = await query<UserRow & { last_login_at: Date | null }>(
    "select id, role, name, email, mobile, status, password_hash, locked_until, last_login_at from users where id = $1",
    [userId],
  );
  const u = rows[0];
  if (!u) throw new HttpError(404, "User not found.", "NOT_FOUND");
  return { ...toPublic(u), lastLoginAt: u.last_login_at };
}

export async function changePassword(req: Request, userId: string, sessionId: string, current: string, next: string) {
  const { rows } = await query<{ password_hash: string }>("select password_hash from users where id = $1", [userId]);
  const row = rows[0];
  if (!row || !(await bcrypt.compare(current, row.password_hash))) {
    throw new HttpError(400, "Current password is incorrect.", "WRONG_PASSWORD");
  }
  if (await bcrypt.compare(next, row.password_hash)) {
    throw new HttpError(400, "New password must be different from the current password.", "SAME_PASSWORD");
  }
  const hash = await bcrypt.hash(next, BCRYPT_COST);
  await query("update users set password_hash = $2, password_changed_at = now() where id = $1", [userId, hash]);
  // Log out every other device; keep the current session.
  await query(
    "update auth_sessions set revoked_at = now(), revoke_reason = 'password_changed' where user_id = $1 and id <> $2 and revoked_at is null",
    [userId, sessionId],
  );
  await audit(req, "password.changed", userId);
}
