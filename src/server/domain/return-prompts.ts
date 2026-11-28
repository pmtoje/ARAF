/**
 * One-time prompt for returned requests. When a request is returned to its initiator for rework, the person holding
 * the open correction task sees a prompt on their next page load: who returned it, from which stage, and why. Closing
 * the prompt records it as seen (corrections.prompt_seen_at), so it appears once per return. Reading never changes
 * anything; only the holder of the task can mark it seen.
 */
import type { Db } from "../db";
import type { Ctx } from "../context";
import { withTx } from "../db";
import { audit } from "../audit";
import { stageLabel, type Stage } from "./stages";

export interface ReturnPrompt {
  correctionId: string;
  applicationId: string;
  ref: string;
  customer: string | null;
  fromStage: string;
  returnedBy: string;
  reason: string;
  returnedAt: Date;
}

export async function pendingReturnPrompts(q: Db, staffId: string): Promise<ReturnPrompt[]> {
  const rows = (
    await q.query<{ id: string; application_id: string; ref: string; customer_name: string | null; from_stage: string; approval_policy: string | null; full_name: string; reason: string; created_at: Date }>(
      `SELECT c.id, c.application_id, a.ref, a.customer_name, c.from_stage, a.approval_policy, s.full_name, c.reason, c.created_at
         FROM corrections c
         JOIN applications a ON a.id = c.application_id
         JOIN tasks t ON t.application_id = a.id AND t.status = 'OPEN' AND t.stage = 'INITIATOR_CORRECTION'
         JOIN staff s ON s.id = c.requested_by
        WHERE c.to_stage = 'INITIATOR_CORRECTION' AND c.resolved_at IS NULL AND c.prompt_seen_at IS NULL
          AND t.assignee_id = $1
        ORDER BY c.created_at DESC
        LIMIT 10`,
      [staffId],
    )
  ).rows;
  return rows.map((r) => ({
    correctionId: r.id,
    applicationId: r.application_id,
    ref: r.ref,
    customer: r.customer_name,
    fromStage: stageLabel(r.from_stage as Stage, r.approval_policy),
    returnedBy: r.full_name,
    reason: r.reason,
    returnedAt: r.created_at,
  }));
}

/** Marks the prompts as seen. Only returns whose open correction task belongs to this person are touched. */
export async function markReturnPromptsSeen(ctx: Ctx, correctionIds: string[]) {
  const staffId = ctx.actor?.staffId;
  if (!staffId || !correctionIds.length) return 0;
  const ids = correctionIds.filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 20);
  if (!ids.length) return 0;
  return withTx(async (tx) => {
    const done = (
      await tx.query<{ id: string; application_id: string }>(
        `UPDATE corrections c SET prompt_seen_at = $3
           FROM tasks t
          WHERE c.id = ANY($1::uuid[]) AND c.prompt_seen_at IS NULL
            AND t.application_id = c.application_id AND t.status = 'OPEN' AND t.stage = 'INITIATOR_CORRECTION' AND t.assignee_id = $2
          RETURNING c.id, c.application_id`,
        [ids, staffId, ctx.now],
      )
    ).rows;
    for (const d of done) await audit(tx, ctx, { action: "RETURN_PROMPT_SEEN", applicationId: d.application_id, details: { correctionId: d.id } });
    return done.length;
  });
}
