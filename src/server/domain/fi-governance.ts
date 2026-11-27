/**
 * Financial assessment governance (Phase 6).
 *
 *  statementSetHash / analysisFreshness  an analysis is current only while the application's clean bank statements
 *                                        are exactly the set it analysed; otherwise it "requires refresh".
 *  assessmentGate                        backend gate on credit approval: where the product requires Automatic
 *                                        Statement Analysis, approval needs a current completed analysis or an
 *                                        approved Manual Financial Assessment exception. Marks the analysis relied on.
 *  recordAnalystReview                   the credit analyst's confirmation or adjustment of the automated figures,
 *                                        recorded with the final assessment. Originals stay on the analysis; adjusted
 *                                        values need a reason (enforced here, not only in the browser).
 */
import { createHash } from "node:crypto";
import type { Db, Tx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { gate, invalid } from "../errors";
import { formatKobo } from "../money";
import type { AffordabilityInput } from "./affordability";
import type { ProfileRules } from "./products";
import { currentAnalysis, type AnalysisRow } from "./statement-analysis";
import type { Recommendation } from "./credit-recommendation";

/** Same definition as the analysis' statement_set_sha256: SHA-256 of the sorted, de-duplicated file hashes. */
export async function statementSetHash(q: Db, appId: string): Promise<string | null> {
  const rows = (
    await q.query<{ sha256: string }>(
      `SELECT sha256 FROM documents WHERE application_id = $1 AND category = 'BANK_STATEMENT' AND superseded_at IS NULL AND scan_status = 'CLEAN' AND purged_at IS NULL`,
      [appId],
    )
  ).rows;
  if (!rows.length) return null;
  return createHash("sha256")
    .update([...new Set(rows.map((r) => r.sha256))].sort().join("\n"))
    .digest("hex");
}

export interface Freshness {
  current: boolean;
  /** Why the analysis can no longer be relied on (statements added, replaced or removed). */
  reason: string | null;
}

export async function analysisFreshness(q: Db, a: Pick<AnalysisRow, "application_id" | "statement_set_sha256">): Promise<Freshness> {
  const now = await statementSetHash(q, a.application_id);
  if (now === a.statement_set_sha256) return { current: true, reason: null };
  return {
    current: false,
    reason: now === null ? "The bank statements it analysed are no longer on the application." : "Bank statements were added, replaced or removed after this analysis. Run the analysis again; processed statements are reused.",
  };
}

/** The analysis that can be relied on now (completed and current), or null. */
export async function reliableAnalysis(q: Db, appId: string): Promise<AnalysisRow | null> {
  const a = await currentAnalysis(q, appId);
  if (!a || a.status !== "COMPLETED") return null;
  return (await analysisFreshness(q, a)).current ? a : null;
}

export async function approvedManualException(q: Db, appId: string) {
  return (
    (
      await q.query<{ id: string; decided_at: Date; reason: string }>(
        "SELECT id, decided_at, reason FROM policy_exceptions WHERE application_id = $1 AND type = 'MANUAL_ASSESSMENT' AND status = 'APPROVED' ORDER BY decided_at DESC LIMIT 1",
        [appId],
      )
    ).rows[0] ?? null
  );
}

export type AssessmentBasis = "AUTOMATED" | "MANUAL" | "NOT_REQUIRED";

/**
 * Credit approval gate. Called inside the approval transaction (workflow engine), so hiding a button is never
 * the control. Records which analysis the decision relied on.
 */
export async function assessmentGate(tx: Tx, appId: string, rules: ProfileRules | null, taskId: string, now: Date): Promise<{ basis: AssessmentBasis; analysisId: string | null }> {
  const a = await reliableAnalysis(tx, appId);
  if (a) {
    await tx.query("UPDATE fi_analyses SET relied_on_at = coalesce(relied_on_at, $2), relied_on_task_id = coalesce(relied_on_task_id, $3) WHERE id = $1", [a.id, now, taskId]);
    return { basis: "AUTOMATED", analysisId: a.id };
  }
  if (!rules?.statementAnalysis?.required) return { basis: "NOT_REQUIRED", analysisId: null };
  if (await approvedManualException(tx, appId)) return { basis: "MANUAL", analysisId: null };
  const latest = await currentAnalysis(tx, appId);
  const why = !latest
    ? "Automatic Statement Analysis has not been run."
    : latest.status !== "COMPLETED"
      ? `The latest analysis is ${latest.status.toLowerCase().replace(/_/g, " ")}.`
      : "The statements changed after the latest analysis.";
  throw gate(`A current financial assessment is required for this product before credit approval. ${why} Run Automatic Statement Analysis, or request a Manual Financial Assessment exception if Periculum cannot be used.`);
}

export interface ReviewAdjustment {
  field: "INCOME" | "ANNUAL_INFLOW" | "OBLIGATIONS" | "PRINCIPAL" | "TENOR";
  label: string;
  original: number | null;
  adjusted: number | null;
}

/** Compare the analyst's final inputs with the analysis' verified figures. Pure. */
export function compareWithVerified(r: Recommendation, input: Pick<AffordabilityInput, "incomeBasisKobo" | "annualInflowKobo" | "existingObligations" | "principalKobo" | "tenorMonths">): { verified: ReviewAdjustment[]; terms: ReviewAdjustment[] } {
  const verified: ReviewAdjustment[] = [];
  const terms: ReviewAdjustment[] = [];
  const annual = r.income.annualKobo !== null;
  if (annual) {
    if ((input.annualInflowKobo ?? null) !== r.income.annualKobo) verified.push({ field: "ANNUAL_INFLOW", label: "Verified annual inflow", original: r.income.annualKobo, adjusted: input.annualInflowKobo ?? null });
  } else if ((input.incomeBasisKobo ?? null) !== r.income.monthlyKobo) verified.push({ field: "INCOME", label: r.income.basis, original: r.income.monthlyKobo, adjusted: input.incomeBasisKobo ?? null });
  const obl = (input.existingObligations ?? []).reduce((t, o) => t + o.monthlyRepaymentKobo, 0);
  if (obl !== r.obligations.usedMonthlyKobo) verified.push({ field: "OBLIGATIONS", label: "Existing monthly obligations", original: r.obligations.usedMonthlyKobo, adjusted: obl });
  if ((input.principalKobo ?? null) !== r.requested.principalKobo) terms.push({ field: "PRINCIPAL", label: "Principal", original: r.requested.principalKobo, adjusted: input.principalKobo ?? null });
  if ((input.tenorMonths ?? null) !== r.requested.tenorMonths) terms.push({ field: "TENOR", label: "Tenor (months)", original: r.requested.tenorMonths, adjusted: input.tenorMonths ?? null });
  return { verified, terms };
}

const show = (a: ReviewAdjustment) => (x: number | null) => (x === null ? "—" : a.field === "TENOR" ? `${x} months` : formatKobo(x));

/**
 * Called by recordFinalAssessment inside its transaction. Links the final assessment to the analysis it used and
 * keeps the adjustment history. Returns null when there is no automated or manual basis to record.
 */
export async function recordAnalystReview(
  tx: Tx,
  ctx: Ctx,
  p: { appId: string; assessmentId: string; actorRole: string; stage: string; input: AffordabilityInput; verifiedChangeReason?: string | null; note?: string | null },
) {
  const actorId = ctx.actor!.staffId;
  const a = await reliableAnalysis(tx, p.appId);
  const r = a ? ((a.result as { recommendation?: Recommendation } | null)?.recommendation ?? null) : null;
  if (a && r && r.income.monthlyKobo !== null) {
    const { verified, terms } = compareWithVerified(r, p.input);
    const reason = (p.verifiedChangeReason ?? "").trim();
    if (verified.length && reason.length < 10)
      throw invalid("Explain why the verified figures were changed.", {
        verifiedChangeReason: `You changed ${verified.map((v) => v.label.toLowerCase()).join(" and ")} from Automatic Statement Analysis v${a.version}. Give the reason and the evidence relied on (at least 10 characters).`,
      });
    const kind = verified.length ? "ADJUSTED" : "CONFIRMED";
    const adjustments = [...verified, ...terms];
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO fi_reviews (analysis_id, application_id, assessment_id, kind, adjustments, reason, actor_id, actor_role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.id, p.appId, p.assessmentId, kind, JSON.stringify(adjustments), verified.length ? reason : (p.note ?? "").trim() || null, actorId, p.actorRole, ctx.now],
      )
    ).rows[0].id;
    await audit(tx, ctx, {
      action: kind === "ADJUSTED" ? "FINANCIAL_ASSESSMENT_ADJUSTED" : "FINANCIAL_ASSESSMENT_CONFIRMED",
      actorRole: p.actorRole,
      applicationId: p.appId,
      stage: p.stage,
      reason: verified.length ? reason : null,
      details: {
        analysisId: a.id,
        analysisVersion: a.version,
        reviewId: id,
        assessmentId: p.assessmentId,
        changes: adjustments.map((x) => ({ field: x.label, previous: show(x)(x.original), revised: show(x)(x.adjusted) })),
      },
    });
    return { kind, analysisId: a.id, reviewId: id, adjustments };
  }
  const manual = await approvedManualException(tx, p.appId);
  if (manual) {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO fi_reviews (analysis_id, application_id, assessment_id, kind, adjustments, reason, actor_id, actor_role, created_at) VALUES (NULL,$1,$2,'MANUAL','[]',$3,$4,$5,$6) RETURNING id`,
        [p.appId, p.assessmentId, `Manual Financial Assessment under approved exception: ${manual.reason}`, actorId, p.actorRole, ctx.now],
      )
    ).rows[0].id;
    await audit(tx, ctx, { action: "MANUAL_FINANCIAL_ASSESSMENT_RECORDED", actorRole: p.actorRole, applicationId: p.appId, stage: p.stage, details: { reviewId: id, assessmentId: p.assessmentId, exceptionId: manual.id } });
    return { kind: "MANUAL" as const, analysisId: null, reviewId: id, adjustments: [] };
  }
  return null;
}

export interface ReviewRow {
  id: string;
  analysis_id: string | null;
  kind: "CONFIRMED" | "ADJUSTED" | "MANUAL";
  adjustments: ReviewAdjustment[];
  reason: string | null;
  actor_name: string;
  actor_role: string;
  created_at: Date;
}

export async function reviewsFor(q: Db, appId: string): Promise<ReviewRow[]> {
  return (
    await q.query<ReviewRow>(
      "SELECT r.id, r.analysis_id, r.kind, r.adjustments, r.reason, s.full_name AS actor_name, r.actor_role, r.created_at FROM fi_reviews r JOIN staff s ON s.id = r.actor_id WHERE r.application_id = $1 ORDER BY r.created_at DESC",
      [appId],
    )
  ).rows;
}
