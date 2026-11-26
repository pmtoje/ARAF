import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { PageHeader } from "@/components/PageHeader";
import { db } from "@/server/db";
import { config } from "@/server/config";
import { formatLagos } from "@/server/time";
import { formatNaira } from "@/lib/altphones";
import { listCases, PWA_STAGE_LABELS, PWA_STAGES, type PwaStage } from "@/server/paywitharaf/cases";
import { PWA_VIEW_ROLES } from "@/server/paywitharaf/roles";

export const metadata = { title: "Pay with ARAF applications" };

export default async function PayWithArafQueue({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { roles } = await requireUser();
  if (!config.payWithAraf.enabled || !roles.some((r) => PWA_VIEW_ROLES.includes(r))) redirect("/forbidden");
  const rows = await listCases(db, { stage: sp.stage ?? null });
  return (
    <>
      <PageHeader
        eyebrow="Pay with ARAF"
        title="Checkout financing applications"
        intro="Applications sent by Pay with ARAF from merchant checkouts. SeedFi and Periculum checks and affordability were run before submission; review, ask the customer for information, recommend and approve here. Decisions go back to Pay with ARAF automatically."
      />
      <nav className="tabs" aria-label="Filter by stage">
        <Link className="tab" href="/pay-with-araf" aria-current={!sp.stage ? "page" : undefined}>
          All (open first)
        </Link>
        {PWA_STAGES.map((st) => (
          <Link key={st} className="tab" href={`/pay-with-araf?stage=${st}`} aria-current={sp.stage === st ? "page" : undefined}>
            {PWA_STAGE_LABELS[st]}
          </Link>
        ))}
      </nav>
      <section className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ARAF reference</th>
                <th>Customer</th>
                <th>Merchant</th>
                <th className="num">Financed</th>
                <th>Tenor</th>
                <th>Stage</th>
                <th>Execution</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No applications{sp.stage ? " at this stage" : ""}.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/pay-with-araf/${r.id}`}>{r.ref}</Link>
                    <div className="muted small">{r.pwa_reference}</div>
                  </td>
                  <td>{r.customer_name}</td>
                  <td>{r.partner_name ?? r.partner_code}</td>
                  <td className="num">{formatNaira(r.financing_kobo)}</td>
                  <td>{r.tenor_months ? `${r.tenor_months} months` : "—"}</td>
                  <td>
                    <span className="badge">{PWA_STAGE_LABELS[r.stage as PwaStage]}</span>
                    {r.callbacks_dead > 0 && <div className="small" style={{ color: "var(--danger, #b42318)" }}>Update not delivered</div>}
                  </td>
                  <td className="small">{r.execution_status?.replaceAll("_", " ").toLowerCase() ?? "—"}</td>
                  <td className="small">{formatLagos(r.received_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
