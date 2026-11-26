import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, Tx } from "../db";
import { maybeOne, one, withTx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { encryptField, sha256Hex } from "../crypto";
import { notifyRoleHolders } from "../domain/notifications";
import { nextRef } from "../altphones/core";
import { PWA_OPERATOR_ROLES } from "./roles";
import { enqueueCallback, recordCaseEvent, type PwaCase } from "./cases";

/** Amounts arrive as integer-kobo strings (bigint-safe); null where Pay with ARAF has no value. */
const kobo = z.union([z.string().regex(/^\d{1,15}$/), z.number().int().nonnegative()]).transform((v) => String(v));
const optKobo = kobo.nullable().optional();

/**
 * The parts of a Pay with ARAF submission that ARAF reads into columns. The whole submission (including the
 * checks — SeedFi, Periculum, affordability — and the schedule) is stored encrypted and shown to reviewers.
 */
export const submissionSchema = z
  .object({
    application_reference: z.string().min(3).max(80),
    partner_id: z.string().min(1).max(80),
    partner_name: z.string().max(200).optional(),
    merchant_order_reference: z.string().min(1).max(120),
    customer: z.object({ first_name: z.string().max(120), last_name: z.string().max(120), verified_bvn: z.string().max(40).optional(), income_profile: z.string().max(40).nullable().optional() }).passthrough(),
    financing: z
      .object({
        purchase_amount_kobo: kobo,
        customer_equity_kobo: optKobo,
        requested_amount_kobo: kobo,
        deferred_sale_price_kobo: optKobo,
        tenor_months: z.number().int().min(1).max(24),
        annual_profit_rate_bps: z.number().int().min(0).max(100_000).optional(),
        schedule: z.array(z.object({ amount_kobo: kobo }).passthrough()).max(60).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const reportSchema = z
  .object({
    eventId: z.string().min(6).max(80),
    arafReference: z.string().min(3).max(80),
    applicationReference: z.string().min(3).max(80),
    type: z.enum([
      "CUSTOMER_INFORMATION_PROVIDED",
      "EQUITY_CONFIRMED",
      "BOOKING_CONFIRMED",
      "BOOKING_FAILED",
      "VENDOR_PAYMENT_INITIATED",
      "VENDOR_PAYMENT_CONFIRMED",
      "VENDOR_PAYMENT_FAILED",
      "VENDOR_PAYMENT_REVERSED",
      "RELEASE_AUTHORIZED",
      "RELEASE_SUSPENDED",
      "GOODS_DISPATCHED",
      "GOODS_DELIVERED",
      "REFUND_INITIATED",
      "REFUND_COMPLETED",
      "APPLICATION_CANCELLED",
    ]),
    sequence: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    data: z.record(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).default({}),
  })
  .strict();

export class IntakeError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new IntakeError(400, "INVALID_JSON");
  }
}

/** Never store identity numbers or one-time codes in operational report data. */
function scrub(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !/bvn|nin|otp|pin|password|account_?number/i.test(k)));
}

/**
 * Receive an application from Pay with ARAF. Idempotent on the Idempotency-Key: a repeat returns the same
 * ARAF reference (200) instead of creating a second case (201).
 */
export async function receiveApplication(ctx: Ctx, rawBody: string, idempotencyKey: string | null): Promise<{ status: 200 | 201; ref: string }> {
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) throw new IntakeError(400, "IDEMPOTENCY_KEY_REQUIRED");
  const parsed = submissionSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) throw new IntakeError(422, "INVALID_SUBMISSION");
  const s = parsed.data;
  const f = s.financing;
  const purchase = BigInt(f.purchase_amount_kobo);
  const equity = BigInt(f.customer_equity_kobo ?? "0");
  const financing = BigInt(f.requested_amount_kobo);
  // Equity is paid to the merchant; only the remainder is financed.
  if (equity + financing !== purchase) throw new IntakeError(422, "AMOUNTS_INCONSISTENT");
  const bvn = s.customer.verified_bvn ?? "";
  const bvnLast4 = /^\d{11}$/.test(bvn) ? bvn.slice(-4) : null;

  return withTx(async (tx) => {
    const existing = await maybeOne<{ ref: string }>(tx, "SELECT ref FROM pwa_cases WHERE idempotency_key = $1", [idempotencyKey]);
    if (existing) return { status: 200 as const, ref: existing.ref };
    // Serialise concurrent first submissions of the same key.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pwa:${idempotencyKey}`]);
    const again = await maybeOne<{ ref: string }>(tx, "SELECT ref FROM pwa_cases WHERE idempotency_key = $1", [idempotencyKey]);
    if (again) return { status: 200 as const, ref: again.ref };

    const ref = await nextRef(tx, "pwa_ref_seq", "PWA", ctx.now);
    const monthly = f.schedule?.[0]?.amount_kobo ?? null;
    const c = await one<PwaCase>(
      tx,
      `INSERT INTO pwa_cases (ref, idempotency_key, pwa_reference, partner_code, partner_name, merchant_order_ref, customer_name, bvn_last4, income_profile,
         purchase_kobo, equity_kobo, financing_kobo, deferred_sale_kobo, monthly_kobo, tenor_months, annual_rate_bps, payload_enc, stage,
         received_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'RECEIVED',$18,$18) RETURNING *`,
      [
        ref,
        idempotencyKey,
        s.application_reference,
        s.partner_id,
        s.partner_name ?? null,
        s.merchant_order_reference,
        `${s.customer.first_name} ${s.customer.last_name}`.trim().slice(0, 240),
        bvnLast4,
        s.customer.income_profile ?? null,
        purchase.toString(),
        equity.toString(),
        financing.toString(),
        f.deferred_sale_price_kobo ?? null,
        monthly,
        f.tenor_months,
        f.annual_profit_rate_bps ?? null,
        encryptField(rawBody),
        ctx.now,
      ],
    );
    await recordCaseEvent(tx, ctx, c, { action: "RECEIVED", from: null, to: "RECEIVED", actorName: "Pay with ARAF", note: null });
    await audit(tx, ctx, {
      action: "PWA_APPLICATION_RECEIVED",
      stage: "RECEIVED",
      details: { ref, pwaReference: s.application_reference, partner: s.partner_id, financingKobo: financing.toString(), payloadSha256: sha256Hex(rawBody) },
    });
    await notifyRoleHolders(tx, ctx.now, PWA_OPERATOR_ROLES, {
      kind: "PWA_RECEIVED",
      title: `Pay with ARAF application ${ref}`,
      body: `${c.customer_name} — ${s.partner_name ?? s.partner_id} order ${s.merchant_order_reference} is waiting for business evaluation.`,
      link: `/pay-with-araf/${c.id}`,
      dedupeKey: `pwa-received:${c.id}`,
    });
    return { status: 201 as const, ref };
  });
}

export async function findByIdempotencyKey(q: Db, key: string): Promise<string | null> {
  return (await maybeOne<{ ref: string }>(q, "SELECT ref FROM pwa_cases WHERE idempotency_key = $1", [key]))?.ref ?? null;
}

/**
 * Record an execution report from Pay with ARAF (booking, vendor payment, release, delivery, refunds).
 * De-duplicated by event id. A CUSTOMER_INFORMATION_PROVIDED report returns a case waiting on the customer
 * to the stage it was in, and tells Pay with ARAF (INFO_PROVIDED).
 */
export async function receiveReport(ctx: Ctx, rawBody: string): Promise<{ eventReference: string }> {
  const parsed = reportSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) throw new IntakeError(422, "INVALID_REPORT");
  const r = parsed.data;
  return withTx(async (tx) => {
    const c = await maybeOne<PwaCase>(tx, "SELECT * FROM pwa_cases WHERE ref = $1 FOR UPDATE", [r.arafReference]);
    if (!c) throw new IntakeError(404, "UNKNOWN_REFERENCE");
    if (c.pwa_reference !== r.applicationReference) throw new IntakeError(422, "REFERENCE_MISMATCH");
    const dup = await maybeOne<{ id: string }>(tx, "SELECT id FROM pwa_execution_reports WHERE event_id = $1", [r.eventId]);
    if (dup) return { eventReference: dup.id };
    const data = scrub(r.data);
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO pwa_execution_reports (event_id, case_id, type, sequence, occurred_at, data, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [r.eventId, c.id, r.type, r.sequence, new Date(r.occurredAt), JSON.stringify(data), ctx.now],
    );
    if (r.type === "CUSTOMER_INFORMATION_PROVIDED") {
      if (c.stage === "INFO_REQUESTED") await resumeAfterInfo(tx, ctx, c, typeof data.note === "string" ? data.note : null);
    } else {
      await tx.query("UPDATE pwa_cases SET execution_status = $2, updated_at = $3 WHERE id = $1", [c.id, r.type, ctx.now]);
    }
    await audit(tx, ctx, { action: "PWA_REPORT_RECEIVED", stage: c.stage, details: { ref: c.ref, type: r.type, eventId: r.eventId } });
    return { eventReference: row.id };
  });
}

async function resumeAfterInfo(tx: Tx, ctx: Ctx, c: PwaCase, note: string | null) {
  const back = c.stage_before_info ?? "BUSINESS_EVALUATION";
  const u = await one<PwaCase>(
    tx,
    "UPDATE pwa_cases SET stage = $2, stage_before_info = NULL, lock_version = lock_version + 1, updated_at = $3 WHERE id = $1 RETURNING *",
    [c.id, back, ctx.now],
  );
  await recordCaseEvent(tx, ctx, u, { action: "CUSTOMER_INFORMATION_PROVIDED", from: "INFO_REQUESTED", to: back, actorName: "Customer (via Pay with ARAF)", note });
  await enqueueCallback(tx, ctx, u, { stage: "INFO_PROVIDED" });
  await notifyRoleHolders(tx, ctx.now, PWA_OPERATOR_ROLES, {
    kind: "PWA_INFO_PROVIDED",
    title: `Customer responded on ${c.ref}`,
    body: "The customer has provided the information requested. The case is back in review.",
    link: `/pay-with-araf/${c.id}`,
    dedupeKey: `pwa-info:${c.id}:${randomUUID()}`,
  });
}
