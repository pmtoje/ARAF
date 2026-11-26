import { randomUUID } from "node:crypto";
import type { Db, Tx } from "../db";
import { db, maybeOne, one, withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { decryptField } from "../crypto";
import { conflict, forbidden, gate, invalid, notFound } from "../errors";
import { holdsRole } from "../domain/access";
import { notifyRoleHolders } from "../domain/notifications";
import type { Role } from "../domain/roles";
import { PWA_APPROVER_ROLES, PWA_OPERATOR_ROLES, PWA_VIEW_ROLES } from "./roles";

export const PWA_STAGES = ["RECEIVED", "BUSINESS_EVALUATION", "CREDIT_REVIEW", "APPROVAL", "INFO_REQUESTED", "APPROVED", "REJECTED"] as const;
export type PwaStage = (typeof PWA_STAGES)[number];

export const PWA_STAGE_LABELS: Record<PwaStage, string> = {
  RECEIVED: "Received",
  BUSINESS_EVALUATION: "Business evaluation",
  CREDIT_REVIEW: "Credit review",
  APPROVAL: "Awaiting approval",
  INFO_REQUESTED: "Waiting on customer",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export interface PwaCase {
  id: string;
  ref: string;
  idempotency_key: string;
  pwa_reference: string;
  partner_code: string;
  partner_name: string | null;
  merchant_order_ref: string;
  customer_name: string;
  bvn_last4: string | null;
  income_profile: string | null;
  purchase_kobo: string;
  equity_kobo: string;
  financing_kobo: string;
  deferred_sale_kobo: string | null;
  monthly_kobo: string | null;
  tenor_months: number | null;
  annual_rate_bps: number | null;
  payload_enc: string;
  stage: PwaStage;
  stage_before_info: PwaStage | null;
  sequence: number;
  recommended_by: string | null;
  decided_by: string | null;
  execution_status: string | null;
  lock_version: number;
  received_at: Date;
  decided_at: Date | null;
  updated_at: Date;
}

/** Callback stages understood by Pay with ARAF (integration contract v1). */
export type CallbackStage = "UNDER_REVIEW" | "INFO_REQUESTED" | "INFO_PROVIDED" | "APPROVED" | "REJECTED";

export const PWA_ACTIONS = ["START_EVALUATION", "COMPLETE_EVALUATION", "REQUEST_INFO", "RECOMMEND_APPROVAL", "RETURN_FOR_CORRECTION", "APPROVE", "REJECT"] as const;
export type PwaAction = (typeof PWA_ACTIONS)[number];

const TRANSITIONS: Record<PwaAction, { from: PwaStage[]; to: PwaStage; approver?: true; callback?: CallbackStage; label: string }> = {
  START_EVALUATION: { from: ["RECEIVED"], to: "BUSINESS_EVALUATION", callback: "UNDER_REVIEW", label: "Start business evaluation" },
  COMPLETE_EVALUATION: { from: ["BUSINESS_EVALUATION"], to: "CREDIT_REVIEW", label: "Complete evaluation — send to credit review" },
  REQUEST_INFO: { from: ["BUSINESS_EVALUATION", "CREDIT_REVIEW"], to: "INFO_REQUESTED", callback: "INFO_REQUESTED", label: "Ask the customer for information" },
  RECOMMEND_APPROVAL: { from: ["CREDIT_REVIEW"], to: "APPROVAL", label: "Recommend approval" },
  RETURN_FOR_CORRECTION: { from: ["APPROVAL"], to: "CREDIT_REVIEW", approver: true, label: "Return to credit review" },
  APPROVE: { from: ["APPROVAL"], to: "APPROVED", approver: true, callback: "APPROVED", label: "Approve financing" },
  REJECT: { from: ["BUSINESS_EVALUATION", "CREDIT_REVIEW", "APPROVAL"], to: "REJECTED", callback: "REJECTED", label: "Reject application" },
};

export function actionLabel(a: PwaAction) {
  return TRANSITIONS[a].label;
}

/** Actions available on a case in its current stage, for a person holding `roles`. */
export function availableActions(c: Pick<PwaCase, "stage" | "recommended_by">, staffId: string, roles: readonly Role[]): PwaAction[] {
  const operator = roles.some((r) => PWA_OPERATOR_ROLES.includes(r));
  const approver = roles.some((r) => PWA_APPROVER_ROLES.includes(r));
  return PWA_ACTIONS.filter((a) => {
    const t = TRANSITIONS[a];
    if (!t.from.includes(c.stage)) return false;
    if (t.approver || (a === "REJECT" && c.stage === "APPROVAL")) return approver && !(a === "APPROVE" && c.recommended_by === staffId);
    return operator;
  });
}

export async function recordCaseEvent(
  q: Db,
  ctx: Ctx,
  c: Pick<PwaCase, "id">,
  e: { action: string; from: string | null; to: string | null; actorName: string; actorRole?: string | null; note: string | null },
) {
  await q.query(
    `INSERT INTO pwa_case_events (case_id, action, from_stage, to_stage, actor_id, actor_name, actor_role, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.id, e.action, e.from, e.to, ctx.actor?.staffId ?? null, e.actorName, e.actorRole ?? null, e.note, ctx.now],
  );
}

/** Queue a signed status callback to Pay with ARAF (delivered by the worker, in sequence order per case). */
export async function enqueueCallback(tx: Tx, ctx: Ctx, c: PwaCase, e: { stage: CallbackStage; decision?: string; note?: string | null; actorName?: string }) {
  const seq = (await one<{ sequence: number }>(tx, "UPDATE pwa_cases SET sequence = sequence + 1 WHERE id = $1 RETURNING sequence", [c.id])).sequence;
  const eventId = `araf-${c.ref}-${seq}-${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({
    event_id: eventId,
    araf_reference: c.ref,
    sequence: seq,
    stage: e.stage,
    ...(e.decision ? { decision: e.decision } : {}),
    ...(e.note ? { note: e.note.slice(0, 1000) } : {}),
    ...(e.actorName ? { actor_name: e.actorName.slice(0, 120) } : {}),
    occurred_at: ctx.now.toISOString(),
  });
  await tx.query(
    `INSERT INTO pwa_callback_outbox (case_id, event_id, sequence, body, next_attempt_at, created_at) VALUES ($1,$2,$3,$4,$5,$5)`,
    [c.id, eventId, seq, body, ctx.now],
  );
}

async function matchingRole(q: Db, staffId: string, roles: readonly Role[]): Promise<Role | null> {
  for (const r of roles) if (await holdsRole(q, staffId, r)) return r;
  return null;
}

/**
 * Move a Pay with ARAF case. Credit officers evaluate, ask for information, recommend and reject; a Credit Lead
 * or the Unit Head approves (never the officer who recommended approval). Optimistic concurrency on lock_version.
 */
export async function actOnCase(ctx: Ctx, input: { caseId: string; action: PwaAction; note: string; lockVersion: number }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const t = TRANSITIONS[input.action];
  if (!t) throw invalid("Unknown action.");
  const note = input.note.trim();
  if (note.length < 3 || note.length > 1000) throw invalid("Add a note of 3 to 1000 characters.", { note: "Required" });

  return withTx(async (tx) => {
    const c = await maybeOne<PwaCase>(tx, "SELECT * FROM pwa_cases WHERE id = $1 FOR UPDATE", [input.caseId]);
    if (!c) throw notFound();
    if (c.lock_version !== input.lockVersion) throw conflict("This case changed while you were viewing it. Reload and try again.");
    if (!t.from.includes(c.stage)) throw gate(`This action is not available while the case is ${PWA_STAGE_LABELS[c.stage].toLowerCase()}.`);
    const needsApprover = t.approver || (input.action === "REJECT" && c.stage === "APPROVAL");
    const role = await matchingRole(tx, actor.staffId, needsApprover ? PWA_APPROVER_ROLES : PWA_OPERATOR_ROLES);
    if (!role) {
      await audit(tx, ctx, { action: "PWA_ACTION_DENIED", outcome: "DENIED", stage: c.stage, reason: input.action, details: { ref: c.ref } });
      throw forbidden();
    }
    // Maker-checker: the approver cannot be the officer who recommended approval.
    if (input.action === "APPROVE" && c.recommended_by === actor.staffId) throw forbidden("You recommended this case, so another approver must decide it.");

    const decided = t.to === "APPROVED" || t.to === "REJECTED";
    const u = await one<PwaCase>(
      tx,
      `UPDATE pwa_cases SET stage = $2, lock_version = lock_version + 1, updated_at = $3,
              stage_before_info = CASE WHEN $2 = 'INFO_REQUESTED' THEN stage ELSE stage_before_info END,
              recommended_by = CASE WHEN $4 THEN $5::uuid WHEN $2 = 'CREDIT_REVIEW' THEN NULL ELSE recommended_by END,
              decided_by = CASE WHEN $6 THEN $5::uuid ELSE decided_by END,
              decided_at = CASE WHEN $6 THEN $3 ELSE decided_at END
        WHERE id = $1 RETURNING *`,
      [c.id, t.to, ctx.now, input.action === "RECOMMEND_APPROVAL", actor.staffId, decided],
    );
    await recordCaseEvent(tx, ctx, u, { action: input.action, from: c.stage, to: t.to, actorName: actor.name, actorRole: role, note });
    if (t.callback) {
      await enqueueCallback(tx, ctx, u, {
        stage: t.callback,
        decision: t.callback === "APPROVED" || t.callback === "REJECTED" ? t.callback : undefined,
        // Only an information request is shown to the customer; other notes stay internal.
        note: t.callback === "INFO_REQUESTED" ? note : undefined,
        actorName: actor.name,
      });
    }
    await audit(tx, ctx, { action: `PWA_${input.action}`, actorRole: role, stage: t.to, reason: note, details: { ref: c.ref, from: c.stage, to: t.to } });
    if (input.action === "RECOMMEND_APPROVAL") {
      await notifyRoleHolders(tx, ctx.now, PWA_APPROVER_ROLES, {
        kind: "PWA_APPROVAL",
        title: `Approve Pay with ARAF ${c.ref}`,
        body: `${c.customer_name} — recommended by ${actor.name}.`,
        link: `/pay-with-araf/${c.id}`,
        dedupeKey: `pwa-approval:${c.id}:${u.lock_version}`,
      });
    }
    return u;
  });
}

export interface PwaListRow extends Pick<PwaCase, "id" | "ref" | "pwa_reference" | "partner_code" | "partner_name" | "customer_name" | "financing_kobo" | "tenor_months" | "stage" | "execution_status" | "received_at" | "updated_at"> {
  callbacks_dead: number;
}

export async function listCases(q: Db, opts: { stage?: string | null } = {}): Promise<PwaListRow[]> {
  const stage = opts.stage && (PWA_STAGES as readonly string[]).includes(opts.stage) ? opts.stage : null;
  return (
    await q.query<PwaListRow>(
      `SELECT c.id, c.ref, c.pwa_reference, c.partner_code, c.partner_name, c.customer_name, c.financing_kobo, c.tenor_months, c.stage, c.execution_status,
              c.received_at, c.updated_at,
              (SELECT count(*)::int FROM pwa_callback_outbox o WHERE o.case_id = c.id AND o.status = 'DEAD') AS callbacks_dead
         FROM pwa_cases c
        WHERE ($1::text IS NULL OR c.stage = $1)
        ORDER BY CASE WHEN c.stage IN ('APPROVED','REJECTED') THEN 1 ELSE 0 END, c.received_at
        LIMIT 500`,
      [stage],
    )
  ).rows;
}

/** A case with its submission, history, execution reports and callback deliveries. Reading it is audited. */
export async function getCase(ctx: Ctx, caseId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(await matchingRole(db, actor.staffId, PWA_VIEW_ROLES))) throw forbidden();
  const c = await maybeOne<PwaCase>(db, "SELECT * FROM pwa_cases WHERE id = $1", [caseId]);
  if (!c) throw notFound();
  const submission = JSON.parse(decryptField(c.payload_enc)) as Record<string, unknown>;
  // Reviewers see the last four digits of the BVN only.
  const customer = (submission.customer ?? {}) as Record<string, unknown>;
  if (customer.verified_bvn) customer.verified_bvn = c.bvn_last4 ? `•••••••${c.bvn_last4}` : "hidden";
  const events = (await db.query("SELECT * FROM pwa_case_events WHERE case_id = $1 ORDER BY id", [c.id])).rows;
  const reports = (await db.query("SELECT * FROM pwa_execution_reports WHERE case_id = $1 ORDER BY sequence, received_at", [c.id])).rows;
  const callbacks = (
    await db.query(
      "SELECT id, event_id, sequence, body::jsonb->>'stage' AS stage, status, attempts, last_error, created_at, sent_at, next_attempt_at FROM pwa_callback_outbox WHERE case_id = $1 ORDER BY sequence",
      [c.id],
    )
  ).rows;
  await audit(db, ctx, { action: "PWA_CASE_VIEWED", stage: c.stage, details: { ref: c.ref } });
  const { payload_enc: _omit, ...summary } = c;
  return { case: summary, submission, events, reports, callbacks };
}

/** Super Admin: send callbacks that ran out of attempts again (e.g. after Pay with ARAF was unreachable). */
export async function retryDeadCallbacks(ctx: Ctx, caseId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(await holdsRole(db, actor.staffId, "SUPER_ADMIN"))) throw forbidden();
  return withTx(async (tx) => {
    const r = await tx.query(
      "UPDATE pwa_callback_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = $2, last_error = NULL WHERE case_id = $1 AND status = 'DEAD'",
      [caseId, ctx.now],
    );
    await audit(tx, ctx, { action: "PWA_CALLBACKS_REQUEUED", details: { caseId, count: r.rowCount ?? 0 } });
    return r.rowCount ?? 0;
  });
}
