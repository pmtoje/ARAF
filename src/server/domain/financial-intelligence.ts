/**
 * Financial intelligence (Phase 3): turns the stored Periculum results for an analysis into one verified financial
 * picture. Deterministic rules only; every exclusion is kept as evidence. Money is integer kobo.
 *
 * Rules (ARAF brief §9–§12):
 *  - Accounts are identified by bank + account number. Several files of the same account are merged; overlapping
 *    periods do not count a transaction twice (same date, amount, direction and running balance).
 *  - Ownership: the account name must match the applicant (or business / company / director). Unverified or
 *    mismatched accounts never increase assessed capacity; they are flagged for the analyst.
 *  - Internal transfers between the customer's own accounts (debit in one, matching credit in another within
 *    3 days) are removed from both inflows and outflows. A self-transfer credit Periculum identifies whose source
 *    account was not provided is excluded from income (conservative) and flagged.
 *  - Loan proceeds are not income.
 *  - Monthly figures use only complete calendar months the statements fully cover; gaps are reported.
 *  - Salary: Periculum-identified salary credits on verified accounts, minus internal transfers. Averages are over
 *    complete months; missed months and variation are reported. Three months of salary evidence are required.
 *  - Existing obligations: loan repayments Periculum identifies, averaged per complete month.
 *  - A partial analysis is never presented as complete.
 */
import type { Db } from "../db";
import { hmac } from "../crypto";

export const INTELLIGENCE_VERSION = "araf-financial-intelligence@1";
const TRANSFER_WINDOW_DAYS = 3;

// ------------------------------------------------------------------ input shapes (from stored vendor payloads)

export interface RawTransaction {
  date: string;
  amount: number;
  type: string;
  description?: string | null;
  balance?: number | null;
}
export interface DatedAmount {
  date: string;
  amount: number;
  description?: string | null;
}
export interface StatementInput {
  statementId: string;
  filename: string;
  status: "PROCESSED" | "REUSED" | "FAILED" | "REQUIRES_VERIFICATION" | "PENDING" | "OTHER";
  vendorStatus: string | null;
  errorCategory: string | null;
  analytics: Record<string, unknown> | null;
  transactions: RawTransaction[] | null;
}
export interface ApplicantNames {
  /** Individual name(s), business name, company name, directors. */
  names: string[];
}
export interface IntelligenceInput {
  analysisStatus: string;
  customerType: "SALARIED" | "BUSINESS";
  requiredMonths: number;
  applicant: ApplicantNames;
  statements: StatementInput[];
}

// ------------------------------------------------------------------ output shapes

export interface Tx {
  id: string;
  statementId: string;
  accountKey: string;
  date: string;
  month: string;
  amountKobo: number;
  direction: "CREDIT" | "DEBIT";
  description: string;
  balanceKobo: number | null;
}
export type Ownership = "VERIFIED" | "UNVERIFIED" | "MISMATCH";
export interface AccountSummary {
  accountKey: string;
  bankName: string | null;
  accountNumberMasked: string | null;
  accountName: string | null;
  ownership: Ownership;
  ownershipEvidence: string;
  statementIds: string[];
  periodStart: string | null;
  periodEnd: string | null;
  completeMonths: string[];
  missingMonths: string[];
  overlapDays: number;
  duplicatesRemoved: number;
  transactionCount: number;
  grossInflowKobo: number;
  grossOutflowKobo: number;
  openingBalanceKobo: number | null;
  closingBalanceKobo: number | null;
}
export interface Exclusion {
  kind: "INTERNAL_TRANSFER" | "DUPLICATE" | "LOAN_PROCEEDS" | "UNMATCHED_SELF_TRANSFER_IN" | "UNVERIFIED_ACCOUNT";
  direction: "CREDIT" | "DEBIT";
  amountKobo: number;
  date: string;
  accountKey: string;
  counterpart?: { accountKey: string; date: string } | null;
  description: string;
}
export interface FinancialException {
  type: string;
  severity: "BLOCKING" | "MATERIAL" | "INFO";
  affected: string;
  reason: string;
  evidence: string;
  impact: string;
  resolution: string;
}
export interface MonthFigure {
  month: string;
  grossInflowKobo: number;
  adjustedInflowKobo: number;
  adjustedOutflowKobo: number;
  salaryKobo: number;
  loanRepaymentKobo: number;
  netCashFlowKobo: number;
}
export interface FinancialIntelligence {
  version: string;
  complete: boolean;
  customerType: "SALARIED" | "BUSINESS";
  statementsAnalysed: number;
  statementsTotal: number;
  uniqueAccounts: number;
  accounts: AccountSummary[];
  assessmentMonths: string[];
  months: MonthFigure[];
  totals: {
    grossInflowKobo: number;
    internalTransfersKobo: number;
    duplicatesExcludedKobo: number;
    loanProceedsKobo: number;
    unmatchedSelfTransfersKobo: number;
    unverifiedAccountInflowKobo: number;
    adjustedExternalInflowKobo: number;
    grossOutflowKobo: number;
    adjustedExternalOutflowKobo: number;
  };
  /** Average over the assessment months; null when there is no complete month. */
  monthly: {
    adjustedInflowKobo: number | null;
    adjustedOutflowKobo: number | null;
    netCashFlowKobo: number | null;
    highestInflowKobo: number | null;
    lowestInflowKobo: number | null;
    /** Coefficient of variation of monthly adjusted inflow, in basis points (lower = steadier). */
    inflowVariationBps: number | null;
  };
  salary: {
    detected: boolean;
    verifiedMonthlyKobo: number | null;
    monthsWithSalary: number;
    missedMonths: string[];
    lowestKobo: number | null;
    highestKobo: number | null;
    mostRecentKobo: number | null;
    payers: string[];
    evidenceSufficient: boolean;
  };
  obligations: {
    detectedMonthlyKobo: number;
    repayments: { date: string; amountKobo: number; description: string; accountKey: string }[];
    lenders: string[];
  };
  exclusions: Exclusion[];
  exceptions: FinancialException[];
}

// ------------------------------------------------------------------ helpers

const kobo = (n: unknown): number | null => {
  const v = typeof n === "number" ? n : typeof n === "string" && n.trim() !== "" ? Number(n) : NaN;
  return Number.isFinite(v) ? Math.round(v * 100) : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isoDate = (s: string): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const monthOf = (d: string) => d.slice(0, 7);
const dayNumber = (d: string) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000);
const lastDayOfMonth = (m: string) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
function monthsBetween(a: string, b: string): string[] {
  const out: string[] = [];
  let y = +a.slice(0, 4);
  let mo = +a.slice(5, 7);
  const end = b.slice(0, 7);
  for (let i = 0; i < 600; i++) {
    const m = `${y}-${String(mo).padStart(2, "0")}`;
    if (m > end) break;
    out.push(m);
    mo++;
    if (mo > 12) {
      mo = 1;
      y++;
    }
  }
  return out;
}
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
const avg = (xs: number[]) => (xs.length ? Math.round(sum(xs) / xs.length) : null);
const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");
const mask = (acct: string | null) => {
  const d = digits(acct);
  return d.length >= 4 ? `••••${d.slice(-4)}` : null;
};
const normBank = (b: string | null) =>
  (b ?? "")
    .toLowerCase()
    .replace(/\b(plc|limited|ltd|bank|nigeria|ng|of)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

const STOP = new Set(["ltd", "limited", "plc", "enterprise", "enterprises", "ventures", "nig", "nigeria", "and", "the", "trading", "as", "co", "company", "global", "services", "mr", "mrs", "ms", "dr"]);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

/** Ownership from the account name on the statement against the applicant's names. */
export function ownershipOf(accountName: string | null, applicant: ApplicantNames): { ownership: Ownership; evidence: string } {
  if (!accountName) return { ownership: "UNVERIFIED", evidence: "The statement does not show an account name." };
  const acc = new Set(tokens(accountName));
  let best = 0;
  let matched = "";
  for (const n of applicant.names) {
    const t = tokens(n);
    if (!t.length) continue;
    const hit = t.filter((x) => acc.has(x)).length;
    const need = Math.min(2, t.length);
    if (hit >= need && hit > best) {
      best = hit;
      matched = n;
    }
  }
  if (best) return { ownership: "VERIFIED", evidence: `Account name "${accountName}" matches "${matched}".` };
  return { ownership: "MISMATCH", evidence: `Account name "${accountName}" does not match the applicant (${applicant.names.filter(Boolean).join(" / ") || "no name recorded"}).` };
}

// ------------------------------------------------------------------ the engine

export function buildIntelligence(input: IntelligenceInput): FinancialIntelligence {
  const exceptions: FinancialException[] = [];
  const exclusions: Exclusion[] = [];
  const usable = input.statements.filter((s) => (s.status === "PROCESSED" || s.status === "REUSED") && s.analytics && s.transactions);
  const complete = input.analysisStatus === "COMPLETED" && usable.length === input.statements.length;
  for (const s of input.statements) {
    if (usable.includes(s)) continue;
    const altered = s.errorCategory === "ALTERED" || s.vendorStatus === "ALTERED";
    exceptions.push({
      type: altered ? "STATEMENT_ALTERED" : "STATEMENT_NOT_ANALYSED",
      severity: altered ? "BLOCKING" : "MATERIAL",
      affected: s.filename,
      reason: altered ? "Periculum flagged the statement as possibly altered." : `The statement was not analysed (${s.errorCategory ?? s.status.toLowerCase()}).`,
      evidence: `Processing status: ${s.vendorStatus ?? s.status}.`,
      impact: "Its figures are not part of this assessment.",
      resolution: altered ? "Obtain the statement directly from the bank or verify it before relying on the assessment." : "Retry the statement or obtain a readable copy; the assessment is incomplete until then.",
    });
  }
  if (!complete && input.analysisStatus !== "COMPLETED")
    exceptions.push({
      type: "PARTIAL_ANALYSIS",
      severity: "BLOCKING",
      affected: "Consolidated assessment",
      reason: `${usable.length} of ${input.statements.length} statement(s) are analysed.`,
      evidence: `Analysis status: ${input.analysisStatus}.`,
      impact: "The consolidated figures are incomplete and are not presented as final.",
      resolution: "Resolve the outstanding statements, then the assessment is regenerated automatically.",
    });

  // ---- accounts and normalised transactions
  type Acc = AccountSummary & { tx: Tx[] };
  const accounts = new Map<string, Acc>();
  const selfInHints = new Map<string, DatedAmount[]>();
  const loanHints: DatedAmount[] = [];
  const repaymentHints: DatedAmount[] = [];
  const salaryHints: DatedAmount[] = [];
  for (const s of usable) {
    const a = s.analytics!;
    const bank = str(a.bankName);
    const acct = str(a.accountId);
    const name = str(a.accountName) ?? str(a.clientFullName);
    // A keyed one-way reference: matches the same account across statements without storing the number.
    const key = acct && digits(acct).length >= 6 ? `acct:${hmac(`${normBank(bank) || "bank"}:${digits(acct)}`).slice(0, 24)}` : `unknown:${s.statementId}`;
    if (key.startsWith("unknown:"))
      exceptions.push({
        type: "ACCOUNT_NOT_IDENTIFIED",
        severity: "MATERIAL",
        affected: s.filename,
        reason: "The statement does not show an account number, so it cannot be matched to other statements.",
        evidence: `Bank: ${bank ?? "not shown"}.`,
        impact: "Its transactions cannot be reconciled with other accounts; overlaps and transfers with it may be missed.",
        resolution: "Confirm the account number with the customer or the bank.",
      });
    let acc = accounts.get(key);
    if (!acc) {
      const own = ownershipOf(name, input.applicant);
      acc = {
        accountKey: key,
        bankName: bank,
        accountNumberMasked: mask(acct),
        accountName: name,
        ownership: own.ownership,
        ownershipEvidence: own.evidence,
        statementIds: [],
        periodStart: null,
        periodEnd: null,
        completeMonths: [],
        missingMonths: [],
        overlapDays: 0,
        duplicatesRemoved: 0,
        transactionCount: 0,
        grossInflowKobo: 0,
        grossOutflowKobo: 0,
        openingBalanceKobo: null,
        closingBalanceKobo: null,
        tx: [],
      };
      accounts.set(key, acc);
    }
    acc.statementIds.push(s.statementId);
    const start = isoDate(str(a.startDate) ?? "") ?? null;
    const end = isoDate(str(a.endDate) ?? "") ?? null;
    const txs = s.transactions!.map((t, i) => {
      const date = isoDate(String(t.date)) ?? "";
      return {
        id: `${s.statementId}:${i}`,
        statementId: s.statementId,
        accountKey: key,
        date,
        month: monthOf(date),
        amountKobo: Math.abs(kobo(t.amount) ?? 0),
        direction: String(t.type).toLowerCase().startsWith("c") ? ("CREDIT" as const) : ("DEBIT" as const),
        description: (t.description ?? "").toString().toLowerCase().replace(/\s+/g, " ").trim(),
        balanceKobo: kobo(t.balance),
      };
    });
    const dates = txs
      .map((t) => t.date)
      .filter(Boolean)
      .sort();
    const sStart = start ?? dates[0] ?? null;
    const sEnd = end ?? dates[dates.length - 1] ?? null;
    // Overlap with files of the same account already merged.
    if (sStart && sEnd && acc.periodStart && acc.periodEnd) {
      const ov = Math.min(dayNumber(sEnd), dayNumber(acc.periodEnd)) - Math.max(dayNumber(sStart), dayNumber(acc.periodStart)) + 1;
      if (ov > 0) acc.overlapDays += ov;
    }
    acc.periodStart = [acc.periodStart, sStart].filter(Boolean).sort()[0] ?? null;
    acc.periodEnd = [acc.periodEnd, sEnd].filter(Boolean).sort().reverse()[0] ?? null;
    (acc as Acc & { spans?: [string, string][] }).spans = [...((acc as Acc & { spans?: [string, string][] }).spans ?? []), ...(sStart && sEnd ? [[sStart, sEnd] as [string, string]] : [])];
    // Duplicate transactions across overlapping files of the same account.
    for (const t of txs) {
      const dup = acc.tx.find(
        (x) =>
          x.statementId !== t.statementId &&
          x.date === t.date &&
          x.amountKobo === t.amountKobo &&
          x.direction === t.direction &&
          (x.balanceKobo !== null && t.balanceKobo !== null ? x.balanceKobo === t.balanceKobo : x.description === t.description),
      );
      if (dup) {
        acc.duplicatesRemoved++;
        exclusions.push({ kind: "DUPLICATE", direction: t.direction, amountKobo: t.amountKobo, date: t.date, accountKey: key, counterpart: null, description: t.description });
        continue;
      }
      acc.tx.push(t);
    }
    const tpa = (a.transactionPatternAnalysis ?? {}) as Record<string, unknown>;
    const ba = (a.behavioralAnalysis ?? {}) as Record<string, unknown>;
    const ia = (a.incomeAnalysis ?? {}) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? (v as DatedAmount[]) : []);
    selfInHints.set(key, [...(selfInHints.get(key) ?? []), ...list(tpa.selfTransferInflowTransactions)]);
    loanHints.push(...list(ba.loanTransactions).map((x) => ({ ...x, description: `${key}|${x.description ?? ""}` })));
    repaymentHints.push(...list(ba.loanRepaymentTransactions).map((x) => ({ ...x, description: `${key}|${x.description ?? ""}` })));
    salaryHints.push(...list(ia.salaryTransactions).map((x) => ({ ...x, description: `${key}|${x.description ?? ""}` })));
  }

  for (const acc of accounts.values()) {
    acc.tx.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    acc.transactionCount = acc.tx.length;
    acc.grossInflowKobo = sum(acc.tx.filter((t) => t.direction === "CREDIT").map((t) => t.amountKobo));
    acc.grossOutflowKobo = sum(acc.tx.filter((t) => t.direction === "DEBIT").map((t) => t.amountKobo));
    const withBal = acc.tx.filter((t) => t.balanceKobo !== null);
    if (withBal.length) {
      const f = withBal[0];
      acc.openingBalanceKobo = f.balanceKobo! - (f.direction === "CREDIT" ? f.amountKobo : -f.amountKobo);
      acc.closingBalanceKobo = withBal[withBal.length - 1].balanceKobo;
    }
    // Complete months: fully inside one of the account's statement periods.
    const spans = (acc as Acc & { spans?: [string, string][] }).spans ?? [];
    if (acc.periodStart && acc.periodEnd) {
      const all = monthsBetween(acc.periodStart, acc.periodEnd);
      acc.completeMonths = all.filter((m) => spans.some(([s, e]) => s <= `${m}-01` && e >= lastDayOfMonth(m)));
      acc.missingMonths = all.filter((m) => !spans.some(([s, e]) => s.slice(0, 7) <= m && e.slice(0, 7) >= m));
    }
    if (acc.missingMonths.length)
      exceptions.push({
        type: "STATEMENT_GAP",
        severity: "MATERIAL",
        affected: `${acc.bankName ?? "Account"} ${acc.accountNumberMasked ?? ""}`.trim(),
        reason: `No statement covers ${acc.missingMonths.join(", ")}.`,
        evidence: `Statements cover ${acc.periodStart} to ${acc.periodEnd} with gaps.`,
        impact: "Those months are not part of the monthly averages.",
        resolution: "Request the statement for the missing period.",
      });
    if (acc.ownership !== "VERIFIED")
      exceptions.push({
        type: "OWNERSHIP_UNVERIFIED",
        severity: "MATERIAL",
        affected: `${acc.bankName ?? "Account"} ${acc.accountNumberMasked ?? ""}`.trim(),
        reason: acc.ownership === "MISMATCH" ? "The account name does not match the applicant." : "The account name could not be read from the statement.",
        evidence: acc.ownershipEvidence,
        impact: "Its inflows are excluded from assessed capacity until ownership is confirmed.",
        resolution: "Confirm the account belongs to the customer (e.g. bank reference letter), or exclude it.",
      });
    delete (acc as Acc & { spans?: unknown }).spans;
  }

  const allTx = [...accounts.values()].flatMap((a) => a.tx);
  const owned = (key: string) => accounts.get(key)?.ownership === "VERIFIED";
  const excluded = new Set<string>();

  // ---- internal transfers between the customer's own (verified) accounts
  const debits = allTx.filter((t) => t.direction === "DEBIT" && owned(t.accountKey));
  const credits = allTx.filter((t) => t.direction === "CREDIT" && owned(t.accountKey));
  for (const d of debits) {
    const c = credits.find(
      (x) => !excluded.has(x.id) && x.accountKey !== d.accountKey && x.amountKobo === d.amountKobo && dayNumber(x.date) - dayNumber(d.date) >= 0 && dayNumber(x.date) - dayNumber(d.date) <= TRANSFER_WINDOW_DAYS,
    );
    if (!c) continue;
    excluded.add(d.id);
    excluded.add(c.id);
    exclusions.push({
      kind: "INTERNAL_TRANSFER",
      direction: "DEBIT",
      amountKobo: d.amountKobo,
      date: d.date,
      accountKey: d.accountKey,
      counterpart: { accountKey: c.accountKey, date: c.date },
      description: d.description,
    });
    exclusions.push({
      kind: "INTERNAL_TRANSFER",
      direction: "CREDIT",
      amountKobo: c.amountKobo,
      date: c.date,
      accountKey: c.accountKey,
      counterpart: { accountKey: d.accountKey, date: d.date },
      description: c.description,
    });
  }

  const findTx = (h: DatedAmount, key: string | null, dir: "CREDIT" | "DEBIT") => {
    const d = isoDate(String(h.date));
    const amt = Math.abs(kobo(h.amount) ?? -1);
    return allTx.find((t) => t.direction === dir && (key === null || t.accountKey === key) && t.date === d && t.amountKobo === amt);
  };
  const keyOfHint = (h: DatedAmount) => String(h.description ?? "").split("|")[0] || null;

  // ---- self-transfer credits from accounts not provided (Periculum flag, no counterpart in our accounts)
  for (const [key, hints] of selfInHints) {
    for (const h of hints) {
      const t = findTx(h, key, "CREDIT");
      if (!t || excluded.has(t.id)) continue;
      excluded.add(t.id);
      exclusions.push({ kind: "UNMATCHED_SELF_TRANSFER_IN", direction: "CREDIT", amountKobo: t.amountKobo, date: t.date, accountKey: key, counterpart: null, description: t.description });
    }
  }
  const unmatchedSelf = exclusions.filter((e) => e.kind === "UNMATCHED_SELF_TRANSFER_IN");
  if (unmatchedSelf.length)
    exceptions.push({
      type: "SELF_TRANSFER_SOURCE_NOT_PROVIDED",
      severity: "INFO",
      affected: "Inflows",
      reason: `${unmatchedSelf.length} credit(s) are transfers from the customer's own account(s) that were not provided.`,
      evidence: `Total ₦${(sum(unmatchedSelf.map((e) => e.amountKobo)) / 100).toLocaleString("en-NG")}.`,
      impact: "They are not counted as income.",
      resolution: "If the customer has other accounts, request those statements for a complete picture.",
    });

  // ---- loan proceeds
  for (const h of loanHints) {
    const t = findTx(h, keyOfHint(h), "CREDIT");
    if (!t || excluded.has(t.id)) continue;
    excluded.add(t.id);
    exclusions.push({ kind: "LOAN_PROCEEDS", direction: "CREDIT", amountKobo: t.amountKobo, date: t.date, accountKey: t.accountKey, counterpart: null, description: t.description });
  }

  // ---- unverified accounts: their (remaining) inflows never increase capacity
  for (const t of allTx) {
    if (owned(t.accountKey) || excluded.has(t.id) || t.direction !== "CREDIT") continue;
    excluded.add(t.id);
    exclusions.push({ kind: "UNVERIFIED_ACCOUNT", direction: "CREDIT", amountKobo: t.amountKobo, date: t.date, accountKey: t.accountKey, counterpart: null, description: t.description });
  }

  // ---- assessment months: complete months of verified accounts, latest `requiredMonths`
  const verifiedAccs = [...accounts.values()].filter((a) => a.ownership === "VERIFIED");
  const completeUnion = [...new Set(verifiedAccs.flatMap((a) => a.completeMonths))].sort();
  const assessmentMonths = completeUnion.slice(-Math.max(1, input.requiredMonths));
  if (completeUnion.length < input.requiredMonths)
    exceptions.push({
      type: "INSUFFICIENT_COVERAGE",
      severity: "MATERIAL",
      affected: "Assessment period",
      reason: `The verified statements cover ${completeUnion.length} complete month(s); ${input.requiredMonths} are required.`,
      evidence: completeUnion.length ? `Complete months: ${completeUnion.join(", ")}.` : "No complete calendar month is covered.",
      impact: "Averages rest on fewer months than the product requires.",
      resolution: "Request statements covering the required period.",
    });
  const inPeriod = new Set(assessmentMonths);

  // ---- salary
  const salaryTx = new Set<string>();
  const payers = new Set<string>();
  for (const h of salaryHints) {
    const t = findTx(h, keyOfHint(h), "CREDIT");
    if (!t || excluded.has(t.id) || !owned(t.accountKey)) continue;
    salaryTx.add(t.id);
    const p = t.description
      .replace(/\d+/g, "")
      .replace(/\b(salary|payroll|credit|sal|pay|for|nip|trf|from)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (p) payers.add(p.slice(0, 60));
  }
  // ---- loan repayments (existing obligations)
  const repayments: FinancialIntelligence["obligations"]["repayments"] = [];
  const repaymentIds = new Set<string>();
  for (const h of repaymentHints) {
    const t = findTx(h, keyOfHint(h), "DEBIT");
    if (!t || excluded.has(t.id) || repaymentIds.has(t.id)) continue;
    repaymentIds.add(t.id);
    repayments.push({ date: t.date, amountKobo: t.amountKobo, description: t.description, accountKey: t.accountKey });
  }

  // ---- monthly figures (verified accounts, assessment months)
  const months: MonthFigure[] = assessmentMonths.map((m) => {
    const tx = allTx.filter((t) => t.month === m && owned(t.accountKey));
    const cr = tx.filter((t) => t.direction === "CREDIT");
    const dr = tx.filter((t) => t.direction === "DEBIT");
    const adjIn = sum(cr.filter((t) => !excluded.has(t.id)).map((t) => t.amountKobo));
    const adjOut = sum(dr.filter((t) => !excluded.has(t.id)).map((t) => t.amountKobo));
    return {
      month: m,
      grossInflowKobo: sum(cr.map((t) => t.amountKobo)),
      adjustedInflowKobo: adjIn,
      adjustedOutflowKobo: adjOut,
      salaryKobo: sum(cr.filter((t) => salaryTx.has(t.id)).map((t) => t.amountKobo)),
      loanRepaymentKobo: sum(dr.filter((t) => repaymentIds.has(t.id)).map((t) => t.amountKobo)),
      netCashFlowKobo: adjIn - adjOut,
    };
  });

  const inflows = months.map((m) => m.adjustedInflowKobo);
  const mean = avg(inflows);
  const variationBps = mean && inflows.length > 1 ? Math.round((Math.sqrt(sum(inflows.map((x) => (x - mean) ** 2)) / inflows.length) / mean) * 10_000) : inflows.length === 1 ? 0 : null;

  const salaryMonths = months.filter((m) => m.salaryKobo > 0);
  const salaryAmounts = salaryMonths.map((m) => m.salaryKobo);
  const lastSalary = [...allTx].filter((t) => salaryTx.has(t.id) && inPeriod.has(t.month)).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const salaryEvidenceOk = salaryMonths.length >= 3;
  if (input.customerType === "SALARIED") {
    if (!salaryMonths.length)
      exceptions.push({
        type: "SALARY_NOT_IDENTIFIED",
        severity: "BLOCKING",
        affected: "Income",
        reason: "No recurring salary credit was identified on the customer's verified accounts.",
        evidence: `${months.length} complete month(s) examined.`,
        impact: "Income cannot be established from the statements.",
        resolution: "Confirm the salary account with the customer and provide its statement, or record a manual assessment exception.",
      });
    else if (!salaryEvidenceOk)
      exceptions.push({
        type: "SALARY_HISTORY_SHORT",
        severity: "MATERIAL",
        affected: "Income",
        reason: `Salary appears in ${salaryMonths.length} complete month(s); three months of salary evidence are required.`,
        evidence: `Months with salary: ${salaryMonths.map((m) => m.month).join(", ")}.`,
        impact: "The verified salary rests on less evidence than policy requires.",
        resolution: "Request the statement for the missing month(s) or recent payslips.",
      });
    const missed = months.filter((m) => m.salaryKobo === 0).map((m) => m.month);
    if (salaryMonths.length && missed.length)
      exceptions.push({
        type: "SALARY_MISSED_MONTHS",
        severity: "MATERIAL",
        affected: "Income",
        reason: `No salary was received in ${missed.join(", ")}.`,
        evidence: `Salary received in ${salaryMonths.length} of ${months.length} month(s).`,
        impact: "Income may be irregular.",
        resolution: "Confirm with the employer (e.g. employment letter) before relying on the average.",
      });
  }

  const totalBy = (kind: Exclusion["kind"], dir?: "CREDIT" | "DEBIT") => sum(exclusions.filter((e) => e.kind === kind && (!dir || e.direction === dir)).map((e) => e.amountKobo));
  const grossIn = sum([...accounts.values()].map((a) => a.grossInflowKobo));
  const grossOut = sum([...accounts.values()].map((a) => a.grossOutflowKobo));
  const ownedTx = allTx.filter((t) => owned(t.accountKey) && !excluded.has(t.id));

  return {
    version: INTELLIGENCE_VERSION,
    complete: complete && !exceptions.some((e) => e.severity === "BLOCKING"),
    customerType: input.customerType,
    statementsAnalysed: usable.length,
    statementsTotal: input.statements.length,
    uniqueAccounts: accounts.size,
    accounts: [...accounts.values()].map(({ tx: _tx, ...rest }) => rest),
    assessmentMonths,
    months,
    totals: {
      grossInflowKobo: grossIn,
      internalTransfersKobo: totalBy("INTERNAL_TRANSFER", "CREDIT"),
      duplicatesExcludedKobo: totalBy("DUPLICATE", "CREDIT"),
      loanProceedsKobo: totalBy("LOAN_PROCEEDS"),
      unmatchedSelfTransfersKobo: totalBy("UNMATCHED_SELF_TRANSFER_IN"),
      unverifiedAccountInflowKobo: totalBy("UNVERIFIED_ACCOUNT"),
      adjustedExternalInflowKobo: sum(ownedTx.filter((t) => t.direction === "CREDIT").map((t) => t.amountKobo)),
      grossOutflowKobo: grossOut,
      adjustedExternalOutflowKobo: sum(ownedTx.filter((t) => t.direction === "DEBIT").map((t) => t.amountKobo)),
    },
    monthly: {
      adjustedInflowKobo: mean,
      adjustedOutflowKobo: avg(months.map((m) => m.adjustedOutflowKobo)),
      netCashFlowKobo: avg(months.map((m) => m.netCashFlowKobo)),
      highestInflowKobo: inflows.length ? Math.max(...inflows) : null,
      lowestInflowKobo: inflows.length ? Math.min(...inflows) : null,
      inflowVariationBps: variationBps,
    },
    salary: {
      detected: salaryMonths.length > 0,
      verifiedMonthlyKobo: avg(salaryAmounts),
      monthsWithSalary: salaryMonths.length,
      missedMonths: salaryMonths.length ? months.filter((m) => m.salaryKobo === 0).map((m) => m.month) : [],
      lowestKobo: salaryAmounts.length ? Math.min(...salaryAmounts) : null,
      highestKobo: salaryAmounts.length ? Math.max(...salaryAmounts) : null,
      mostRecentKobo: lastSalary?.amountKobo ?? null,
      payers: [...payers],
      evidenceSufficient: salaryEvidenceOk,
    },
    obligations: {
      detectedMonthlyKobo: months.length ? Math.round(sum(months.map((m) => m.loanRepaymentKobo)) / months.length) : 0,
      repayments: repayments.filter((r) => inPeriod.has(monthOf(r.date))),
      lenders: [...new Set(repayments.map((r) => r.description.replace(/\d+/g, "").replace(/\s+/g, " ").trim().slice(0, 60)))],
    },
    exclusions,
    exceptions,
  };
}

/** Loads the application facts the engine needs (names, customer type, required months). */
export async function applicantFacts(q: Db, appId: string) {
  const r = (
    await q.query<{ customer_name: string | null; applicant_type: string; customer_profile: string | null; data: Record<string, unknown> | null; version_id: string | null }>(
      `SELECT a.customer_name, a.applicant_type, a.customer_profile, v.data, v.id AS version_id
         FROM applications a LEFT JOIN application_versions v ON v.id = a.current_version_id WHERE a.id = $1`,
      [appId],
    )
  ).rows[0];
  const d = r?.data ?? {};
  const names = [r?.customer_name, d.customerName, d.businessName, d.companyName].map((x) => (typeof x === "string" ? x : "")).filter(Boolean) as string[];
  if (r?.version_id) for (const x of (await q.query<{ full_name: string }>("SELECT full_name FROM application_directors WHERE version_id = $1", [r.version_id])).rows) names.push(x.full_name);
  return { names, salaried: r?.customer_profile === "SALARY_EARNER" || (r?.applicant_type === "INDIVIDUAL" && r?.customer_profile !== "BUSINESS_OWNER") };
}

/**
 * Builds the financial intelligence for an analysis from its stored vendor results and saves it on the analysis
 * (fi_analyses.result). Runs automatically when the analysis settles; never calls Periculum.
 */
export async function storeIntelligence(q: Db, analysisId: string, now: Date) {
  const { statementPayload } = await import("./statement-analysis");
  const { effectiveConfig, profileRules } = await import("./products");
  const a = (await q.query<{ application_id: string; status: string }>("SELECT application_id, status FROM fi_analyses WHERE id = $1", [analysisId])).rows[0];
  if (!a) return null;
  const app = (await q.query<{ product_code: string | null; customer_profile: string | null }>("SELECT product_code, customer_profile FROM applications WHERE id = $1", [a.application_id])).rows[0];
  const facts = await applicantFacts(q, a.application_id);
  let requiredMonths = 6;
  if (app?.product_code) {
    const cfg = await effectiveConfig(q, app.product_code, now);
    const rules = cfg ? profileRules(cfg.config, app.customer_profile) : null;
    if (rules?.statementMonths) requiredMonths = rules.statementMonths;
  }
  const rows = (
    await q.query<{ id: string; filename: string; status: string; vendor_status: string | null; error_category: string | null }>(
      "SELECT id, filename, status, vendor_status, error_category FROM fi_statements WHERE analysis_id = $1 AND status <> 'DUPLICATE' ORDER BY created_at, filename",
      [analysisId],
    )
  ).rows;
  const statements: StatementInput[] = [];
  for (const r of rows) {
    const ok = r.status === "PROCESSED" || r.status === "REUSED";
    statements.push({
      statementId: r.id,
      filename: r.filename,
      status: (["PROCESSED", "REUSED", "FAILED", "REQUIRES_VERIFICATION", "PENDING"].includes(r.status) ? r.status : "OTHER") as StatementInput["status"],
      vendorStatus: r.vendor_status,
      errorCategory: r.error_category,
      analytics: ok ? await statementPayload<Record<string, unknown>>(q, r.id, "ANALYTICS") : null,
      transactions: ok ? await statementPayload<RawTransaction[]>(q, r.id, "TRANSACTIONS") : null,
    });
  }
  const result = buildIntelligence({ analysisStatus: a.status, customerType: facts.salaried ? "SALARIED" : "BUSINESS", requiredMonths, applicant: { names: facts.names }, statements });
  await q.query("UPDATE fi_analyses SET result = jsonb_set(coalesce(result, '{}'::jsonb), '{intelligence}', $2::jsonb) WHERE id = $1", [analysisId, JSON.stringify(result)]);
  return result;
}

/** The saved financial intelligence of an analysis (no vendor call). */
export async function savedIntelligence(q: Db, analysisId: string): Promise<FinancialIntelligence | null> {
  const r = (await q.query<{ result: { intelligence?: FinancialIntelligence } | null }>("SELECT result FROM fi_analyses WHERE id = $1", [analysisId])).rows[0];
  return r?.result?.intelligence ?? null;
}
