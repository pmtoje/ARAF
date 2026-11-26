import { createHmac } from "node:crypto";
import type { Db } from "../db";
import { config } from "../config";
import { safeEqualHex } from "../crypto";

/**
 * Request signing shared with Pay with ARAF (integration contract v1).
 *   signature = "v1=" + hex HMAC-SHA256(secret, `${unixSeconds}.${METHOD}.${path}.${rawBody}`)
 * Requests from Pay with ARAF carry X-PWA-Timestamp / X-PWA-Signature; callbacks from ARAF carry
 * X-ARAF-Timestamp / X-ARAF-Signature. Timestamps more than 300 seconds old are refused.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signPwa(secret: string, timestamp: number, method: string, path: string, body: string): string {
  return "v1=" + createHmac("sha256", secret).update(`${timestamp}.${method.toUpperCase()}.${path}.${body}`).digest("hex");
}

export type VerifyResult = { ok: true } | { ok: false; reason: "DISABLED" | "MISSING" | "STALE" | "BAD_SIGNATURE" };

/**
 * Verify a signed request from Pay with ARAF. A replay inside the 300-second window is harmless rather than refused:
 * every endpoint is idempotent (same Idempotency-Key → same case; reports de-duplicated by event id; sign-in codes
 * are single-use), and refusing an identical retry would break Pay with ARAF's safe retries on slow networks.
 */
export async function verifyPwaRequest(
  _q: Db,
  req: { method: string; path: string; body: string; timestamp: string | null; signature: string | null },
  now: Date,
): Promise<VerifyResult> {
  const cfg = config.payWithAraf;
  if (!cfg.enabled || cfg.secret.length < 32) return { ok: false, reason: "DISABLED" };
  if (!req.timestamp || !req.signature) return { ok: false, reason: "MISSING" };
  const t = Number(req.timestamp);
  if (!Number.isInteger(t) || Math.abs(now.getTime() / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "STALE" };
  const expected = signPwa(cfg.secret, t, req.method, req.path, req.body);
  const given = req.signature.startsWith("v1=") ? req.signature.slice(3) : "";
  if (!/^[0-9a-f]{64}$/.test(given) || !safeEqualHex(given, expected.slice(3))) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true };
}
