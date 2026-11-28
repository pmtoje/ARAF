/**
 * Automated credit recommendation (Phase 4). Decision support only: never approval.
 *
 * One authoritative calculation: the existing affordability engine (computeAffordability) with the product's
 * approved configuration (DSR threshold, income basis, limits, pricing). This module only supplies the inputs
 * from the verified financial intelligence and interprets the result:
 *
 *  - Income basis follows the configured DSR denominator: verified salary, adjusted monthly turnover / net cash
 *    inflow, or verified annual inflow (adjusted monthly inflow × 12). Missing income is never treated as zero:
 *    the outcome is "Insufficient Financial Evidence".
 *  - Existing obligations: the declared obligations and the repayments found in the statements describe the same
 *    debts, so the larger of the two monthly totals is used once (never added together); a material difference is
 *    flagged.
 *  - Indicative maximum eligible financing: the largest principal (in ₦1,000 steps) for which the same engine passes
 *    every rule at the selected tenor and pricing (DSR, limits, turnover cap). The engine applies the most
 *    restrictive configured limit.
 *  - The policy threshold is whatever the approved configuration says. Where a salary or income-based DSR for
 *    Vendor Financing, AltDrive or AltPower is not 30%, the recommendation flags it instead of overriding it.
 *  - Amount or tenor changes are recalculated from the saved assessment without calling Periculum.
 */
import type { Db } from "../db";
import { computeAffordability, rulesSnapshot, type AffordabilityInput, type AffordabilityOutput, type AssessmentRules } from "./affordability";
import { DSR_DENOMINATOR_LABELS, effectiveConfig, profileRules, type DsrDenominator } from "./products";
import { savedIntelligence, type FinancialException, type FinancialIntelligence } from "./financial-intelligence";
import { formatKobo } from "../money";

export const RECOMMENDATION_VERSION = "araf-credit-recommendation@1";
export const APPROVED_DSR_PERCENT = "30";
const DSR_30_PRODUCTS = ["VENDOR_FINANCING", "ALT_DRIVE", "ALT_POWER"];
const INCOME_DENOMINATORS: DsrDenominator[] = ["VERIFIED_MONTHLY_NET_SALARY", "VERIFIED_MONTHLY_GROSS_SALARY", "AVERAGE_MONTHLY_INFLOW_FROM_ANNUAL", "AVERAGE_MONTHLY_NET_CASH_INFLOW"];
const STEP_KOBO = 100_000; // ₦1,000

export type Outcome = "WITHIN_CAPACITY" | "REDUCED_AMOUNT" | "EXCEEDS_DSR" | "INSUFFICIENT_EVIDENCE" | "ADDITIONAL_DOCUMENTATION" | "OWNERSHIP_VERIFICATION" | "REQUIRES_REVIEW" | "UNABLE_TO_ASSESS";

export const OUTCOME_LABELS: Record<Outcome, string> = {
  WITHIN_CAPACITY: "Within Assessed Financing Capacity",
  REDUCED_AMOUNT: "Reduced Financing Amount Recommended",
  EXCEEDS_DSR: "Exceeds Approved DSR Threshold",
  INSUFFICIENT_EVIDENCE: "Insufficient Financial Evidence",
  ADDITIONAL_DOCUMENTATION: "Additional Documentation Required",
  OWNERSHIP_VERIFICATION: "Statement Ownership Requires Verification",
  REQUIRES_REVIEW: "Financial Assessment Requires Review",
  UNABLE_TO_ASSESS: "Unable to Complete Automated Assessment",
};

export interface RecommendationParams {
  intelligence: FinancialIntelligence;
  rules: AssessmentRules;
  applicantType: string;
  requestedPrincipalKobo: number | null;
  tenorMonths: number | null;
  declaredObligations: { lender: string; monthlyRepaymentKobo: number }[];
  assetCostKobo: number | null;
  equityContributionKobo: number | null;
  seedfi: { outcome: string | null; score: number | null } | null;
}

export interface Recommendation {
  version: string;
  outcome: Outcome;
  outcomeLabel: string;
  complete: boolean;
  income: { basis: string; denominator: DsrDenominator | null; monthlyKobo: number | null; annualKobo: number | null };
  obligations: { declaredMonthlyKobo: number; detectedMonthlyKobo: number; usedMonthlyKobo: number; source: "DECLARED" | "STATEMENTS" | "NONE"; reconciliationNote: string | null };
  requested: { principalKobo: number | null; tenorMonths: number | null };
  proposedMonthlyKobo: number | null;
  totalPayableKobo: number | null;
  dsr: { percent: string | null; thresholdPercent: string | null; pass: boolean | null; allowedMonthlyKobo: number | null };
  availableCapacityKobo: number | null;
  maxEligiblePrincipalKobo: number | null;
  differenceKobo: number | null;
  recommendedPrincipalKobo: number | null;
  failingRules: string[];
  blockedReasons: string[];
  conditions: string[];
  policyFlags: FinancialException[];
  commentary: string[];
  engine: Pick<AffordabilityOutput, "engineVersion" | "result" | "formula"> | null;
  seedfi: { outcome: string | null; score: number | null } | null;
}

function incomeFor(fi: FinancialIntelligence, denominator: DsrDenominator | null) {
  switch (denominator) {
    case "VERIFIED_MONTHLY_NET_SALARY":
    case "VERIFIED_MONTHLY_GROSS_SALARY":
      return { basis: "Verified monthly salary", monthly: fi.salary.verifiedMonthlyKobo, annual: null };
    case "AVERAGE_MONTHLY_BUSINESS_TURNOVER":
      return { basis: "Adjusted average monthly turnover", monthly: fi.monthly.adjustedInflowKobo, annual: null };
    case "AVERAGE_MONTHLY_NET_CASH_INFLOW":
      return { basis: "Average monthly net cash inflow", monthly: fi.monthly.netCashFlowKobo !== null && fi.monthly.netCashFlowKobo > 0 ? fi.monthly.netCashFlowKobo : null, annual: null };
    case "AVERAGE_MONTHLY_INFLOW_FROM_ANNUAL": {
      const m = fi.monthly.adjustedInflowKobo;
      return { basis: "Verified annual inflow (adjusted monthly inflow × 12)", monthly: m, annual: m !== null ? m * 12 : null };
    }
    default:
      return { basis: denominator ? DSR_DENOMINATOR_LABELS[denominator] : "Not configured", monthly: null, annual: null };
  }
}

const naira = (k: number | null | undefined) => (k === null || k === undefined ? "—" : formatKobo(k));

export function recommend(p: RecommendationParams): Recommendation {
  const fi = p.intelligence;
  const denom = p.rules.denominator;
  const inc = incomeFor(fi, denom);
  const declared = p.declaredObligations.reduce((t, o) => t + (o.monthlyRepaymentKobo || 0), 0);
  const detected = fi.obligations.detectedMonthlyKobo;
  const used = Math.max(declared, detected);
  const source = used === 0 ? "NONE" : declared >= detected ? "DECLARED" : "STATEMENTS";
  let reconciliationNote: string | null = null;
  if (declared && detected && Math.abs(declared - detected) > Math.max(declared, detected) * 0.1)
    reconciliationNote = `Declared obligations (${naira(declared)}/month) differ from repayments found in the statements (${naira(detected)}/month); the larger is used once.`;
  else if (!declared && detected) reconciliationNote = `Repayments of ${naira(detected)}/month were found in the statements but not declared; they are included.`;

  const policyFlags: FinancialException[] = [];
  if (DSR_30_PRODUCTS.includes(p.rules.productCode) && denom && INCOME_DENOMINATORS.includes(denom) && p.rules.dsrMaxPercent !== APPROVED_DSR_PERCENT)
    policyFlags.push({
      type: "DSR_THRESHOLD_NOT_30",
      severity: "MATERIAL",
      affected: "Credit policy",
      reason: `The configured maximum DSR is ${p.rules.dsrMaxPercent ?? "not set"}%; ARAF's approved threshold for income-based DSR is ${APPROVED_DSR_PERCENT}%.`,
      evidence: `Product configuration v${p.rules.configVersion} (${p.rules.productCode}, ${p.rules.profile}).`,
      impact: "The assessment follows the configured threshold.",
      resolution: "A Product Configuration Approver should approve the 30% threshold in Product Settings.",
    });

  const base = (principal: number | null): AffordabilityInput => ({
    kind: "FINAL",
    applicantType: p.applicantType,
    incomeBasisKobo: inc.monthly,
    annualInflowKobo: inc.annual,
    incomeBasisNote: `${inc.basis} from the automated statement analysis (${fi.assessmentMonths.length} month(s))`,
    statementFrom: fi.assessmentMonths[0] ? `${fi.assessmentMonths[0]}-01` : null,
    statementTo: fi.assessmentMonths.at(-1) ? `${fi.assessmentMonths.at(-1)}-28` : null,
    evidenceDocumentIds: [],
    existingObligations: used
      ? [{ lender: source === "DECLARED" ? "Declared obligations" : "Repayments found in statements", facilityType: "Existing obligations (reconciled)", monthlyRepaymentKobo: used, outstandingKobo: null }]
      : [],
    principalKobo: principal,
    tenorMonths: p.tenorMonths,
    proposedMonthlyObligationKobo: null,
    turnoverForCapKobo: fi.monthly.adjustedInflowKobo !== null ? fi.monthly.adjustedInflowKobo * 12 : null,
    assetCostKobo: p.assetCostKobo,
    equityContributionKobo: p.equityContributionKobo,
    charges: [],
    firstDueDate: null,
  });

  const out = inc.monthly ? computeAffordability(p.rules, base(p.requestedPrincipalKobo)) : null;
  const passes = (principal: number) => {
    const o = computeAffordability(p.rules, base(principal));
    return o.result === "PASS";
  };
  // Largest passing principal (monotonic in principal), in ₦1,000 steps, up to the product maximum.
  let maxEligible: number | null = null;
  if (out && out.result !== "BLOCKED" && p.tenorMonths) {
    const upper = p.rules.maxAmountKobo ?? Math.max(p.requestedPrincipalKobo ?? 0, 1) * 10;
    let lo = 0;
    let hi = Math.floor(upper / STEP_KOBO);
    if (passes(hi * STEP_KOBO)) lo = hi;
    else
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (passes(mid * STEP_KOBO)) lo = mid;
        else hi = mid;
      }
    maxEligible = lo > 0 ? lo * STEP_KOBO : 0;
  }

  const blocking = fi.exceptions.filter((e) => e.severity === "BLOCKING");
  const material = [...fi.exceptions.filter((e) => e.severity === "MATERIAL"), ...policyFlags];
  const failing = out ? out.checks.filter((c) => !c.pass).map((c) => `${c.rule}: ${c.detail}`) : [];
  const dsrFails = !!out?.dsr && !out.dsr.pass;
  const verifiedAccounts = fi.accounts.filter((a) => a.ownership === "VERIFIED").length;
  const requested = p.requestedPrincipalKobo;
  const minAmount = p.rules.minAmountKobo ?? STEP_KOBO;

  let outcome: Outcome;
  if (!fi.statementsAnalysed) outcome = "UNABLE_TO_ASSESS";
  else if (!verifiedAccounts && fi.accounts.length) outcome = "OWNERSHIP_VERIFICATION";
  else if (blocking.some((e) => e.type === "PARTIAL_ANALYSIS" || e.type === "STATEMENT_ALTERED")) outcome = "REQUIRES_REVIEW";
  else if (!inc.monthly) outcome = "INSUFFICIENT_EVIDENCE";
  else if (!out || out.result === "BLOCKED") outcome = "REQUIRES_REVIEW";
  else if (out.result === "PASS") outcome = material.some((e) => ["INSUFFICIENT_COVERAGE", "SALARY_HISTORY_SHORT", "STATEMENT_GAP"].includes(e.type)) ? "ADDITIONAL_DOCUMENTATION" : "WITHIN_CAPACITY";
  else if (dsrFails && maxEligible !== null && maxEligible >= minAmount && failing.every((f) => f.startsWith("DSR within"))) outcome = "REDUCED_AMOUNT";
  else if (dsrFails) outcome = "EXCEEDS_DSR";
  else outcome = "REQUIRES_REVIEW";

  const recommendedPrincipal = outcome === "WITHIN_CAPACITY" || outcome === "ADDITIONAL_DOCUMENTATION" ? requested : outcome === "REDUCED_AMOUNT" ? maxEligible : null;
  const allowed = out?.dsr?.allowedMonthlyKobo ?? (out?.dsr && inc.monthly && p.rules.dsrMaxPercent ? Math.floor((inc.monthly * Number(p.rules.dsrMaxPercent)) / 100) : null);
  const available = allowed !== null && allowed !== undefined ? Math.max(0, allowed - used) : null;

  // ---- commentary, generated from the data
  const c: string[] = [];
  const nStat = fi.statementsAnalysed;
  c.push(
    `${nStat === 1 ? "One statement was" : `${nStat} statements were`} analysed${fi.uniqueAccounts > 1 ? `, representing ${fi.uniqueAccounts} unique bank accounts` : ""}, covering ${fi.assessmentMonths.length} complete month(s)${fi.assessmentMonths.length ? ` (${fi.assessmentMonths[0]} to ${fi.assessmentMonths.at(-1)})` : ""}.`,
  );
  if (fi.totals.internalTransfersKobo || fi.totals.duplicatesExcludedKobo)
    c.push(`Duplicate transactions and verified internal transfers (${naira(fi.totals.internalTransfersKobo)}) were excluded from consolidated financial activity.`);
  if (inc.monthly) c.push(`${inc.basis}: ${naira(inc.monthly)} per month.`);
  if (used) c.push(`Existing monthly obligations of ${naira(used)} are included${reconciliationNote ? ` (${reconciliationNote})` : ""}.`);
  if (out?.dsr) c.push(`With the proposed repayment of ${out.proposedMonthlyDisplay ?? "—"} per month, the calculated DSR is ${out.dsr.percent}% against the approved ${out.dsr.maxPercent}% threshold.`);
  switch (outcome) {
    case "WITHIN_CAPACITY":
      c.push(`The customer's verified financial position supports the requested ${naira(requested)}. This is subject to other applicable credit conditions and does not constitute approval.`);
      break;
    case "ADDITIONAL_DOCUMENTATION":
      c.push(`The requested amount is affordable on the evidence analysed, but the statements do not fully meet the required evidence; additional documentation is required before relying on this conclusion.`);
      break;
    case "REDUCED_AMOUNT":
      c.push(
        `The requested amount exceeds the approved DSR threshold. Based on the verified income and existing obligations, a reduced amount of up to ${naira(maxEligible)} over ${p.tenorMonths} months is recommended.`,
      );
      break;
    case "EXCEEDS_DSR":
      c.push(`The customer's calculated DSR exceeds the approved threshold and no amount within the product's limits is affordable at this tenor.`);
      break;
    case "INSUFFICIENT_EVIDENCE":
      c.push(`The statements provided do not establish ${inc.basis.toLowerCase()}. Additional financial evidence is required before a reliable affordability conclusion can be reached.`);
      break;
    case "OWNERSHIP_VERIFICATION":
      c.push(`None of the statements could be confirmed as the customer's own account, so they cannot support the assessment until ownership is verified.`);
      break;
    case "REQUIRES_REVIEW":
      c.push(
        blocking.some((e) => e.type === "PARTIAL_ANALYSIS")
          ? `${fi.statementsAnalysed} of ${fi.statementsTotal} statements have been processed. The consolidated financial assessment remains incomplete pending the outstanding statement(s).`
          : `The automated assessment needs the analyst's review: ${[...(out?.blockedReasons ?? []), ...blocking.map((e) => e.reason)].join(" ") || failing.join("; ")}`,
      );
      break;
    case "UNABLE_TO_ASSESS":
      c.push("No statement could be analysed, so an automated assessment was not possible.");
      break;
  }
  if (p.seedfi?.outcome) c.push(`SeedFi background check: ${p.seedfi.outcome}${p.seedfi.score !== null ? ` (Seed Score ${p.seedfi.score})` : ""}.`);

  return {
    version: RECOMMENDATION_VERSION,
    outcome,
    outcomeLabel: OUTCOME_LABELS[outcome],
    complete: fi.complete,
    income: { basis: inc.basis, denominator: denom, monthlyKobo: inc.monthly, annualKobo: inc.annual },
    obligations: { declaredMonthlyKobo: declared, detectedMonthlyKobo: detected, usedMonthlyKobo: used, source, reconciliationNote },
    requested: { principalKobo: requested, tenorMonths: p.tenorMonths },
    proposedMonthlyKobo: out?.proposedMonthlyExact ? Math.ceil(Number(out.proposedMonthlyExact.n) / Number(out.proposedMonthlyExact.d)) : null,
    totalPayableKobo: out?.totalPayableKobo ?? null,
    dsr: { percent: out?.dsr?.percent ?? null, thresholdPercent: p.rules.dsrMaxPercent, pass: out?.dsr ? out.dsr.pass : null, allowedMonthlyKobo: allowed ?? null },
    availableCapacityKobo: available,
    maxEligiblePrincipalKobo: maxEligible,
    differenceKobo: maxEligible !== null && requested !== null ? maxEligible - requested : null,
    recommendedPrincipalKobo: recommendedPrincipal,
    failingRules: failing,
    blockedReasons: out?.blockedReasons ?? [],
    conditions: material.map((e) => `${e.reason} ${e.resolution}`),
    policyFlags,
    commentary: c,
    engine: out ? { engineVersion: out.engineVersion, result: out.result, formula: out.formula } : null,
    seedfi: p.seedfi,
  };
}

/** Loads the application, configuration and SeedFi facts for an analysis, optionally with a different amount/tenor. */
async function paramsFor(q: Db, analysisId: string, now: Date, override?: { principalKobo?: number | null; tenorMonths?: number | null }): Promise<RecommendationParams | null> {
  const fi = await savedIntelligence(q, analysisId);
  if (!fi) return null;
  const app = (
    await q.query<{
      id: string;
      product_code: string | null;
      customer_profile: string | null;
      financing_structure: string | null;
      applicant_type: string;
      requested_amount_kobo: string | null;
      data: Record<string, unknown> | null;
    }>(
      `SELECT a.id, a.product_code, a.customer_profile, a.financing_structure, a.applicant_type, a.requested_amount_kobo::text, v.data
         FROM fi_analyses f JOIN applications a ON a.id = f.application_id LEFT JOIN application_versions v ON v.id = a.current_version_id WHERE f.id = $1`,
      [analysisId],
    )
  ).rows[0];
  if (!app?.product_code || !app.customer_profile) return null;
  const cfg = await effectiveConfig(q, app.product_code, now);
  const rules = cfg ? profileRules(cfg.config, app.customer_profile) : null;
  if (!cfg || !rules) return null;
  const d = app.data ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? null : Number(v));
  const seed = (
    await q
      .query<{ outcome: string | null; score: number | null }>("SELECT outcome, score FROM credit_checks WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1", [app.id])
      .catch(() => ({ rows: [] as { outcome: string | null; score: number | null }[] }))
  ).rows[0];
  return {
    intelligence: fi,
    rules: rulesSnapshot({ configId: cfg.id, configVersion: cfg.version, productCode: app.product_code, profile: app.customer_profile, structure: app.financing_structure, rules }),
    applicantType: app.applicant_type,
    requestedPrincipalKobo: override?.principalKobo !== undefined ? override.principalKobo : app.requested_amount_kobo !== null ? Number(app.requested_amount_kobo) : num(d.requestedAmountKobo),
    tenorMonths: override?.tenorMonths !== undefined ? override.tenorMonths : num(d.tenorMonths),
    declaredObligations: Array.isArray(d.existingObligations) ? (d.existingObligations as { lender: string; monthlyRepaymentKobo: number }[]) : [],
    assetCostKobo: num(d.assetCostKobo),
    equityContributionKobo: num(d.equityContributionKobo),
    seedfi: seed ? { outcome: seed.outcome, score: seed.score } : null,
  };
}

/** Builds and saves the recommendation on the analysis (fi_analyses.result.recommendation). */
export async function storeRecommendation(q: Db, analysisId: string, now: Date) {
  const p = await paramsFor(q, analysisId, now);
  if (!p) return null;
  const r = recommend(p);
  await q.query("UPDATE fi_analyses SET result = jsonb_set(coalesce(result, '{}'::jsonb), '{recommendation}', $2::jsonb) WHERE id = $1", [analysisId, JSON.stringify(r)]);
  return r;
}

/** Recalculates for a different amount or tenor from the saved assessment (no Periculum call, nothing saved). */
export async function whatIf(q: Db, analysisId: string, now: Date, change: { principalKobo?: number | null; tenorMonths?: number | null }) {
  const p = await paramsFor(q, analysisId, now, change);
  return p ? recommend(p) : null;
}

export async function savedRecommendation(q: Db, analysisId: string): Promise<Recommendation | null> {
  const r = (await q.query<{ result: { recommendation?: Recommendation } | null }>("SELECT result FROM fi_analyses WHERE id = $1", [analysisId])).rows[0];
  return r?.result?.recommendation ?? null;
}
