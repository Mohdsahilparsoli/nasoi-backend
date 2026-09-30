import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../../config.js";

export const ROLES = ["deo", "verifier", "admin"] as const;
export type Role = (typeof ROLES)[number];

const ISSUER = "nasoi-api";
const AUDIENCE = "nasoi-portal";

function key() {
  return new TextEncoder().encode(config().JWT_SECRET);
}

export type AccessClaims = { sub: string; role: Role; sid: string };

/** Short-lived access token (default 15 min), kept only in browser memory. */
export async function signAccessToken(c: AccessClaims) {
  const ttl = config().ACCESS_TOKEN_TTL_MIN;
  const token = await new SignJWT({ role: c.role, sid: c.sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(c.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttl}m`)
    .sign(key());
  return { token, expiresIn: ttl * 60 };
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key(), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
  const role = payload.role as Role;
  if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || !ROLES.includes(role)) {
    throw new Error("Malformed token");
  }
  return { sub: payload.sub, role, sid: payload.sid };
}

/**
 * Refresh token = "<sessionId>.<random secret>".
 * Only the SHA-256 of the secret is stored in the database.
 */
export function newRefreshSecret() {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: sha256(secret) };
}

export function parseRefreshToken(raw: unknown): { sessionId: string; secret: string } | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const [sessionId, secret] = raw.split(".");
  if (!sessionId || !secret || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  return { sessionId, secret };
}

export function sha256(v: string) {
  return createHash("sha256").update(v).digest("hex");
}

export function safeEqualHex(a: string | null | undefined, b: string) {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** One refresh cookie per role so DEO, Verifier and Admin can be logged in side by side. */
export function refreshCookieName(role: Role) {
  return `nasoi_rt_${role}`;
}
