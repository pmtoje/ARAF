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
import { AutoRefresh, ManualAssessmentRequest, RetryStatements, StartAnalysis, WhatIf } from "./FiClient";
import rs from "./risk-report.module.css";
import { analysisFreshness, reviewsFor, type Freshness, type ReviewRow } from "@/server/domain/fi-governance";
import { REPORT_CATEGORY } from "@/server/domain/fi-report";
import { CATEGORY_LABELS, riskFor, type RiskLevel, type RiskProfile } from "@/server/domain/fi-risk";
import { configById, profileRules, type ProfileRules } from "@/server/domain/products";

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
  /** Whether the analysis still matches the application's statements (an outdated one is never shown as current). */
  freshness?: Freshness;
  reviews?: ReviewRow[];
  versions?: { id: string; version: number; status: string; source: string; created_at: Date; superseded_at: Date | null; relied_on_at: Date | null }[];
  reports?: { id: string; version_no: number; filename: string; uploaded_at: Date; superseded_at: Date | null; meta: Record<string, string> }[];
  manual?: { required: boolean; approverRole: string | null; exceptions: { id: string; status: string; reason: string; requested_at: Date; decision_note: string | null }[] };
  risk?: RiskProfile | null;
}

/** Loads the analysis in force for the request and works out what this viewer may see and do. */
export async function loadFi(c: Case, staffId: string, roles: string[]): Promise<FiState> {
  const analysis = await currentAnalysis(db, c.app.id);
  const [statements, intelligence, recommendation, bureau] = analysis
    ? await Promise.all([analysisStatements(db, analysis.id), savedIntelligence(db, analysis.id), savedRecommendation(db, analysis.id), bureauChecksFor(db, analysis.id)])
    : [[], null, null, []];
  const t = c.openTask;
  const isAnalyst = !!t && (CREDIT_ANALYSIS_STAGES as readonly string[]).includes(t.stage) && t.assignee_id === staffId && roles.includes(t.assignee_role);
  const app = c.app as { id: string; product_config_id?: string | null; customer_profile?: string | null };
  let rules: ProfileRules | null = null;
  if (app.product_config_id && app.customer_profile) {
    try {
      rules = profileRules((await configById(db, app.product_config_id)).config, app.customer_profile);
    } catch {
      rules = null;
    }
  }
  const [freshness, reviews, versions, reports, manualEx] = await Promise.all([
    analysis ? analysisFreshness(db, analysis) : Promise.resolve(undefined),
    reviewsFor(db, app.id),
    db.query("SELECT id, version, status, source, created_at, superseded_at, relied_on_at FROM fi_analyses WHERE application_id = $1 ORDER BY version DESC", [app.id]).then((r) => r.rows),
    db
      .query("SELECT id, version_no, filename, uploaded_at, superseded_at, meta FROM documents WHERE application_id = $1 AND category = $2 AND scan_status = 'CLEAN' AND purged_at IS NULL ORDER BY version_no DESC", [app.id, REPORT_CATEGORY])
      .then((r) => r.rows),
    db.query("SELECT id, status, reason, requested_at, decision_note FROM policy_exceptions WHERE application_id = $1 AND type = 'MANUAL_ASSESSMENT' ORDER BY requested_at DESC", [app.id]).then((r) => r.rows),
  ]);
  return {
    analysis,
    statements,
    intelligence,
    recommendation,
    bureau,
    isAnalyst,
    detail: isAnalyst || roles.some((r) => CREDIT_DETAIL_ROLES.includes(r)),
    freshness,
    reviews,
    versions,
    reports,
    manual: { required: !!rules?.statementAnalysis?.required, approverRole: rules?.statementAnalysis?.manualExceptionApproverRole ?? null, exceptions: manualEx },
    risk: analysis && !["QUEUED", "PROCESSING"].includes(analysis.status) ? await riskFor(db, analysis.id) : null,
  };
}

const statementDocs = (c: Case) => c.documents.filter((d) => !d.superseded_at && d.category === "BANK_STATEMENT").map((d) => ({ id: d.id, filename: d.filename }));
type Link = (docId: string, mode: "view" | "download") => string;

function StaleBanner({ s }: { s: FiState }) {
  if (!s.analysis || s.freshness?.current !== false) return null;
  return (
    <div className="alert alert-warn" role="alert">
      <AlertTriangle {...ic} />
      <span>
        <strong>Requires refresh.</strong> {s.freshness.reason} The figures below are from analysis v{s.analysis.version} and are kept for the record; they are not used as the current assessment.
      </span>
    </div>
  );
}

/** Before analysis: what is on file (brief §7). Coverage comes from the upload; bank and account appear after analysis. */
function StatementsOnFile({ c }: { c: Case }) {
  const docs = c.documents.filter((d) => !d.superseded_at && d.category === "BANK_STATEMENT");
  if (!docs.length) return null;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Statement</th>
            <th>Coverage</th>
            <th>Upload</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td>{d.filename}</td>
              <td className="small">{d.meta?.coverageFrom && d.meta?.coverageTo ? `${d.meta.coverageFrom} to ${d.meta.coverageTo}` : "Not stated"}</td>
              <td>
                <span className={`badge ${d.scan_status === "CLEAN" ? "badge-green" : d.scan_status === "REJECTED" ? "badge-red" : "badge-warn"}`}>{d.scan_status === "CLEAN" ? "Ready" : label(d.scan_status)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Monthly adjusted inflow and outflow: grouped bars, one axis, legend + table view (Monthly figures). */
function TrendChart({ fi }: { fi: FinancialIntelligence }) {
  const months = fi.months.filter((m) => fi.assessmentMonths.includes(m.month));
  if (months.length < 2) return null;
  const max = Math.max(...months.flatMap((m) => [m.adjustedInflowKobo, m.adjustedOutflowKobo]), 1);
  const W = 640;
  const H = 180;
  const padL = 8;
  const padB = 22;
  const band = (W - padL) / months.length;
  const bw = Math.min(26, (band - 14) / 2);
  const y = (v: number) => ((H - padB - 8) * v) / max;
  const bar = (x: number, h: number) => {
    const r = Math.min(4, h);
    const top = H - padB - h;
    return `M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - padB} Z`;
  };
  const compact = (k: number) => (k >= 100_000_000 ? `₦${(k / 100_000_000).toFixed(1)}m` : `₦${Math.round(k / 100_000).toLocaleString("en-NG")}k`);
  return (
    <figure style={{ margin: 0 }}>
      <div className="row small" style={{ gap: 16, marginBottom: 6 }} aria-hidden="true">
        <span>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--series-1)", marginRight: 6 }} />
          Adjusted inflow
        </span>
        <span>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--series-2)", marginRight: 6 }} />
          Adjusted outflow
        </span>
        <span className="muted">Highest month {compact(max)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Monthly adjusted inflow and outflow for ${months.length} assessment months. Figures are in the Monthly figures table.`}>
        <line x1={padL} x2={W} y1={H - padB} y2={H - padB} stroke="var(--line-strong)" strokeWidth="1" />
        {months.map((m, i) => {
          const x0 = padL + i * band + (band - (2 * bw + 2)) / 2;
          return (
            <g key={m.month}>
              <path d={bar(x0, y(m.adjustedInflowKobo))} fill="var(--series-1)">
                <title>{`${m.month} adjusted inflow ${money(m.adjustedInflowKobo)}`}</title>
              </path>
              <path d={bar(x0 + bw + 2, y(m.adjustedOutflowKobo))} fill="var(--series-2)">
                <title>{`${m.month} adjusted outflow ${money(m.adjustedOutflowKobo)}`}</title>
              </path>
              <text x={x0 + bw + 1} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">
                {m.month}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

const GRADE_BADGE: Record<RiskProfile["grade"], string> = { LOW: "badge-green", MODERATE: "badge-yellow", ELEVATED: "badge-warn", HIGH: "badge-red" };

const CAT_SHORT: Record<string, string> = { AFFORDABILITY: "Affordability", CONDUCT: "Conduct", STABILITY: "Stability", INTEGRITY: "Integrity", EXTERNAL: "Bureau" };
const LEVEL_TEXT: Record<RiskLevel, string> = { HIGH: "High", WATCH: "Watch", LOW: "Low", NOT_REPORTED: "Not reported" };

function Pill({ level, children }: { level: RiskLevel; children?: React.ReactNode }) {
  return <span className={`${rs.pill} ${rs[`pill${level}`]}`}>{children ?? LEVEL_TEXT[level]}</span>;
}

/** Credit Risk Report, as designed in Figma ("App · Financial intelligence · Credit Risk Report"). */
function RiskReportView({ c, a, s, r, risk, link, canRerun }: { c: Case; a: AnalysisRow; s: FiState; r: Recommendation; risk: RiskProfile; link: Link; canRerun: boolean }) {
  const report = (s.reports ?? []).find((d) => !d.superseded_at);
  const fi = s.intelligence;
  const dsr = r.dsr.percent ? Number(r.dsr.percent) : null;
  const lim = r.dsr.thresholdPercent ? Number(r.dsr.thresholdPercent) : null;
  const max = dsr !== null && lim !== null ? Math.max(50, Math.ceil((Math.max(dsr, lim) * 1.25) / 10) * 10) : 50;
  const dsrColor = r.dsr.pass === false ? "var(--danger)" : dsr !== null && lim !== null && dsr > lim * 0.8 ? "#c2620a" : "var(--success)";
  const commentary = r.commentary.length > 3 ? r.commentary.slice(2) : r.commentary;
  const groups = (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).map((k) => ({ k, items: risk.indicators.filter((i) => i.category === k) })).filter((g) => g.items.length);
  return (
    <section className={rs.report} aria-labelledby="crr-title">
      <div className={rs.header}>
        <div className={rs.headerText}>
          <p className={rs.eyebrow}>Financial intelligence · {c.app.ref}</p>
          <h2 id="crr-title" className={rs.title}>
            Credit Risk Report
          </h2>
          <p className={rs.meta}>
            Automatic Statement Analysis v{a.version} · {a.source === "FIXTURE" ? "simulated test data" : `Periculum Insights (${a.vendor_environment})`}
            {a.completed_at ? ` · completed ${formatLagos(a.completed_at)}` : ""}
            {fi ? ` · ${fi.statementsAnalysed} statement${fi.statementsAnalysed === 1 ? "" : "s"}, ${fi.uniqueAccounts} account${fi.uniqueAccounts === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        <div className={rs.actions}>
          {canRerun && (
            <a className="btn" href="#run-again">
              Run again
            </a>
          )}
          {report && (
            <a className="btn btn-primary" href={link(report.id, "download")}>
              Download PDF
            </a>
          )}
        </div>
      </div>

      <div className={rs.hero}>
        <div className={`${rs.grade} ${rs[`grade${risk.grade}`]}`}>
          <p className={rs.gradeLabel}>RISK GRADE</p>
          <p className={rs.gradeWord}>{risk.gradeLabel.replace(/ risk$/, "")}</p>
          <p className={rs.gradeScore}>
            Score {risk.score} · {risk.indicators.length} indicators
          </p>
          <div className={rs.counts}>
            <Pill level="HIGH">{risk.counts.high} high</Pill>
            <Pill level="WATCH">{risk.counts.watch} watch</Pill>
            <Pill level="LOW">{risk.counts.low} low</Pill>
            {risk.counts.notReported > 0 && <Pill level="NOT_REPORTED">{risk.counts.notReported} not reported</Pill>}
          </div>
        </div>
        <div className={rs.summary}>
          <p className={rs.headline}>{risk.headline}</p>
          <div className={rs.cats}>
            {risk.categories.map((x) => (
              <div key={x.category} className={rs.cat}>
                <span className={rs.catName}>{CAT_SHORT[x.category] ?? x.label}</span>
                <Pill level={x.level} />
                <span className={rs.catNote}>{x.note}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={rs.kpis}>
        {(
          [
            ["Requested", money(r.requested.principalKobo), r.requested.tenorMonths ? `over ${r.requested.tenorMonths} months` : ""],
            ["Indicative eligible", money(r.maxEligiblePrincipalKobo), lim !== null ? `at the approved ${lim}% DSR` : "at the approved DSR"],
            ["Recommended", money(r.recommendedPrincipalKobo), r.outcomeLabel],
            ["Monthly capacity", money(r.availableCapacityKobo), "available for this facility"],
          ] as [string, string, string][]
        ).map(([l, v, h]) => (
          <div key={l} className={rs.kpi}>
            <p className={rs.kpiLabel}>{l}</p>
            <p className={rs.kpiValue}>{v.replace(/\.00$/, "")}</p>
            <p className={rs.kpiHint}>{h}</p>
          </div>
        ))}
      </div>

      <div className={rs.two}>
        <div className={rs.card}>
          <div className={rs.cardHead}>
            <h3 className={rs.cardTitle}>Debt service ratio</h3>
            <span className={rs.dsrValue} style={{ color: dsrColor }}>
              {dsr !== null ? `${dsr.toFixed(2)}%` : "—"}
            </span>
          </div>
          {dsr !== null && lim !== null && (
            <>
              <div className={rs.track} role="img" aria-label={`DSR ${dsr.toFixed(2)}% against a ${lim}% limit`}>
                <div className={rs.bar} style={{ width: `${Math.min(100, (dsr / max) * 100)}%`, background: dsrColor }} />
                <div className={rs.limit} style={{ left: `${(lim / max) * 100}%` }} />
              </div>
              <div className={rs.scale}>
                <span>0%</span>
                <strong>{lim}% limit</strong>
                <span>{max}%</span>
              </div>
            </>
          )}
          <p className={rs.note}>
            Proposed {money(r.proposedMonthlyKobo)} + existing {money(r.obligations.usedMonthlyKobo)} a month against {r.income.basis.toLowerCase()} of {money(r.income.monthlyKobo)}.
            {r.obligations.reconciliationNote ? ` ${r.obligations.reconciliationNote}` : ""}
          </p>
        </div>
        <div className={`${rs.card} ${rs.rec}`}>
          <div className={rs.cardHead}>
            <h3 className={rs.cardTitle}>Automated recommendation</h3>
            <span className={rs.recOutcome}>{r.outcomeLabel}</span>
          </div>
          {commentary.map((t, i) => (
            <p key={i} className={rs.recText}>
              {t}
            </p>
          ))}
          {r.conditions.map((t) => (
            <p key={t} className={rs.recText}>
              <strong>Condition:</strong> {t}
            </p>
          ))}
          <p className={rs.note}>A recommendation, not a credit decision.</p>
        </div>
      </div>

      <div className={rs.two}>
        <div className={rs.risks}>
          <h3 className={rs.risksTitle}>Key risks</h3>
          <ul className={rs.list}>{risk.keyRisks.length ? risk.keyRisks.map((k) => <li key={k}>{k}</li>) : <li>No high or watch signals.</li>}</ul>
        </div>
        <div className={rs.mitigants}>
          <h3 className={rs.mitigantsTitle}>Mitigants</h3>
          <ul className={rs.list}>{risk.mitigants.length ? risk.mitigants.map((k) => <li key={k}>{k}</li>) : <li>None identified.</li>}</ul>
        </div>
      </div>

      <div className={rs.indicators}>
        <div className={rs.indicatorsHead}>
          <h3 className={rs.cardTitle}>Risk indicators</h3>
          <span className="small muted">Thresholds {risk.thresholdsStatus.toLowerCase()}</span>
        </div>
        {groups.map((g) => (
          <div key={g.k} role="group" aria-label={CATEGORY_LABELS[g.k]}>
            <div className={rs.group}>{CATEGORY_LABELS[g.k]}</div>
            {g.items.map((i) => (
              <div key={i.key} className={rs.row}>
                <div className={rs.rowLevel}>
                  <Pill level={i.level} />
                </div>
                <div>
                  <p className={rs.rowLabel}>{i.label}</p>
                  <p className={rs.rowEvidence}>
                    {i.evidence} · {i.source}
                  </p>
                </div>
                <div className={rs.rowValue}>{i.value}</div>
              </div>
            ))}
          </div>
        ))}
        <div className={rs.foot}>{risk.version} · decision support only: the credit decision stays with the approvers and the 30% DSR rule.</div>
      </div>
    </section>
  );
}

function ReportsAndVersions({ s, link }: { s: FiState; link: Link }) {
  const reports = s.reports ?? [];
  const versions = s.versions ?? [];
  if (!reports.length && versions.length < 2) return null;
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Credit Risk Report (PDF)</h2>
      {reports[0] && !reports[0].superseded_at && (
        <p className="small" style={{ margin: 0 }}>
          <a className="btn btn-sm" href={link(reports[0].id, "download")}>
            Download the current report (PDF)
          </a>{" "}
          <a href={link(reports[0].id, "view")} target="_blank" rel="noreferrer">
            View
          </a>{" "}
          <span className="muted">· saved automatically with the analysis; also in Documents and the archive pack.</span>
        </p>
      )}
      {reports.length > 1 && (
        <details>
          <summary className="small" style={{ cursor: "pointer" }}>
            Earlier report versions ({reports.length - 1})
          </summary>
          <ul className="small">
            {reports.slice(1).map((d) => (
              <li key={d.id}>
                <a href={link(d.id, "download")}>{d.filename}</a> · analysis v{d.meta?.analysisVersion ?? "—"} · {formatLagos(d.uploaded_at)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {versions.length > 1 && (
        <details>
          <summary className="small" style={{ cursor: "pointer" }}>
            Analysis versions ({versions.length})
          </summary>
          <ul className="small">
            {versions.map((v) => (
              <li key={v.id}>
                v{v.version} · {label(v.status)} · {formatLagos(v.created_at)}
                {v.superseded_at ? ` · superseded ${formatLagos(v.superseded_at)}` : " · current"}
                {v.relied_on_at ? " · relied on by the credit decision" : ""}
                {v.source === "FIXTURE" ? " · test data" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReviewHistory({ rows }: { rows: ReviewRow[] }) {
  if (!rows.length) return null;
  const show = (a: ReviewRow["adjustments"][number], v: number | null) => (v === null ? "—" : a.field === "TENOR" ? `${v} months` : money(v));
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Credit analyst review</h2>
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map((r) => (
          <li key={r.id} className="small">
            <span className={`badge ${r.kind === "ADJUSTED" ? "badge-warn" : r.kind === "MANUAL" ? "badge-blue" : "badge-green"}`}>
              {r.kind === "ADJUSTED" ? "Adjusted" : r.kind === "MANUAL" ? "Manual Financial Assessment" : "Confirmed"}
            </span>{" "}
            {r.actor_name} · {formatLagos(r.created_at)}
            {r.adjustments.length > 0 && (
              <ul style={{ margin: "4px 0 0" }}>
                {r.adjustments.map((a, i) => (
                  <li key={i}>
                    {a.label}: {show(a, a.original)} → {show(a, a.adjusted)}
                  </li>
                ))}
              </ul>
            )}
            {r.reason && <div className="muted">Reason: {r.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Controlled Manual Financial Assessment exception (brief §28): shown to the assigned analyst where analysis is mandatory. */
function ManualAssessment({ c, s }: { c: Case; s: FiState }) {
  const m = s.manual;
  if (!m?.required) return null;
  const approved = m.exceptions.find((e) => e.status === "APPROVED");
  const pending = m.exceptions.find((e) => e.status === "REQUESTED");
  const evidence = c.documents.filter((d) => !d.superseded_at && d.scan_status === "CLEAN" && ["EXCEPTION_EVIDENCE", "SUPPORTING", "CREDIT_REPORT"].includes(d.category)).map((d) => ({ id: d.id, filename: d.filename }));
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Manual Financial Assessment</h2>
      {approved ? (
        <p className="small" style={{ margin: 0 }}>
          <span className="badge badge-blue">Approved exception</span> Record the final assessment manually; it is labelled Manual Financial Assessment and the 30% DSR still applies. Decision: {approved.decision_note}
        </p>
      ) : pending ? (
        <p className="small" style={{ margin: 0 }}>
          <span className="badge badge-warn">Awaiting decision</span> Requested {formatLagos(pending.requested_at)}: {pending.reason}
        </p>
      ) : !m.approverRole ? (
        <p className="small muted" style={{ margin: 0 }}>
          This product requires Automatic Statement Analysis and does not permit a manual exception. The application stays pending assessment until the analysis completes.
        </p>
      ) : s.isAnalyst ? (
        <>
          <p className="small muted" style={{ margin: 0 }}>
            Use only when Automatic Statement Analysis cannot be completed (for example Periculum is unavailable). The configured authority decides. Automation remains the default.
          </p>
          <ManualAssessmentRequest applicationId={c.app.id} evidence={evidence} />
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          Automatic Statement Analysis is required for this product before credit approval.
        </p>
      )}
    </div>
  );
}

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
export async function FinancialIntelligenceTab({ c, s, link }: { c: Case; s: FiState; link: Link }) {
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
        <StatementsOnFile c={c} />
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
        {s.isAnalyst && <ManualAssessment c={c} s={s} />}
        <ReviewHistory rows={s.reviews ?? []} />
      </div>
    );
  }

  if (!s.detail)
    return (
      <div className="stack">
        <StaleBanner s={s} />
        <InitiatorSummary s={s} />
      </div>
    );

  const running = IN_FLIGHT.has(a.status);
  const done = s.statements.filter((x) => ["PROCESSED", "REUSED", "DUPLICATE"].includes(x.status)).length;
  const retryable = s.statements.filter((x) => (x.status === "FAILED" || x.status === "REQUIRES_VERIFICATION") && !["ALTERED", "FILE_LIMIT", "UNSUPPORTED_FILE", "SUBMITTED_KEY_UNKNOWN"].includes(x.error_category ?? ""));
  const exceptions = [...(s.intelligence?.exceptions ?? []), ...(s.recommendation?.policyFlags ?? [])];
  const r = s.recommendation;

  const showReport = !!(s.risk && r && !running);
  return (
    <div className="stack">
      <SourceBanner a={a} />
      <StaleBanner s={s} />
      {showReport && <RiskReportView c={c} a={a} s={s} r={r!} risk={s.risk!} link={link} canRerun={s.isAnalyst && ready.ready} />}
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0 }}>{showReport ? "Analysis status" : "Automatic Statement Analysis"}</h2>
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
          <details id="run-again">
            <summary className="small" style={{ cursor: "pointer" }}>
              Run the analysis again
            </summary>
            <p className="small muted">New or replaced statements are picked up automatically. Statements already processed are reused, so Periculum is not charged twice.</p>
            <StartAnalysis applicationId={c.app.id} docs={docs} rerun />
          </details>
        )}
      </div>

      {r && !showReport && <PrimarySummary r={r} />}
      <ReviewHistory rows={s.reviews ?? []} />
      <ReportsAndVersions s={s} link={link} />
      {s.isAnalyst && (a.status !== "COMPLETED" || s.freshness?.current === false || !ready.ready) && <ManualAssessment c={c} s={s} />}

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
      {s.intelligence && s.intelligence.months.length > 1 && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Monthly trend</h2>
          <TrendChart fi={s.intelligence} />
        </div>
      )}
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
          {s.detail && s.risk && (
            <>
              {" "}
              <span className={`badge ${GRADE_BADGE[s.risk.grade]}`}>{s.risk.gradeLabel}</span>
            </>
          )}
          {s.detail && r?.dsr.percent && <span className="muted"> · DSR {r.dsr.percent}%</span>}
          {s.freshness?.current === false && (
            <>
              {" "}
              <span className="badge badge-warn">Requires refresh</span>
            </>
          )}
        </p>
      )}
      <Link className="btn btn-sm" href={href}>
        {a ? "View Statement Analysis" : s.isAnalyst ? "Automatic Statement Analysis" : "View financial intelligence"}
      </Link>
    </div>
  );
}

/** Verified figures for the final assessment form (credit reviewer confirms or adjusts). Null when there is nothing usable. */
export function verifiedDefaults(s: FiState) {
  const a = s.analysis;
  const r = s.recommendation;
  const fi = s.intelligence;
  if (!a || !r || !fi || a.status !== "COMPLETED" || r.income.monthlyKobo === null || s.freshness?.current === false) return null;
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
