import { db, withTx } from "../db";
import { systemCtx } from "../context";
import { audit } from "../audit";
import { config } from "../config";
import { backoffMs } from "../jobs/outbox";
import { notifyRoleHolders } from "../domain/notifications";
import { signPwa } from "./signing";

interface CallbackRow {
  id: string;
  case_id: string;
  event_id: string;
  sequence: number;
  body: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Deliver due status callbacks to Pay with ARAF, signed with the shared secret. Rows are claimed with SKIP LOCKED;
 * a case's callbacks go out strictly in sequence (a later one waits while an earlier one is undelivered).
 * Failures retry with backoff and become DEAD after max_attempts; a Super Admin can send them again.
 */
export async function processPwaCallbacks(now = new Date(), limit = 20, fetchImpl: typeof fetch = fetch): Promise<{ sent: number; failed: number; skipped?: string }> {
  const cfg = config.payWithAraf;
  if (!cfg.enabled || cfg.secret.length < 32 || !cfg.callbackUrl) return { sent: 0, failed: 0, skipped: "DISABLED" };
  const url = new URL(cfg.callbackUrl);
  if (config.isProduction && url.protocol !== "https:") return { sent: 0, failed: 0, skipped: "INSECURE_URL" };

  await db.query(
    "UPDATE pwa_callback_outbox SET status = 'FAILED', last_error = coalesce(last_error, 'worker interrupted') WHERE status = 'SENDING' AND locked_at < $1",
    [new Date(now.getTime() - 10 * 60_000)],
  );
  const claimed = await withTx(async (tx) => {
    const r = await tx.query<CallbackRow>(
      `UPDATE pwa_callback_outbox SET status = 'SENDING', locked_at = $1
        WHERE id IN (SELECT o.id FROM pwa_callback_outbox o
                      WHERE o.status IN ('PENDING','FAILED') AND o.next_attempt_at <= $1
                        AND NOT EXISTS (SELECT 1 FROM pwa_callback_outbox e WHERE e.case_id = o.case_id AND e.sequence < o.sequence AND e.status <> 'SENT')
                      ORDER BY o.next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id, case_id, event_id, sequence, body, attempts, max_attempts`,
      [now, limit],
    );
    return r.rows;
  });

  let sent = 0;
  let failed = 0;
  for (const m of claimed) {
    const ctx = systemCtx(now);
    try {
      const t = Math.floor(Date.now() / 1000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          signal: ctrl.signal,
          redirect: "error",
          headers: { "Content-Type": "application/json", "X-ARAF-Timestamp": String(t), "X-ARAF-Signature": signPwa(cfg.secret, t, "POST", url.pathname, m.body) },
          body: m.body,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`Pay with ARAF answered ${res.status}`);
      await withTx(async (tx) => {
        await tx.query("UPDATE pwa_callback_outbox SET status = 'SENT', sent_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = $1", [m.id, now]);
        await audit(tx, ctx, { action: "PWA_CALLBACK_SENT", details: { eventId: m.event_id, sequence: m.sequence } });
      });
      sent++;
    } catch (err) {
      const attempts = m.attempts + 1;
      const dead = attempts >= m.max_attempts;
      const reason = String((err as Error)?.name === "AbortError" ? "timed out" : ((err as Error)?.message ?? err)).slice(0, 300);
      await withTx(async (tx) => {
        await tx.query("UPDATE pwa_callback_outbox SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5 WHERE id = $1", [
          m.id,
          dead ? "DEAD" : "FAILED",
          attempts,
          new Date(now.getTime() + backoffMs(attempts)),
          reason,
        ]);
        await audit(tx, ctx, { action: dead ? "PWA_CALLBACK_DEAD" : "PWA_CALLBACK_FAILED", outcome: "FAILURE", reason, details: { eventId: m.event_id, attempts } });
        if (dead) {
          await notifyRoleHolders(tx, now, ["SUPER_ADMIN"], {
            kind: "PWA_CALLBACK_DEAD",
            title: "Pay with ARAF could not be updated",
            body: `A decision update (${m.event_id}) was not delivered after ${attempts} attempts. Open the case to send it again.`,
            link: `/pay-with-araf/${m.case_id}`,
            dedupeKey: `pwa-dead:${m.id}`,
          });
        }
      });
      failed++;
    }
  }
  return { sent, failed };
}
