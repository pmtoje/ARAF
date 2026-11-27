import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { db } from "@/server/db";
import type { getCase } from "@/server/domain/views";
import { analysisStatements, currentAnalysis, CREDIT_ANALYSIS_STAGES, CREDIT_DETAIL_ROLES, type AnalysisRow, type StatementRow } from "@/server/domain/statement-analysis";
import { savedIntelligence, type FinancialException, type FinancialIntelligence } from "@/server/domain/financial-intelligence";
import { savedRecommendation, type Recommendation } from "@/server/domain/credit-recommendation";
import { bureauChecksFor, type BureauCheckRow } from "@/server/domain/bureau-check";
import { periculumReadiness } from "@/server/integrations/periculum/client";
import { formatKobo, koboToNairaString } from "@/server/money";
import { formatLagos } from "@/server/time";
import { AutoRefresh, RetryStatements, StartAnalysis, WhatIf } from "./FiClient";

type Case = Awaited<ReturnType<typeof getCase>>;
const ic = { className: "icon", "aria-hidden": true } as const;
const money = (k: number | null | undefined) => (k === null || k === undefined ? "—" : formatKobo(k));
const k2s = (k: number | null | undefined) => (k === null || k === undefined ? "" : koboToNairaString(k).replace(/\.00$/, ""));



const IN_FLIGHT = new Set(["QUEUED", "PROCESSING"]);
const STATUS_LABEL: Record<string, string> = {
  QUEUED: "Queued",
  PROCESSING: "Processing",
  PARTIALLY_COMPLETED: "Partially completed",
  COMPLETED: "Completed",
  FAILED: "Failed",
  REQUIRES_VERIFICATION: "Requires verification",
  SUPERSEDED: "Superseded",
};
const STATEMENT_LABEL: Record<string, string> = {
  PENDING: "Waiting to submit",
  SUBMITTING: "Submitting",
  SUBMISSION_UNCERTAIN: "Confirming submission",
  UPLOADED: "Uploaded",
  PROCESSING: "Processing",
  PROCESSED: "Processed",
  FAILED: "Failed",
  REQUIRES_VERIFICATION: "Requires verification",
  DUPLICATE: "Duplicate file (analysed once)",
  REUSED: "Reused earlier result",
};
const SEVERITY_ORDER = { BLOCKING: 0, MATERIAL: 1, INFO: 2 } as const;
const severityBadge = (s: FinancialException["severity"]) => (s === "BLOCKING" ? "badge-red" : s === "MATERIAL" ? "badge-warn" : "badge-blue");
const outcomeBadge = (o: Recommendation["outcome"]) => (o === "WITHIN_CAPACITY" ? "badge-green" : o === "REDUCED_AMOUNT" ? "badge-yellow" : o === "EXCEEDS_DSR" || o === "UNABLE_TO_ASSESS" ? "badge-red" : "badge-warn");
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export interface FiState {
  analysis: AnalysisRow | null;
  statements: StatementRow[];
  intelligence: FinancialIntelligence | null;
  recommendation: Recommendation | null;
  bureau: BureauCheckRow[];
  isAnalyst: boolean;
  detail: boolean;
}

/** Loads the analysis in force for the request and works out what this viewer may see and do. */
export async function loadFi(c: Case, staffId: string, roles: string[]): Promise<FiState> {
  const analysis = await currentAnalysis(db, c.app.id);
  const [statements, intelligence, recommendation, bureau] = analysis
    ? await Promise.all([analysisStatements(db, analysis.id), savedIntelligence(db, analysis.id), savedRecommendation(db, analysis.id), bureauChecksFor(db, analysis.id)])
    : [[], null, null, []];
  const t = c.openTask;
  const isAnalyst = !!t && (CREDIT_ANALYSIS_STAGES as readonly string[]).includes(t.stage) && t.assignee_id === staffId && roles.includes(t.assignee_role);
  return { analysis, statements, intelligence, recommendation, bureau, isAnalyst, detail: isAnalyst || roles.some((r) => CREDIT_DETAIL_ROLES.includes(r)) };
}

const statementDocs = (c: Case) => c.documents.filter((d) => !d.superseded_at && d.category === "BANK_STATEMENT").map((d) => ({ id: d.id, filename: d.filename }));

function SourceBanner({ a }: { a: AnalysisRow }) {
  if (a.source !== "FIXTURE") return null;
  return (
    <div className="alert alert-warn" role="note">
      <AlertTriangle {...ic} />
      <span>
        <strong>Test data.</strong> This result was produced by ARAF&apos;s simulated Periculum service, not by Periculum. It must not be relied on for a credit decision.
      </span>
    </div>
  );
}

function Meta({ a }: { a: AnalysisRow }) {
  return (
    <p className="small muted" style={{ margin: 0 }}>
      Analysis version {a.version} · {a.source === "FIXTURE" ? "simulated (test data)" : `Periculum ${a.vendor_environment}`} · started {formatLagos(a.created_at)}
      {a.completed_at ? ` · completed ${formatLagos(a.completed_at)}` : ""}
      {a.reason ? ` · reason: ${a.reason}` : ""}
    </p>
  );
}

function Exceptions({ items }: { items: FinancialException[] }) {
  if (!items.length)
    return (
      <p className="small" style={{ margin: 0 }}>
        <CheckCircle2 {...ic} /> No exceptions. Nothing in the statements needs your attention beyond the figures above.
      </p>
    );
  const sorted = [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return (
    <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {sorted.map((e, i) => (
        <li key={i} className="small" style={{ borderLeft: "3px solid var(--line-strong)", paddingLeft: 10 }}>
          <span className={`badge ${severityBadge(e.severity)}`}>{label(e.severity)}</span> <strong>{label(e.type)}</strong>
          {e.affected ? ` · ${e.affected}` : ""}
          <div>{e.reason}</div>
          {e.evidence && <div className="muted">Evidence: {e.evidence}</div>}
          {e.impact && <div className="muted">Impact: {e.impact}</div>}
          {e.resolution && <div>What to do: {e.resolution}</div>}
        </li>
      ))}
    </ul>
  );
}

function Row({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <tr>
      <th scope="row" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>
        {k}
      </th>
      <td className="num" style={{ textAlign: "right", fontWeight: strong ? 700 : undefined }}>
        {v}
      </td>
    </tr>
  );
}

function PrimarySummary({ r }: { r: Recommendation }) {
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Recommendation</h2>
        <span className={`badge ${outcomeBadge(r.outcome)}`}>{r.outcomeLabel}</span>
      </div>
      <div className="table-wrap">
        <table className="data">
          <tbody>
            <Row k="Requested" v={`${money(r.requested.principalKobo)} over ${r.requested.tenorMonths ?? "—"} months`} />
            <Row k={r.income.basis} v={money(r.income.monthlyKobo)} />
            <Row k={`Existing obligations (${r.obligations.source === "STATEMENTS" ? "from statements" : r.obligations.source === "DECLARED" ? "declared" : "none"})`} v={money(r.obligations.usedMonthlyKobo)} />
            <Row k="Proposed monthly repayment" v={money(r.proposedMonthlyKobo)} />
            <Row k="Debt service ratio" v={r.dsr.percent ? `${r.dsr.percent}% (limit ${r.dsr.thresholdPercent}%)` : "Not calculated"} strong />
            <Row k="Available monthly capacity" v={money(r.availableCapacityKobo)} />
            <Row k={`Maximum supported over ${r.requested.tenorMonths ?? "—"} months`} v={money(r.maxEligiblePrincipalKobo)} />
            <Row k="Recommended amount" v={money(r.recommendedPrincipalKobo)} strong />
          </tbody>
        </table>
      </div>
      {r.obligations.reconciliationNote && <p className="small muted" style={{ margin: 0 }}>{r.obligations.reconciliationNote}</p>}
      <div>
        <p className="eyebrow" style={{ marginBottom: 4 }}>
          Commentary
        </p>
        {r.commentary.map((t, i) => (
          <p key={i} className="small" style={{ margin: "0 0 6px" }}>
            {t}
          </p>
        ))}
      </div>
      {(r.blockedReasons.length > 0 || r.failingRules.length > 0 || r.conditions.length > 0) && (
        <ul className="small" style={{ margin: 0 }}>
          {r.blockedReasons.map((t) => <li key={`b${t}`}>Blocked: {t}</li>)}
          {r.failingRules.map((t) => <li key={`f${t}`}>Not met: {t}</li>)}
          {r.conditions.map((t) => <li key={`c${t}`}>Condition: {t}</li>)}
        </ul>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        {r.engine ? `${r.version} · ${r.engine.engineVersion}` : r.version}
        {r.seedfi ? ` · SeedFi ${r.seedfi.outcome ?? "—"}${r.seedfi.score !== null ? ` (score ${r.seedfi.score})` : ""}` : ""}. A recommendation, not a credit decision.
      </p>
    </div>
  );
}

function Breakdown({ fi, statements }: { fi: FinancialIntelligence | null; statements: StatementRow[] }) {
  return (
    <details className="card" open>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>Statements and accounts</summary>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="data">
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {statements.map((s) => (
              <tr key={s.id}>
                <td>{s.filename}</td>
                <td>
                  <span className={`badge ${s.status === "PROCESSED" || s.status === "REUSED" ? "badge-green" : s.status === "FAILED" || s.status === "REQUIRES_VERIFICATION" ? "badge-red" : ""}`}>{STATEMENT_LABEL[s.status] ?? s.status}</span>
                </td>
                <td className="small">{s.error_message ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fi && fi.accounts.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Account</th>
                <th>Holder</th>
                <th>Period</th>
                <th>Months</th>
                <th className="num">Inflow</th>
              </tr>
            </thead>
            <tbody>
              {fi.accounts.map((a) => (
                <tr key={a.accountKey}>
                  <td>
                    {a.bankName ?? "Bank not stated"} {a.accountNumberMasked ?? ""}
                  </td>
                  <td>
                    {a.accountName ?? "—"}{" "}
                    <span className={`badge ${a.ownership === "VERIFIED" ? "badge-green" : a.ownership === "MISMATCH" ? "badge-red" : "badge-warn"}`}>{label(a.ownership)}</span>
                  </td>
                  <td className="small">
                    {a.periodStart ?? "—"} to {a.periodEnd ?? "—"}
                    {a.overlapDays ? ` · ${a.overlapDays} days overlap` : ""}
                  </td>
                  <td className="small">
                    {a.completeMonths.length} complete{a.missingMonths.length ? ` · missing ${a.missingMonths.join(", ")}` : ""}
                    {a.duplicatesRemoved ? ` · ${a.duplicatesRemoved} duplicate lines removed` : ""}
                  </td>
                  <td className="num" style={{ textAlign: "right" }}>
                    {money(a.grossInflowKobo)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function Consolidated({ fi }: { fi: FinancialIntelligence }) {
  const t = fi.totals;
  return (
    <details className="card" open>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>Consolidated position</summary>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="data">
          <tbody>
            <Row k="Gross inflow (all accounts)" v={money(t.grossInflowKobo)} />
            <Row k="Less transfers between the applicant's own accounts" v={money(t.internalTransfersKobo)} />
            <Row k="Less duplicate transactions" v={money(t.duplicatesExcludedKobo)} />
            <Row k="Less loan proceeds" v={money(t.loanProceedsKobo)} />
            <Row k="Less unmatched self-transfers" v={money(t.unmatchedSelfTransfersKobo)} />
            <Row k="Less inflow to unverified accounts" v={money(t.unverifiedAccountInflowKobo)} />
            <Row k="Adjusted external inflow" v={money(t.adjustedExternalInflowKobo)} strong />
            <Row k="Average monthly adjusted inflow" v={money(fi.monthly.adjustedInflowKobo)} strong />
            <Row k="Average monthly net cash flow" v={money(fi.monthly.netCashFlowKobo)} />
            <Row k="Inflow variation" v={fi.monthly.inflowVariationBps !== null ? `${(fi.monthly.inflowVariationBps / 100).toFixed(1)}%` : "—"} />
          </tbody>
        </table>
      </div>
      {fi.customerType === "SALARIED" && (
        <p className="small" style={{ margin: "8px 0 0" }}>
          Salary: {fi.salary.detected ? `${money(fi.salary.verifiedMonthlyKobo)} verified a month, paid in ${fi.salary.monthsWithSalary} of ${fi.assessmentMonths.length} months` : "no salary credits identified"}
          {fi.salary.payers.length ? ` · from ${fi.salary.payers.join(", ")}` : ""}
          {fi.salary.missedMonths.length ? ` · missed ${fi.salary.missedMonths.join(", ")}` : ""}.
        </p>
      )}
      <p className="small" style={{ margin: "4px 0 0" }}>
        Loan repayments seen in the statements: {money(fi.obligations.detectedMonthlyKobo)} a month{fi.obligations.lenders.length ? ` (${fi.obligations.lenders.join(", ")})` : ""}.
      </p>
    </details>
  );
}

function Monthly({ fi }: { fi: FinancialIntelligence }) {
  if (!fi.months.length) return null;
  const used = new Set(fi.assessmentMonths);
  return (
    <details className="card">
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>Monthly figures</summary>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Gross inflow</th>
              <th className="num">Adjusted inflow</th>
              <th className="num">Adjusted outflow</th>
              <th className="num">Salary</th>
              <th className="num">Loan repayments</th>
              <th className="num">Net</th>
            </tr>
          </thead>
          <tbody>
            {fi.months.map((m) => (
              <tr key={m.month} style={used.has(m.month) ? undefined : { opacity: 0.6 }}>
                <td>
                  {m.month}
                  {used.has(m.month) ? "" : " (not assessed)"}
                </td>
                {[m.grossInflowKobo, m.adjustedInflowKobo, m.adjustedOutflowKobo, m.salaryKobo, m.loanRepaymentKobo, m.netCashFlowKobo].map((v, i) => (
                  <td key={i} className="num" style={{ textAlign: "right" }}>
                    {money(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fi.exclusions.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="small" style={{ cursor: "pointer" }}>
            {fi.exclusions.length} excluded transactions
          </summary>
          <ul className="small">
            {fi.exclusions.slice(0, 200).map((x, i) => (
              <li key={i}>
                {x.date} · {label(x.kind)} · {x.direction.toLowerCase()} {money(x.amountKobo)} · {x.description}
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}

function Bureau({ rows }: { rows: BureauCheckRow[] }) {
  if (!rows.length) return null;
  return (
    <details className="card">
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>Blacklist search</summary>
      <ul className="small" style={{ marginTop: 8 }}>
        {rows.map((b) => (
          <li key={b.id}>
            {b.subject_label}
            {b.bvn_last4 ? ` (BVN ••••${b.bvn_last4})` : ""}: <span className="badge">{label(b.status)}</span>
            {b.summary ? ` · ${b.summary.totalDelinquent ?? 0} delinquent facilities reported${b.summary.reportDate ? ` (report ${b.summary.reportDate})` : ""}` : ""}
            {b.error_message ? ` · ${b.error_message}` : ""}
            {b.source === "FIXTURE" ? " · test data" : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Summary for viewers outside credit (e.g. the initiator): outcome and what is needed, no account detail. */
function InitiatorSummary({ s }: { s: FiState }) {
  const a = s.analysis!;
  const r = s.recommendation;
  const asks = (s.intelligence?.exceptions ?? []).filter((e) => e.severity !== "INFO" && e.resolution);
  return (
    <div className="card stack">
      <SourceBanner a={a} />
      <p style={{ margin: 0 }}>
        Status: <span className="badge">{STATUS_LABEL[a.status] ?? a.status}</span>
        {r && (
          <>
            {" "}
            · <span className={`badge ${outcomeBadge(r.outcome)}`}>{r.outcomeLabel}</span>
          </>
        )}
      </p>
      {r?.recommendedPrincipalKobo !== null && r?.recommendedPrincipalKobo !== undefined && (
        <p className="small" style={{ margin: 0 }}>
          Amount supported by the verified figures: <strong>{money(r.recommendedPrincipalKobo)}</strong> over {r.requested.tenorMonths ?? "—"} months.
        </p>
      )}
      {asks.length > 0 && (
        <div>
          <p className="eyebrow" style={{ marginBottom: 4 }}>
            The credit reviewer may ask for
          </p>
          <ul className="small" style={{ margin: 0 }}>
            {[...new Set(asks.map((e) => e.resolution))].map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        The full analysis is visible to the credit team. The credit decision is made by the reviewers, not by the analysis.
      </p>
    </div>
  );
}

/** The Financial Intelligence tab: before, during and after Automatic Statement Analysis. */
export async function FinancialIntelligenceTab({ c, s }: { c: Case; s: FiState }) {
  const docs = statementDocs(c);
  const a = s.analysis;
  const ready = s.isAnalyst ? await periculumReadiness() : { ready: true, problem: null };

  if (!a) {
    return (
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Automatic Statement Analysis</h2>
        <p className="small" style={{ margin: 0 }}>
          {docs.length
            ? `${docs.length} bank statement${docs.length === 1 ? "" : "s"} on file. Not analysed yet.`
            : "No bank statement is on file yet. Analysis needs at least one PDF bank statement."}
        </p>
        {s.isAnalyst ? (
          ready.ready ? (
            docs.length > 0 && (
              <>
                <p className="small muted" style={{ margin: 0 }}>
                  ARAF sends each statement to Periculum once, consolidates the accounts, removes transfers between the applicant&apos;s own accounts and calculates affordability at the approved DSR. You then confirm or adjust the figures in your final assessment.
                </p>
                <StartAnalysis applicationId={c.app.id} docs={docs} rerun={false} />
              </>
            )
          ) : (
            <div className="alert alert-info" role="status">
              <Info {...ic} />
              {ready.problem}
            </div>
          )
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            The assigned credit reviewer runs the analysis during credit review.
          </p>
        )}
      </div>
    );
  }

  if (!s.detail) return <InitiatorSummary s={s} />;

  const running = IN_FLIGHT.has(a.status);
  const done = s.statements.filter((x) => ["PROCESSED", "REUSED", "DUPLICATE"].includes(x.status)).length;
  const retryable = s.statements.filter((x) => (x.status === "FAILED" || x.status === "REQUIRES_VERIFICATION") && !["ALTERED", "FILE_LIMIT", "UNSUPPORTED_FILE", "SUBMITTED_KEY_UNKNOWN"].includes(x.error_category ?? ""));
  const exceptions = [...(s.intelligence?.exceptions ?? []), ...(s.recommendation?.policyFlags ?? [])];
  const r = s.recommendation;

  return (
    <div className="stack">
      <SourceBanner a={a} />
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0 }}>Automatic Statement Analysis</h2>
          <span className={`badge ${a.status === "COMPLETED" ? "badge-green" : running ? "badge-blue" : "badge-warn"}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
        </div>
        {running && (
          <>
            <AutoRefresh />
            <p className="small" style={{ margin: 0 }} role="status">
              {done} of {s.statements.length} statements processed. Periculum usually takes a few minutes; this page updates itself. You can leave and come back.
            </p>
            <progress max={Math.max(1, s.statements.length)} value={done} style={{ width: "100%" }} aria-label="Statements processed" />
          </>
        )}
        <Meta a={a} />
        {s.isAnalyst && ready.ready && retryable.length > 0 && !running && (
          <details open>
            <summary className="small" style={{ cursor: "pointer", fontWeight: 700 }}>
              Retry {retryable.length} statement{retryable.length === 1 ? "" : "s"}
            </summary>
            <div style={{ marginTop: 8 }}>
              <RetryStatements analysisId={a.id} docs={retryable.map((x) => ({ id: x.document_id, filename: x.filename }))} />
            </div>
          </details>
        )}
        {s.isAnalyst && ready.ready && !running && (
          <details>
            <summary className="small" style={{ cursor: "pointer" }}>
              Run the analysis again
            </summary>
            <p className="small muted">New or replaced statements are picked up automatically. Statements already processed are reused, so Periculum is not charged twice.</p>
            <StartAnalysis applicationId={c.app.id} docs={docs} rerun />
          </details>
        )}
      </div>

      {r && <PrimarySummary r={r} />}

      {!running && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>
            Exceptions <span className="badge">{exceptions.length}</span>
          </h2>
          <Exceptions items={exceptions} />
        </div>
      )}

      {r && r.income.monthlyKobo !== null && !running && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>What if</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Try another amount or tenor against the same verified figures and the same product rules.
          </p>
          <WhatIf analysisId={a.id} principal={k2s(r.requested.principalKobo)} tenor={r.requested.tenorMonths ? String(r.requested.tenorMonths) : ""} />
        </div>
      )}

      <Breakdown fi={s.intelligence} statements={s.statements} />
      {s.intelligence && <Consolidated fi={s.intelligence} />}
      {s.intelligence && <Monthly fi={s.intelligence} />}
      <Bureau rows={s.bureau} />
    </div>
  );
}

/** Compact status card for the side column. */
export function FinancialIntelligenceCard({ s, href }: { s: FiState; href: string }) {
  if (!s.analysis && !s.isAnalyst) return null;
  const a = s.analysis;
  const r = s.recommendation;
  return (
    <div className="card">
      <p className="eyebrow">Financial intelligence</p>
      {!a ? (
        <p className="small" style={{ margin: "0 0 8px" }}>
          Bank statements have not been analysed yet.
        </p>
      ) : (
        <p className="small" style={{ margin: "0 0 8px" }}>
          <span className="badge">{STATUS_LABEL[a.status] ?? a.status}</span>
          {r && (
            <>
              {" "}
              <span className={`badge ${outcomeBadge(r.outcome)}`}>{r.outcomeLabel}</span>
            </>
          )}
          {a.source === "FIXTURE" && (
            <>
              {" "}
              <span className="badge badge-warn">Test data</span>
            </>
          )}
          {s.detail && r?.dsr.percent && <span className="muted"> · DSR {r.dsr.percent}%</span>}
        </p>
      )}
      <Link className="btn btn-sm" href={href}>
        {a ? "Open the analysis" : "Run Automatic Statement Analysis"}
      </Link>
    </div>
  );
}

/** Verified figures for the final assessment form (credit reviewer confirms or adjusts). Null when there is nothing usable. */
export function verifiedDefaults(s: FiState) {
  const a = s.analysis;
  const r = s.recommendation;
  const fi = s.intelligence;
  if (!a || !r || !fi || a.status !== "COMPLETED" || r.income.monthlyKobo === null) return null;
  const starts = fi.accounts.map((x) => x.periodStart).filter(Boolean) as string[];
  const ends = fi.accounts.map((x) => x.periodEnd).filter(Boolean) as string[];
  const obligations =
    r.obligations.source === "STATEMENTS"
      ? [{ lender: fi.obligations.lenders.length ? `Statement-detected: ${fi.obligations.lenders.join(", ")}` : "Statement-detected repayments", monthly: k2s(r.obligations.usedMonthlyKobo) }]
      : null;
  return {
    version: a.version,
    incomeBasis: k2s(r.income.monthlyKobo),
    annualInflow: k2s(r.income.annualKobo),
    obligations,
    statementFrom: starts.sort()[0] ?? "",
    statementTo: ends.sort().at(-1) ?? "",
    recommendedPrincipal: r.outcome === "REDUCED_AMOUNT" ? k2s(r.recommendedPrincipalKobo) : "",
    testData: a.source === "FIXTURE",
    note: `${a.source === "FIXTURE" ? "[TEST DATA, not Periculum] " : ""}${r.income.basis} from Automatic Statement Analysis v${a.version} (${fi.statementsAnalysed} statement${fi.statementsAnalysed === 1 ? "" : "s"}, ${fi.assessmentMonths.length} months, transfers between own accounts removed).`,
  };
}
export type VerifiedDefaults = NonNullable<ReturnType<typeof verifiedDefaults>>;
