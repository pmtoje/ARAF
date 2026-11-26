import { redirect } from "next/navigation";
import { requireUser } from "../../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { config } from "@/server/config";
import { formatLagos } from "@/server/time";
import { formatNaira } from "@/lib/altphones";
import { actionLabel, availableActions, getCase, PWA_STAGE_LABELS, type PwaAction, type PwaStage } from "@/server/paywitharaf/cases";
import { PWA_VIEW_ROLES } from "@/server/paywitharaf/roles";
import { CaseActions, RetryCallbacks } from "./CaseActions";

export const metadata = { title: "Pay with ARAF application" };

const PLACEHOLDERS: Partial<Record<PwaAction, string>> = {
  REQUEST_INFO: "What the customer must provide (shown to the customer in the checkout)",
  REJECT: "Reason for rejection (internal; the customer is told the financing was declined)",
  RECOMMEND_APPROVAL: "Recommendation summary",
  APPROVE: "Approval note",
};

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
// Pay with ARAF's sandbox redacts some fields before sending; show that plainly.
const txt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v).startsWith("[REDACTED") ? "Withheld (sandbox data)" : String(v));
const RULES: Record<string, string> = {
  TOTAL_OBLIGATIONS_MAX_33_3PCT_OF_MONTHLY_SALARY: "All repayments ≤ 33.3% of monthly salary",
  TOTAL_OBLIGATIONS_MAX_10PCT_OF_MONTHLY_TURNOVER: "All repayments ≤ 10% of monthly turnover",
};
const pct = (bps: unknown) => (typeof bps === "number" ? `${(bps / 100).toFixed(2)}% per annum` : "—");

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <table className="kv">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function PayWithArafCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, roles, session } = await requireUser();
  if (!config.payWithAraf.enabled || !roles.some((r) => PWA_VIEW_ROLES.includes(r))) redirect("/forbidden");
  const { case: c, submission, events, reports, callbacks } = await getCase(ctx, id);
  const s = o(submission);
  const cust = o(s.customer);
  const fin = o(s.financing);
  const seed = o(s.seedfi_assessment);
  const peri = o(s.periculum_analysis);
  const aff = o(s.affordability);
  const actions = availableActions(c, session.staffId, roles).map((a) => ({ action: a, label: actionLabel(a), placeholder: PLACEHOLDERS[a] ?? "Note (required)" }));
  const dead = callbacks.filter((x) => x.status === "DEAD").length;
  return (
    <>
      <PageHeader eyebrow="Pay with ARAF" crumbs={[{ href: "/pay-with-araf", label: "Checkout applications" }, { label: c.ref }]} title={`${c.ref} · ${c.customer_name}`} intro={`${PWA_STAGE_LABELS[c.stage as PwaStage]} — ${c.partner_name ?? c.partner_code} order ${c.merchant_order_ref} (Pay with ARAF ${c.pwa_reference})`} />
      <div className="grid-2">
        <section className="card">
          <h2>Financing</h2>
          <Facts
            rows={[
              ["Purchase price", formatNaira(c.purchase_kobo)],
              ["Customer equity (paid to merchant)", formatNaira(c.equity_kobo)],
              ["Financed by the Bank", formatNaira(c.financing_kobo)],
              ["Profit rate", pct(fin.annual_profit_rate_bps)],
              ["Deferred sale price", formatNaira(c.deferred_sale_kobo)],
              ["Monthly instalment", formatNaira(c.monthly_kobo)],
              ["Tenor", c.tenor_months ? `${c.tenor_months} months` : "—"],
            ]}
          />
        </section>
        <section className="card">
          <h2>Customer and checks</h2>
          <Facts
            rows={[
              ["Customer", c.customer_name],
              ["Merchant", `${c.partner_name ?? c.partner_code} · order ${c.merchant_order_ref}`],
              ["BVN", txt(cust.verified_bvn)],
              ["Income profile", txt(c.income_profile)],
              ["SeedFi", seed.reference ? `${txt(seed.band)} band · obligations ${formatNaira(seed.bureau_monthly_obligations_kobo as string)} / month` : "Not provided"],
              ["Periculum", peri.reference ? `Average inflow ${formatNaira(peri.average_inflow_kobo as string)} · ${txt(peri.statement_quality)}` : "Not provided"],
              ["Affordability rule", RULES[String(aff.repayment_ceiling)] ?? txt(aff.repayment_ceiling)],
              ["Repayment capacity", formatNaira(aff.capacity_kobo as string)],
            ]}
          />
        </section>
      </div>
      <section className="card">
        <h2>Decision</h2>
        {c.recommended_by && c.stage === "APPROVAL" && <p className="muted small">Approval must come from a Credit Lead or the Unit Head who did not recommend it.</p>}
        <CaseActions caseId={c.id} lockVersion={c.lock_version} actions={actions} />
      </section>
      <section className="card">
        <h2>History</h2>
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <strong>{String(e.action).replaceAll("_", " ").toLowerCase()}</strong> — {e.actor_name}
              {e.actor_role ? ` (${e.actor_role})` : ""} · {formatLagos(e.created_at)}
              {e.note && <div className="muted">{e.note}</div>}
            </li>
          ))}
        </ol>
      </section>
      <div className="grid-2">
        <section className="card">
          <h2>Execution reports from Pay with ARAF</h2>
          {reports.length === 0 ? (
            <p className="muted">None yet. Booking, vendor payment, release and delivery appear here after approval.</p>
          ) : (
            <ul>
              {reports.map((r) => (
                <li key={r.id}>
                  {String(r.type).replaceAll("_", " ").toLowerCase()} · {formatLagos(r.occurred_at)}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>Updates sent to Pay with ARAF</h2>
          {callbacks.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul>
              {callbacks.map((x) => (
                <li key={x.id}>
                  #{x.sequence} {String(x.stage ?? "")} — {x.status.toLowerCase()}
                  {x.attempts > 1 ? ` after ${x.attempts} attempts` : ""}
                  {x.last_error && x.status !== "SENT" ? <span className="muted"> ({x.last_error})</span> : null}
                </li>
              ))}
            </ul>
          )}
          {dead > 0 && roles.includes("SUPER_ADMIN") && <RetryCallbacks caseId={c.id} />}
        </section>
      </div>
    </>
  );
}
