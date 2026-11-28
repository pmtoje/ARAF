/**
 * Credit Risk Report (Phase 6, brief §23; presented as a risk report at the bank's request). Generated automatically from the saved analysis when it settles
 * and again when the credit analyst confirms or adjusts it, and stored as an application document
 * (GENERATED_FINANCIAL_REPORT) through the existing generated-document path. Each regeneration is a new document
 * version; earlier versions are kept. The archive and the Legal/Shariah packs take the current version like any
 * other current document. Building the report never calls Periculum. Account numbers are masked.
 */
import type { Db, Tx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { storeGeneratedDocument } from "./documents";
import { analysisStatements, type AnalysisRow } from "./statement-analysis";
import { buildFinancialReportPdf, REPORT_VERSION, type ReportData } from "./fi-report-pdf";
import { riskFor } from "./fi-risk";
import type { FinancialIntelligence } from "./financial-intelligence";
import type { Recommendation } from "./credit-recommendation";
import type { ReviewAdjustment } from "./fi-governance";

export const REPORT_CATEGORY = "GENERATED_FINANCIAL_REPORT";
export { buildFinancialReportPdf, REPORT_VERSION, type ReportData } from "./fi-report-pdf";

const PRODUCT_NAMES: Record<string, string> = { VENDOR_FINANCING: "Vendor Financing", ALT_DRIVE: "AltDrive", ALT_POWER: "AltPower", WAKEEL_BOOST: "WakeelBoost" };

export async function saveFinancialReport(tx: Tx, ctx: Ctx, analysisId: string): Promise<string | null> {
  const a = (await tx.query<AnalysisRow>("SELECT * FROM fi_analyses WHERE id = $1", [analysisId])).rows[0];
  if (!a || ["QUEUED", "PROCESSING"].includes(a.status)) return null;
  const d = await reportData(tx, a, ctx.now);
  const pdf = await buildFinancialReportPdf(d);
  const doc = await storeGeneratedDocument(tx, ctx, {
    appId: a.application_id,
    category: REPORT_CATEGORY,
    filename: `Credit-Risk-Report-${d.ref}-v${a.version}${d.review ? "-reviewed" : ""}.pdf`,
    mime: "application/pdf",
    data: pdf,
    templateId: null,
    templateVersion: null,
    role: ctx.actor?.activeRole ?? "SYSTEM",
    stage: (await tx.query<{ stage: string }>("SELECT stage FROM applications WHERE id = $1", [a.application_id])).rows[0].stage,
    versionId: null,
    meta: { analysisId: a.id, analysisVersion: String(a.version), reportVersion: REPORT_VERSION, source: a.source },
  });
  await tx.query("UPDATE fi_analyses SET report_document_id = $2 WHERE id = $1", [a.id, doc.id]);
  await audit(tx, ctx, {
    action: "FINANCIAL_REPORT_SAVED",
    actorRole: ctx.actor?.activeRole ?? "SYSTEM",
    applicationId: a.application_id,
    documentId: doc.id,
    documentVersion: doc.version,
    details: { analysisId: a.id, analysisVersion: a.version, reviewed: !!d.review, source: a.source },
  });
  return doc.id;
}

async function reportData(q: Db, a: AnalysisRow, now: Date): Promise<ReportData> {
  const app = (
    await q.query<{ ref: string; product_code: string | null; applicant_type: string; data: Record<string, unknown> | null }>(
      "SELECT a.ref, a.product_code, a.applicant_type, v.data FROM applications a LEFT JOIN application_versions v ON v.id = a.current_version_id WHERE a.id = $1",
      [a.application_id],
    )
  ).rows[0];
  const dd = app.data ?? {};
  const s = (k: string) => (typeof dd[k] === "string" && (dd[k] as string).trim() ? (dd[k] as string).trim() : null);
  const customerName = [s("customerName"), s("businessName") ?? s("companyName")].filter(Boolean).join(" trading as ") || "—";
  const res = (a.result ?? {}) as { intelligence?: FinancialIntelligence; recommendation?: Recommendation };
  const rv = (
    await q.query<{ kind: string; full_name: string; actor_role: string; created_at: Date; reason: string | null; adjustments: ReviewAdjustment[] }>(
      "SELECT r.kind, s.full_name, r.actor_role, r.created_at, r.reason, r.adjustments FROM fi_reviews r JOIN staff s ON s.id = r.actor_id WHERE r.analysis_id = $1 ORDER BY r.created_at DESC LIMIT 1",
      [a.id],
    )
  ).rows[0];
  return {
    ref: app.ref,
    customerName,
    customerType: app.applicant_type === "INDIVIDUAL" ? "Individual" : app.applicant_type === "LIMITED" ? "Limited company" : "Enterprise",
    product: PRODUCT_NAMES[app.product_code ?? ""] ?? app.product_code ?? "—",
    daoCode: s("daoCode"),
    risk: await riskFor(q, a.id),
    analysis: a,
    statements: await analysisStatements(q, a.id),
    intelligence: res.intelligence ?? null,
    recommendation: res.recommendation ?? null,
    review: rv ? { kind: rv.kind, actorName: rv.full_name, actorRole: rv.actor_role, at: rv.created_at, reason: rv.reason, adjustments: rv.adjustments } : null,
    generatedAt: now,
  };
}
