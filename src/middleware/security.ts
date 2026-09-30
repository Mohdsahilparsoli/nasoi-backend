import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";
import { sessionIsLive } from "../modules/auth/service.js";
import { type AccessClaims, type Role, verifyAccessToken } from "../modules/auth/tokens.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: AccessClaims;
  }
}

/** Header every NASOI web request carries. Browsers cannot add it cross-site without a CORS preflight we reject. */
export const CLIENT_HEADER = "x-nasoi-client";

/**
 * CSRF defence for cookie-based endpoints (together with SameSite=Strict cookies):
 * state-changing requests must carry our custom header, and if the browser sent
 * an Origin it must be one of ours.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get(CLIENT_HEADER) !== "web") return next(new HttpError(403, "Request blocked.", "CSRF"));
  const origin = req.get("origin");
  if (origin && !config().corsOrigins.includes(origin.replace(/\/$/, ""))) {
    return next(new HttpError(403, "Request blocked.", "BAD_ORIGIN"));
  }
  next();
}

/** Verifies the Bearer access token and that its session is still live. */
export function requireAuth(...roles: Role[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const h = req.get("authorization") ?? "";
      const m = h.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/);
      if (!m) throw new HttpError(401, "Please log in.", "UNAUTHENTICATED");
      let claims: AccessClaims;
      try {
        claims = await verifyAccessToken(m[1]!);
      } catch {
        throw new HttpError(401, "Session expired. Please log in again.", "TOKEN_EXPIRED");
      }
      if (!(await sessionIsLive(claims.sid, claims.sub))) throw new HttpError(401, "Session expired. Please log in again.", "TOKEN_EXPIRED");
      if (roles.length && !roles.includes(claims.role)) throw new HttpError(403, "You do not have access to this.", "FORBIDDEN");
      req.auth = claims;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}
