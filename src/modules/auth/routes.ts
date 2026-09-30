import { type Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config.js";
import { clientIp } from "../../lib/http.js";
import { noStore, requireAuth } from "../../middleware/security.js";
import { passwordRule } from "../registration/schema.js";
import * as auth from "./service.js";
import { ROLES, type Role, refreshCookieName } from "./tokens.js";

export const authRouter = Router();
authRouter.use(noStore);

const loginBody = z.object({
  loginId: z.string().trim().min(1, "Enter your User ID, mobile number or email").max(120),
  password: z.string().min(1, "Enter your password").max(128),
});
const roleBody = z.object({ role: z.enum(ROLES) });
const forgotBody = z.object({ email: z.string().trim().toLowerCase().max(80).email("Enter a valid email ID") });
const resetBody = z.object({ token: z.string().min(20, "Invalid reset link").max(2000), newPassword: passwordRule });
const changePwBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordRule });

/** Per IP + login ID, so one attacker cannot hammer an account and other users are never affected. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `${clientIp(req)}|${auth.normaliseLoginId(String(req.body?.loginId ?? "")).value}`,
  message: { error: { code: "RATE_LIMITED", message: "Too many login attempts. Please wait 15 minutes and try again." } },
});
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } },
});

function setRefreshCookie(res: Response, role: Role, token: string, expires: Date) {
  res.cookie(refreshCookieName(role), token, {
    httpOnly: true, // not readable by JavaScript
    secure: config().isProd, // HTTPS only in production
    sameSite: "strict", // never sent on cross-site requests
    path: "/api/v1/auth", // only sent to auth endpoints
    expires,
  });
}
function clearRefreshCookie(res: Response, role: Role) {
  res.clearCookie(refreshCookieName(role), { httpOnly: true, secure: config().isProd, sameSite: "strict", path: "/api/v1/auth" });
}

/** POST /api/v1/auth/login – one login for every role; the role comes from the account. */
authRouter.post("/login", loginLimiter, async (req, res) => {
  const body = loginBody.parse(req.body);
  const r = await auth.login(req, body.loginId, body.password);
  // A new login for this role replaces any older session in this browser.
  const old = req.cookies?.[refreshCookieName(r.user.role)];
  if (old) await auth.logout(req, old).catch(() => {});
  setRefreshCookie(res, r.user.role, r.refreshToken, r.refreshExpires);
  res.json({ user: r.user, accessToken: r.access.token, expiresIn: r.access.expiresIn });
});

/** POST /api/v1/auth/refresh – new access token from the httpOnly refresh cookie (rotated). */
authRouter.post("/refresh", refreshLimiter, async (req, res) => {
  const { role } = roleBody.parse(req.body);
  try {
    const r = await auth.refresh(req, role, req.cookies?.[refreshCookieName(role)]);
    if (r.refreshToken) setRefreshCookie(res, role, r.refreshToken, r.refreshExpires);
    res.json({ user: r.user, accessToken: r.access.token, expiresIn: r.access.expiresIn });
  } catch (err) {
    clearRefreshCookie(res, role);
    throw err;
  }
});

/** POST /api/v1/auth/logout – revokes this role's session in this browser. */
authRouter.post("/logout", async (req, res) => {
  const { role } = roleBody.parse(req.body);
  await auth.logout(req, req.cookies?.[refreshCookieName(role)]);
  clearRefreshCookie(res, role);
  res.json({ ok: true });
});

/** GET /api/v1/auth/me */
authRouter.get("/me", requireAuth(), async (req, res) => {
  res.json({ user: await auth.getMe(req.auth!.sub) });
});

/** POST /api/v1/auth/change-password – also logs out all other devices. */
authRouter.post("/change-password", requireAuth(), async (req, res) => {
  const body = changePwBody.parse(req.body);
  await auth.changePassword(req, req.auth!.sub, req.auth!.sid, body.currentPassword, body.newPassword);
  res.json({ ok: true, message: "Password changed successfully." });
});

/** Per IP + e-mail (stops mail bombing one person) and per IP overall. */
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `${clientIp(req)}|${String(req.body?.email ?? "").trim().toLowerCase()}`,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests for this email. Please wait 15 minutes and try again." } },
});
const forgotIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } },
});
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." } },
});

/** POST /api/v1/auth/forgot-password – always the same answer, whether the e-mail exists or not. */
authRouter.post("/forgot-password", forgotIpLimiter, forgotLimiter, async (req, res) => {
  const { email } = forgotBody.parse(req.body);
  await auth.forgotPassword(req, email);
  res.json({ ok: true, message: "If an account exists with this email, a password reset link has been sent. Please check your inbox and spam folder." });
});

/** POST /api/v1/auth/reset-password – token from the e-mail link + new password. */
authRouter.post("/reset-password", resetLimiter, async (req, res) => {
  const { token, newPassword } = resetBody.parse(req.body);
  await auth.resetPassword(req, token, newPassword);
  res.json({ ok: true, message: "Your password has been changed. Please log in with the new password." });
});
