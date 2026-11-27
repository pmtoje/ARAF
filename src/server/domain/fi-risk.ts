/**
 * Credit Risk Report (decision support). Turns what Periculum returns, together with ARAF's verified figures, into a
 * risk grade and a set of risk indicators, each with its evidence and source.
 *
 * Only fields in Periculum's published variable definitions are read (behavioralAnalysis, patternAnalysis /
 * transactionPatternAnalysis, confidenceOnParsing, PDF dates). A field Periculum did not return is shown as
 * "not reported", never treated as clean or as zero.
 *
 * The thresholds below are INDICATIVE defaults for review by Credit Risk Management. They are in one place
 * (RISK_THRESHOLDS) so the approved values can replace them without touching the logic. The grade never approves or
 * declines anything: the 30% DSR and the credit decision stay with the approved engine and the human approvers.
 */
import type { FinancialIntelligence } from "./financial-intelligence";
import type { Recommendation } from "./credit-recommendation";
import type { BureauSummary } from "./bureau-check";

export const RISK_VERSION = "araf-credit-risk@1";

export const RISK_THRESHOLDS = {
  status: "Indicative: pending approval by Credit Risk Management",
  dsrWatchShareOfLimit: 0.8, // DSR above 80% of the limit: watch
  inflowVariationWatchBps: 2500, // monthly inflow coefficient of variation 25%
  inflowVariationHighBps: 5000, // 50%
  inflowIrregularityWatchPct: 40,
  lowBalanceDaysWatchPct: 50,
  gamblingRateHighPct: 5,
  parsingConfidenceWatch: 0.9,
  parsingConfidenceHigh: 0.75,
  lendersWatch: 2,
  lendersHigh: 3,
} as const;

export type RiskLevel = "LOW" | "WATCH" | "HIGH" | "NOT_REPORTED";
export type RiskGrade = "LOW" | "MODERATE" | "ELEVATED" | "HIGH";
export type RiskCategory = "AFFORDABILITY" | "CONDUCT" | "STABILITY" | "INTEGRITY" | "EXTERNAL";

export const GRADE_LABELS: Record<RiskGrade, string> = { LOW: "Low risk", MODERATE: "Moderate risk", ELEVATED: "Elevated risk", HIGH: "High risk" };
export const CATEGORY_LABELS: Record<RiskCategory, string> = {
  AFFORDABILITY: "Affordability and debt",
  CONDUCT: "Account conduct",
  STABILITY: "Income stability",
  INTEGRITY: "Statement integrity",
  EXTERNAL: "Bureau and background checks",
};

export interface RiskIndicator {
  key: string;
  category: RiskCategory;
  label: string;
  level: RiskLevel;
  value: string;
  evidence: string;
  source: "Periculum" | "ARAF" | "SeedFi" | "Periculum Blacklist Search";
}

export interface RiskProfile {
  version: string;
  grade: RiskGrade;
  gradeLabel: string;
  score: number;
  headline: string;
  counts: { high: number; watch: number; low: number; notReported: number };
  indicators: RiskIndicator[];
  keyRisks: string[];
  mitigants: string[];
  thresholdsStatus: string;
}

/** Per-statement fields lifted from the stored Periculum analytics (nothing else is kept). */
export interface RiskSignals {
  statement: string;
  bettingTransactions: number | null;
  gamblingStatus: string | null;
  gamblingRatePct: number | null;
  accountSweep: boolean | null;
  inflowIrregularityPct: number | null;
  lowBalanceDaysPct: number | null;
  returnedCheques: number | null;
  missingTransactions: number | null;
  parsingConfidence: number | null;
  pdfEditedAfterCreation: boolean | null;
  loanToInflowPct: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const yes = (v: unknown): boolean | null => (v === null || v === undefined || v === "" ? null : v === true || /^(yes|true|y)$/i.test(String(v).trim()));
/** A documented "rate": fractions (0–1) are shown as percentages; values above 1 are already percentages. */
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n <= 1 ? Math.round(n * 10000) / 100 : Math.round(n * 100) / 100;
};

export function extractRiskSignals(statement: string, a: Record<string, unknown> | null): RiskSignals {
  const ba = (a?.behavioralAnalysis ?? {}) as Record<string, unknown>;
  const pa = (a?.transactionPatternAnalysis ?? a?.patternAnalysis ?? {}) as Record<string, unknown>;
  const created = typeof a?.pdfCreatedDate === "string" ? Date.parse(a.pdfCreatedDate as string) : NaN;
  const modified = typeof a?.pdfModifiedDate === "string" ? Date.parse(a.pdfModifiedDate as string) : NaN;
  return {
    statement,
    bettingTransactions: num(ba.numberOfBettingTransactions),
    gamblingStatus: typeof ba.gamblingStatus === "string" ? ba.gamblingStatus : null,
    gamblingRatePct: pct(ba.gamblingRate),
    accountSweep: yes(ba.accountSweep),
    inflowIrregularityPct: num(ba.percentOfInflowIrregularity),
    lowBalanceDaysPct: num(pa.percentNumberOfDaysBalanceWasLessThan10ThousandNaira),
    returnedCheques: num(pa.returnCheque),
    missingTransactions: num(pa.missingTransactions),
    parsingConfidence: num(a?.confidenceOnParsing),
    // More than an hour between creation and last modification of the PDF.
    pdfEditedAfterCreation: Number.isFinite(created) && Number.isFinite(modified) ? modified - created > 3_600_000 : null,
    loanToInflowPct: pct(ba.loanToInflowRate),
  };
}

const naira = (k: number | null | undefined) => (k === null || k === undefined ? "—" : `₦${(k / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`);

/** Pure: same inputs, same profile. */
export function assessRisk(p: {
  intelligence: FinancialIntelligence | null;
  recommendation: Recommendation | null;
  signals: RiskSignals[];
  bureau: { label: string; summary: BureauSummary | null; status: string }[];
  /** Statements Periculum flagged as possibly altered (excluded from the figures). */
  altered?: string[];
}): RiskProfile {
  const T = RISK_THRESHOLDS;
  const fi = p.intelligence;
  const r = p.recommendation;
  const out: RiskIndicator[] = [];
  const add = (i: RiskIndicator) => out.push(i);
  const S = p.signals;
  const reported = <K extends keyof RiskSignals>(k: K) => S.filter((s) => s[k] !== null);
  const list = (xs: RiskSignals[]) => xs.map((x) => x.statement).join(", ");

  // ---- affordability and debt
  if (r?.dsr.percent && r.dsr.thresholdPercent) {
    const d = Number(r.dsr.percent);
    const lim = Number(r.dsr.thresholdPercent);
    add({
      key: "DSR",
      category: "AFFORDABILITY",
      label: "Debt service ratio",
      level: r.dsr.pass === false ? "HIGH" : d > lim * T.dsrWatchShareOfLimit ? "WATCH" : "LOW",
      value: `${d.toFixed(2)}% of ${lim}%`,
      evidence: `Proposed ${naira(r.proposedMonthlyKobo)} a month plus existing ${naira(r.obligations.usedMonthlyKobo)} against ${r.income.basis.toLowerCase()} of ${naira(r.income.monthlyKobo)}.`,
      source: "ARAF",
    });
  } else add({ key: "DSR", category: "AFFORDABILITY", label: "Debt service ratio", level: "HIGH", value: "Not calculated", evidence: "Income could not be established from the statements.", source: "ARAF" });
  if (fi) {
    const lenders = fi.obligations.lenders.length;
    add({
      key: "LENDERS",
      category: "AFFORDABILITY",
      label: "Other lenders being repaid",
      level: lenders >= T.lendersHigh ? "HIGH" : lenders >= T.lendersWatch ? "WATCH" : "LOW",
      value: lenders ? `${lenders} lender${lenders === 1 ? "" : "s"}` : "None seen",
      evidence: lenders ? `Repayments of ${naira(fi.obligations.detectedMonthlyKobo)} a month to ${fi.obligations.lenders.join(", ")}.` : "No loan repayments identified in the statements.",
      source: "Periculum",
    });
    add({
      key: "LOAN_PROCEEDS",
      category: "AFFORDABILITY",
      label: "New loans received in the period",
      level: fi.totals.loanProceedsKobo > 0 ? "WATCH" : "LOW",
      value: fi.totals.loanProceedsKobo > 0 ? naira(fi.totals.loanProceedsKobo) : "None",
      evidence: fi.totals.loanProceedsKobo > 0 ? "Loan disbursements were credited; they are excluded from income." : "No loan disbursements identified.",
      source: "Periculum",
    });
  }
  const lti = reported("loanToInflowPct");
  if (lti.length) {
    const max = Math.max(...lti.map((s) => s.loanToInflowPct!));
    add({ key: "LOAN_TO_INFLOW", category: "AFFORDABILITY", label: "Loans as a share of inflow", level: max >= 30 ? "HIGH" : max >= 10 ? "WATCH" : "LOW", value: `${max.toFixed(1)}%`, evidence: "Highest loanToInflowRate across the statements.", source: "Periculum" });
  }

  // ---- account conduct
  const bet = reported("bettingTransactions");
  const gr = reported("gamblingRatePct");
  if (bet.length || gr.length) {
    const n = bet.reduce((t, s) => t + (s.bettingTransactions ?? 0), 0);
    const rate = gr.length ? Math.max(...gr.map((s) => s.gamblingRatePct!)) : 0;
    const flagged = S.some((s) => s.gamblingStatus && /yes|true|gambl/i.test(s.gamblingStatus));
    add({
      key: "GAMBLING",
      category: "CONDUCT",
      label: "Gambling and betting",
      level: rate >= T.gamblingRateHighPct ? "HIGH" : n > 0 || rate > 0 || flagged ? "WATCH" : "LOW",
      value: n || rate ? `${n} transaction${n === 1 ? "" : "s"}${rate ? ` · rate ${rate.toFixed(1)}%` : ""}` : "None seen",
      evidence: n || rate ? `Betting activity reported on ${list(S.filter((s) => (s.bettingTransactions ?? 0) > 0 || (s.gamblingRatePct ?? 0) > 0)) || "the statements"}.` : "No betting transactions reported.",
      source: "Periculum",
    });
  } else add({ key: "GAMBLING", category: "CONDUCT", label: "Gambling and betting", level: "NOT_REPORTED", value: "Not reported", evidence: "Periculum did not return gambling fields.", source: "Periculum" });
  const rc = reported("returnedCheques");
  if (rc.length) {
    const n = rc.reduce((t, s) => t + (s.returnedCheques ?? 0), 0);
    add({ key: "RETURNED_CHEQUES", category: "CONDUCT", label: "Returned cheques", level: n > 0 ? "HIGH" : "LOW", value: String(n), evidence: n ? `Returned cheques on ${list(rc.filter((s) => (s.returnedCheques ?? 0) > 0))}.` : "No returned cheques reported.", source: "Periculum" });
  } else add({ key: "RETURNED_CHEQUES", category: "CONDUCT", label: "Returned cheques", level: "NOT_REPORTED", value: "Not reported", evidence: "Periculum did not return this field.", source: "Periculum" });
  const sw = reported("accountSweep");
  if (sw.length) {
    const hit = sw.filter((s) => s.accountSweep);
    add({ key: "SWEEP", category: "CONDUCT", label: "Account sweeping / recycling of funds", level: hit.length ? "WATCH" : "LOW", value: hit.length ? "Seen" : "Not seen", evidence: hit.length ? `Funds appear to be recycled on ${list(hit)}; turnover may overstate real activity.` : "No sweeping pattern reported.", source: "Periculum" });
  }
  const lb = reported("lowBalanceDaysPct");
  if (lb.length) {
    const max = Math.max(...lb.map((s) => s.lowBalanceDaysPct!));
    add({ key: "LOW_BALANCE", category: "CONDUCT", label: "Days with balance under ₦10,000", level: max > T.lowBalanceDaysWatchPct ? "WATCH" : "LOW", value: `${max.toFixed(0)}% of days`, evidence: "Highest share across the statements.", source: "Periculum" });
  }
  if (fi && fi.monthly.netCashFlowKobo !== null)
    add({
      key: "NET_CASH",
      category: "CONDUCT",
      label: "Average monthly net cash flow",
      level: fi.monthly.netCashFlowKobo < 0 ? "HIGH" : "LOW",
      value: naira(fi.monthly.netCashFlowKobo),
      evidence: fi.monthly.netCashFlowKobo < 0 ? "Outflows exceed inflows on average." : "Inflows exceed outflows on average.",
      source: "ARAF",
    });

  // ---- income stability
  if (fi) {
    const v = fi.monthly.inflowVariationBps;
    if (v !== null)
      add({
        key: "VOLATILITY",
        category: "STABILITY",
        label: "Monthly inflow volatility",
        level: v >= T.inflowVariationHighBps ? "HIGH" : v >= T.inflowVariationWatchBps ? "WATCH" : "LOW",
        value: `${(v / 100).toFixed(1)}%`,
        evidence: `Lowest month ${naira(fi.monthly.lowestInflowKobo)}, highest ${naira(fi.monthly.highestInflowKobo)} (coefficient of variation).`,
        source: "ARAF",
      });
    const irr = reported("inflowIrregularityPct");
    if (irr.length) {
      const max = Math.max(...irr.map((s) => s.inflowIrregularityPct!));
      add({ key: "IRREGULARITY", category: "STABILITY", label: "Irregular inflows", level: max > T.inflowIrregularityWatchPct ? "WATCH" : "LOW", value: `${max.toFixed(0)}%`, evidence: "Highest percentOfInflowIrregularity across the statements.", source: "Periculum" });
    }
    if (fi.customerType === "SALARIED")
      add({
        key: "SALARY",
        category: "STABILITY",
        label: "Salary regularity",
        level: !fi.salary.detected ? "HIGH" : fi.salary.missedMonths.length ? "WATCH" : "LOW",
        value: fi.salary.detected ? `${fi.salary.monthsWithSalary} of ${fi.assessmentMonths.length} months` : "No salary seen",
        evidence: fi.salary.detected ? `${fi.salary.payers.join(", ") || "Employer"}${fi.salary.missedMonths.length ? `; missed ${fi.salary.missedMonths.join(", ")}` : "; paid every month"}.` : "No salary credits identified.",
        source: "Periculum",
      });
    add({
      key: "COVERAGE",
      category: "STABILITY",
      label: "Statement coverage",
      level: fi.exceptions.some((e) => e.type === "INSUFFICIENT_COVERAGE" || e.type === "SALARY_HISTORY_SHORT") ? "WATCH" : "LOW",
      value: `${fi.assessmentMonths.length} complete month${fi.assessmentMonths.length === 1 ? "" : "s"}`,
      evidence: fi.assessmentMonths.length ? `${fi.assessmentMonths[0]} to ${fi.assessmentMonths.at(-1)}.` : "No complete month.",
      source: "ARAF",
    });
  }

  // ---- statement integrity
  if (fi) {
    const mism = fi.accounts.filter((a) => a.ownership === "MISMATCH");
    const unv = fi.accounts.filter((a) => a.ownership === "UNVERIFIED");
    add({
      key: "OWNERSHIP",
      category: "INTEGRITY",
      label: "Account ownership",
      level: mism.length ? "HIGH" : unv.length ? "WATCH" : "LOW",
      value: mism.length ? "Name mismatch" : unv.length ? "Not confirmed" : "Matches the applicant",
      evidence: fi.accounts.map((a) => `${a.bankName ?? "Bank"} ${a.accountNumberMasked ?? ""}: ${a.accountName ?? "no name"}`).join("; "),
      source: "ARAF",
    });
  }
  if (p.altered?.length) add({ key: "ALTERED", category: "INTEGRITY", label: "Possible alteration flagged by Periculum", level: "HIGH", value: `${p.altered.length} file${p.altered.length === 1 ? "" : "s"}`, evidence: `${p.altered.join(", ")} excluded until verified with the issuing bank.`, source: "Periculum" });
  const ed = reported("pdfEditedAfterCreation");
  if (ed.length) {
    const hit = ed.filter((s) => s.pdfEditedAfterCreation);
    add({ key: "PDF_EDITED", category: "INTEGRITY", label: "PDF modified after it was created", level: hit.length ? "HIGH" : "LOW", value: hit.length ? `${hit.length} file${hit.length === 1 ? "" : "s"}` : "No", evidence: hit.length ? `Check ${list(hit)} with the issuing bank.` : "Creation and modification dates match.", source: "Periculum" });
  }
  const pc = reported("parsingConfidence");
  if (pc.length) {
    const min = Math.min(...pc.map((s) => s.parsingConfidence!));
    add({ key: "PARSING", category: "INTEGRITY", label: "Reading confidence", level: min < T.parsingConfidenceHigh ? "HIGH" : min < T.parsingConfidenceWatch ? "WATCH" : "LOW", value: `${Math.round(min * 100)}%`, evidence: "Lowest confidenceOnParsing across the statements.", source: "Periculum" });
  }
  const mt = reported("missingTransactions");
  if (mt.length) {
    const n = mt.reduce((t, s) => t + (s.missingTransactions ?? 0), 0);
    add({ key: "MISSING", category: "INTEGRITY", label: "Missing transactions", level: n > 0 ? "WATCH" : "LOW", value: String(n), evidence: n ? `Gaps reported on ${list(mt.filter((s) => (s.missingTransactions ?? 0) > 0))}.` : "No gaps reported.", source: "Periculum" });
  }

  // ---- bureau and background
  if (r?.seedfi)
    add({
      key: "SEEDFI",
      category: "EXTERNAL",
      label: "SeedFi background check",
      level: /fail/i.test(r.seedfi.outcome ?? "") ? "HIGH" : /pass/i.test(r.seedfi.outcome ?? "") ? "LOW" : "WATCH",
      value: `${r.seedfi.outcome ?? "—"}${r.seedfi.score !== null ? ` · score ${r.seedfi.score}` : ""}`,
      evidence: "Latest SeedFi result on the application.",
      source: "SeedFi",
    });
  for (const b of p.bureau) {
    if (b.status !== "COMPLETED" || !b.summary) continue;
    const d = b.summary.totalDelinquent ?? 0;
    add({ key: `BUREAU_${b.label}`, category: "EXTERNAL", label: `Credit bureau: ${b.label}`, level: d > 0 ? "HIGH" : "LOW", value: d ? `${d} delinquent facilit${d === 1 ? "y" : "ies"}` : "No delinquency", evidence: `Reported ${b.summary.reportDate ?? "date not stated"}.`, source: "Periculum Blacklist Search" });
  }

  // ---- grade
  const high = out.filter((i) => i.level === "HIGH");
  const watch = out.filter((i) => i.level === "WATCH");
  const score = high.length * 3 + watch.length;
  const criticalIntegrity = high.some((i) => i.category === "INTEGRITY" || i.key === "RETURNED_CHEQUES" || i.key.startsWith("BUREAU_"));
  const grade: RiskGrade = criticalIntegrity || score >= 9 ? "HIGH" : score >= 5 ? "ELEVATED" : score >= 2 ? "MODERATE" : "LOW";
  const keyRisks = [...high, ...watch].slice(0, 6).map((i) => `${i.label}: ${i.value}. ${i.evidence}`);
  const mitigants = out
    .filter((i) => i.level === "LOW" && ["DSR", "VOLATILITY", "SALARY", "OWNERSHIP", "RETURNED_CHEQUES", "GAMBLING", "NET_CASH", "SEEDFI"].includes(i.key))
    .slice(0, 5)
    .map((i) => `${i.label}: ${i.value}.`);
  const headline =
    grade === "LOW"
      ? "No material risk signals in the statements analysed."
      : `${high.length} high and ${watch.length} watch signal${high.length + watch.length === 1 ? "" : "s"}${high.length ? `, led by ${high[0].label.toLowerCase()}` : ""}.`;
  return {
    version: RISK_VERSION,
    grade,
    gradeLabel: GRADE_LABELS[grade],
    score,
    headline,
    counts: { high: high.length, watch: watch.length, low: out.filter((i) => i.level === "LOW").length, notReported: out.filter((i) => i.level === "NOT_REPORTED").length },
    indicators: out,
    keyRisks,
    mitigants,
    thresholdsStatus: T.status,
  };
}

/** Builds the profile from what ARAF has stored (decrypted analytics, saved figures, bureau results). No vendor call. */
export async function riskFor(q: import("../db").Db, analysisId: string): Promise<RiskProfile | null> {
  const { statementPayload, analysisStatements } = await import("./statement-analysis");
  const { bureauChecksFor } = await import("./bureau-check");
  const row = (await q.query<{ result: { intelligence?: FinancialIntelligence; recommendation?: Recommendation } | null }>("SELECT result FROM fi_analyses WHERE id = $1", [analysisId])).rows[0];
  if (!row) return null;
  const st = await analysisStatements(q, analysisId);
  const signals: RiskSignals[] = [];
  for (const s of st.filter((x) => x.status === "PROCESSED" || x.status === "REUSED")) {
    signals.push(extractRiskSignals(s.filename, await statementPayload<Record<string, unknown>>(q, s.id, "ANALYTICS").catch(() => null)));
  }
  const bureau = (await bureauChecksFor(q, analysisId)).map((b) => ({ label: b.subject_label, summary: b.summary, status: b.status }));
  return assessRisk({
    intelligence: row.result?.intelligence ?? null,
    recommendation: row.result?.recommendation ?? null,
    signals,
    bureau,
    altered: st.filter((x) => x.error_category === "ALTERED").map((x) => x.filename),
  });
}

/** Saved with the analysis when it settles (fi_analyses.result.risk), for the record. */
export async function storeRisk(q: import("../db").Db, analysisId: string) {
  const r = await riskFor(q, analysisId);
  if (r) await q.query("UPDATE fi_analyses SET result = jsonb_set(coalesce(result, '{}'::jsonb), '{risk}', $2::jsonb) WHERE id = $1", [analysisId, JSON.stringify(r)]);
  return r;
}
