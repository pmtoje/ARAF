import type { Db } from "../db";
import { maybeOne, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { hmac, randomToken } from "../crypto";

/** Single-use sign-in codes for Pay with ARAF's admin portal live for 60 seconds. */
export const SSO_CODE_TTL_SECONDS = 60;

export function isAllowedRedirect(uri: string): boolean {
  const cfg = config.payWithAraf;
  return cfg.enabled && cfg.ssoRedirectUris.includes(uri);
}

/**
 * Issue a code for the signed-in ARAF user (sign-in to ARAF already required the @altbank.ng email OTP).
 * Pay with ARAF exchanges it server-to-server; the code alone carries no identity.
 */
export async function issueSsoCode(ctx: Ctx, redirectUri: string): Promise<string> {
  const actor = ctx.actor;
  if (!actor?.sessionId) throw new Error("No session");
  if (!isAllowedRedirect(redirectUri)) throw new Error("Redirect not allowed");
  const code = randomToken(32);
  await withTx(async (tx) => {
    const s = await maybeOne<{ created_at: Date }>(tx, "SELECT created_at FROM sessions WHERE id = $1 AND revoked_at IS NULL", [actor.sessionId]);
    if (!s) throw new Error("Session not found");
    await tx.query("DELETE FROM pwa_sso_codes WHERE expires_at < $1", [new Date(ctx.now.getTime() - 3600_000)]);
    await tx.query(
      `INSERT INTO pwa_sso_codes (code_hash, staff_id, session_id, redirect_uri, auth_time, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [hmac(`pwa-sso:${code}`), actor.staffId, actor.sessionId, redirectUri, s.created_at, new Date(ctx.now.getTime() + SSO_CODE_TTL_SECONDS * 1000), ctx.now],
    );
    await audit(tx, ctx, { action: "PWA_SSO_CODE_ISSUED", details: { redirectHost: new URL(redirectUri).host } });
  });
  return code;
}

export interface SsoIdentity {
  email: string;
  name: string;
  auth_time: number;
  amr: string[];
}

/** Exchange a code (once). Refused when expired, already used, for another redirect, or the person is no longer active. */
export async function exchangeSsoCode(q: Db, ctx: Ctx, code: string, redirectUri: string): Promise<SsoIdentity | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) return null;
  const row = await maybeOne<{ staff_id: string; auth_time: Date; email: string; full_name: string }>(
    q,
    `WITH used AS (
       UPDATE pwa_sso_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 AND redirect_uri = $3
       RETURNING staff_id, session_id, auth_time)
     SELECT u.staff_id, u.auth_time, s.email, s.full_name
       FROM used u JOIN staff s ON s.id = u.staff_id JOIN sessions se ON se.id = u.session_id
      WHERE s.status = 'ACTIVE' AND se.revoked_at IS NULL`,
    [hmac(`pwa-sso:${code}`), ctx.now, redirectUri],
  );
  if (!row) {
    await auditOutsideTx(ctx, { action: "PWA_SSO_EXCHANGE_REFUSED", outcome: "DENIED" });
    return null;
  }
  await auditOutsideTx(ctx, { action: "PWA_SSO_EXCHANGED", actorId: row.staff_id, actorEmail: row.email });
  return { email: row.email, name: row.full_name, auth_time: Math.floor(row.auth_time.getTime() / 1000), amr: ["otp"] };
}
