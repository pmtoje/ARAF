import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { periculumSettingsView } from "@/server/integrations/periculum/settings";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { CredentialsForm, TestSignIn } from "./Forms";
import { fiMonitoring } from "@/server/domain/fi-monitoring";
import { config } from "@/server/config";

export const metadata = { title: "Financial Intelligence" };

/** Super Admin: Periculum API credentials (the secret is write-only) and a free sign-in test. */
export default async function PericulumSettingsPage() {
  await requireSuperAdmin();
  const v = await periculumSettingsView(db);
  const m = await fiMonitoring(db, 30);
  const n = (x: number) => x.toLocaleString("en-NG");
  const s = v.saved;
  return (
    <>
      <PageHeader
        crumbs={[{ href: "/admin", label: "Administration" }, { label: "Financial Intelligence" }]}
        eyebrow="Administration · Integrations"
        title="Financial Intelligence"
        intro="Periculum connection, integration monitoring and usage for Automatic Statement Analysis. The API credentials ARAF uses come from the bank's Insights portal (Settings → API Credentials). Copy them from the bank's Insights portal (Settings → API Credentials). The secret is stored encrypted and is never displayed again."
      />
      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card stack" aria-labelledby="h-cred">
          <h2 id="h-cred" style={{ margin: 0 }}>
            Credentials
          </h2>
          <CredentialsForm v={{ clientId: s?.client_id ?? "", baseUrl: s?.base_url ?? v.defaults.baseUrl, authUrl: s?.auth_url ?? v.defaults.authUrl, hasSecret: !!s }} />
        </section>
        <div className="stack">
          <section className="card stack" aria-labelledby="h-status">
            <h2 id="h-status" style={{ margin: 0 }}>
              Status
            </h2>
            <table className="kv">
              <tbody>
                <tr>
                  <th>Credentials</th>
                  <td>
                    {s ? (
                      <>
                        Saved {formatLagos(s.updated_at)}
                        {s.updated_by_name ? ` by ${s.updated_by_name}` : ""}
                      </>
                    ) : v.environmentHasCredentials ? (
                      "From the server environment"
                    ) : (
                      <span className="err">Not set</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Last sign-in test</th>
                  <td>
                    {s?.last_test_at ? (
                      <>
                        <span className={`badge ${s.last_test_ok ? "badge-green" : "badge-red"}`}>{s.last_test_ok ? "Signed in" : "Failed"}</span> {formatLagos(s.last_test_at)}
                        <div className="small">{s.last_test_message}</div>
                      </>
                    ) : (
                      "Not tested"
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Statement analysis</th>
                  <td>{v.enabled ? (v.mode === "fixture" ? "On (labelled test data)" : "On") : "Off: switched on by the server setting PERICULUM_ENABLED after approvals"}</td>
                </tr>
                <tr>
                  <th>Blacklist Search</th>
                  <td>{v.blacklistEnabled ? "On" : "Off"}</td>
                </tr>
              </tbody>
            </table>
            <TestSignIn disabled={!s && !v.environmentHasCredentials} />
          </section>
        </div>
      </div>
      <div className="grid-2" style={{ alignItems: "start", marginTop: 16 }}>
        <section className="card stack" aria-labelledby="h-mon">
          <h2 id="h-mon" style={{ margin: 0 }}>
            Integration monitoring
          </h2>
          <table className="kv">
            <tbody>
              <tr>
                <th>Configured environment</th>
                <td>
                  {config.periculum.environment}
                  {v.mode === "fixture" ? " · labelled test data" : ""}
                </td>
              </tr>
              <tr>
                <th>Last successful request</th>
                <td>{m.lastSuccessAt ? formatLagos(m.lastSuccessAt) : "None yet"}</td>
              </tr>
              <tr>
                <th>Last failed request</th>
                <td>{m.lastFailureAt ? formatLagos(m.lastFailureAt) : "None"}</td>
              </tr>
              <tr>
                <th>Pending processing</th>
                <td>
                  {n(m.runningAnalyses)} analyses · {n(m.pendingStatements)} statements
                </td>
              </tr>
              <tr>
                <th>Analyses (30 days)</th>
                <td>
                  {Object.keys(m.analyses).length
                    ? Object.entries(m.analyses)
                        .map(([k, x]) => `${k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, " ")} ${n(x)}`)
                        .join(" · ")
                    : "None"}
                </td>
              </tr>
              <tr>
                <th>Turnaround (completed)</th>
                <td>{m.turnaround.sample ? `median ${m.turnaround.medianMinutes} min · 90% within ${m.turnaround.p90Minutes} min (${n(m.turnaround.sample)} analyses)` : "No completed analyses yet"}</td>
              </tr>
              <tr>
                <th>Error categories</th>
                <td>{m.errorCategories.length ? m.errorCategories.map((e) => `${e.category} ${n(e.count)}`).join(" · ") : "None"}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section className="card stack" aria-labelledby="h-use">
          <h2 id="h-use" style={{ margin: 0 }}>
            Usage (30 days)
          </h2>
          <table className="kv">
            <tbody>
              <tr>
                <th>Analysis requests</th>
                <td>{n(m.usage.analysisRequests)}</td>
              </tr>
              <tr>
                <th>Statements processed</th>
                <td>{n(m.usage.statementsProcessed)}</td>
              </tr>
              <tr>
                <th>API requests</th>
                <td>
                  {n(m.usage.apiSuccess)} successful · {n(m.usage.apiFailed)} failed{m.usage.apiAmbiguous ? ` · ${n(m.usage.apiAmbiguous)} reconciled after an unclear outcome` : ""}
                </td>
              </tr>
              <tr>
                <th>Statement submissions (billable)</th>
                <td>{n(m.usage.billableSubmissions)}</td>
              </tr>
              <tr>
                <th>Duplicate files not sent</th>
                <td>{n(m.usage.duplicatesPrevented)}</td>
              </tr>
              <tr>
                <th>Earlier results reused</th>
                <td>{n(m.usage.reused)}</td>
              </tr>
              <tr>
                <th>API charges</th>
                <td className="muted">Not shown: Periculum&apos;s commercial pricing has not been confirmed in ARAF.</td>
              </tr>
              {m.bySource.some((x) => x.source === "FIXTURE") && (
                <tr>
                  <th>Test data</th>
                  <td>{n(m.bySource.find((x) => x.source === "FIXTURE")!.analyses)} analyses used the labelled simulated service</td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="small muted" style={{ margin: 0 }}>
            Which products require analysis, the manual exception authority and statement coverage are set per product in Product Settings, with the usual approval and version history. The approved income DSR is 30%.
          </p>
        </section>
      </div>
    </>
  );
}
