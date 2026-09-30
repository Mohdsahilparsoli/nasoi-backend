import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../config.js";

/**
 * Field / file encryption for sensitive data (Aadhaar, bank account, documents).
 *
 * DATA_ENCRYPTION_KEY = 32 random bytes, base64 (openssl rand -base64 32).
 * Two sub-keys are derived with HKDF: one for AES-256-GCM, one for HMAC lookups.
 * KEEP A BACKUP OF THE KEY – without it encrypted data cannot be read.
 */
let keys: { enc: Buffer; mac: Buffer } | undefined;

function k() {
  if (keys) return keys;
  const master = Buffer.from(config().DATA_ENCRYPTION_KEY, "base64");
  if (master.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (base64)");
  keys = {
    enc: Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "nasoi:aes-256-gcm", 32)),
    mac: Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "nasoi:hmac-sha256", 32)),
  };
  return keys;
}

const VERSION = 1;

/** Encrypts bytes → [version(1) | iv(12) | tag(16) | ciphertext]. */
export function encryptBytes(plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k().enc, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]);
}

export function decryptBytes(blob: Uint8Array): Buffer {
  const b = Buffer.from(blob);
  if (b[0] !== VERSION) throw new Error("Unknown encryption version");
  const d = createDecipheriv("aes-256-gcm", k().enc, b.subarray(1, 13));
  d.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([d.update(b.subarray(29)), d.final()]);
}

export const encryptText = (v: string) => encryptBytes(Buffer.from(v, "utf8")).toString("base64");
export const decryptText = (v: string) => decryptBytes(Buffer.from(v, "base64")).toString("utf8");

/** Deterministic keyed hash, used to find duplicates without storing the value. */
export const lookupHash = (v: string) => createHmac("sha256", k().mac).update(v).digest("hex");
