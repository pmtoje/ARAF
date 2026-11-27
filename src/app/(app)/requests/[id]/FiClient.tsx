"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { AmountInput } from "@/components/inputs";
import { retryAnalysisAction, startAnalysisAction, whatIfAction } from "./fi-actions";
import type { Recommendation } from "@/server/domain/credit-recommendation";

const naira = (k: number | null | undefined) =>
  k === null || k === undefined ? "—" : `₦${(k / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Refreshes the server-rendered report while Periculum is still processing (stops when the page is hidden). */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

type Doc = { id: string; filename: string };

function PasswordFields({ docs, prefix }: { docs: Doc[]; prefix: string }) {
  const [open, setOpen] = useState(false);
  if (!docs.length) return null;
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="small" style={{ cursor: "pointer" }}>
        Password-protected statements
      </summary>
      <div className="stack" style={{ marginTop: 8 }}>
        {docs.map((d) => (
          <div className="field" key={d.id}>
            <label htmlFor={`${prefix}-${d.id}`}>{d.filename}</label>
            <input id={`${prefix}-${d.id}`} name={`pw_${d.id}`} type="password" autoComplete="off" placeholder="Leave blank if the file is not protected" />
          </div>
        ))}
        <span className="hint">Passwords are encrypted, sent only to Periculum with the file, and cleared once it is accepted.</span>
      </div>
    </details>
  );
}

/** The one-click Automatic Statement Analysis (assigned credit reviewer only). */
export function StartAnalysis({ applicationId, docs, rerun }: { applicationId: string; docs: Doc[]; rerun: boolean }) {
  return (
    <ActionForm action={startAnalysisAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <PasswordFields docs={docs} prefix="pw-start" />
      {rerun && (
        <div className="field">
          <label htmlFor="fi-rerun">Reason to re-analyse</label>
          <input id="fi-rerun" name="reason" placeholder="Required only if the statements have not changed" />
        </div>
      )}
      <div>
        <SubmitButton className="btn btn-dark">{rerun ? "Run analysis again" : "Run Automatic Statement Analysis"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function RetryStatements({ analysisId, docs }: { analysisId: string; docs: Doc[] }) {
  return (
    <ActionForm action={retryAnalysisAction} resetOnSuccess>
      <input type="hidden" name="analysisId" value={analysisId} />
      <PasswordFields docs={docs} prefix="pw-retry" />
      <div className="field">
        <label htmlFor="fi-retry">Reason for the retry</label>
        <input id="fi-retry" name="reason" required minLength={5} placeholder="e.g. customer supplied the PDF password" />
      </div>
      <div>
        <SubmitButton className="btn">Retry the failed statements</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** What-if: another amount or tenor against the same verified figures. Nothing is saved. */
export function WhatIf({ analysisId, principal, tenor }: { analysisId: string; principal: string; tenor: string }) {
  const [amount, setAmount] = useState(principal);
  return (
    <ActionForm action={whatIfAction} refreshOnSuccess={false} showMessages={false}>
      {(state) => {
        const r = state.ok ? (state.data as Recommendation | undefined) : undefined;
        return (
          <>
            <input type="hidden" name="analysisId" value={analysisId} />
            <input type="hidden" name="principal" value={amount} />
            <div className="grid-2">
              <div className="field">
                <label htmlFor="wi-amount">Amount</label>
                <AmountInput id="wi-amount" value={amount} onChange={setAmount} />
              </div>
              <div className="field">
                <label htmlFor="wi-tenor">Tenor (months)</label>
                <input id="wi-tenor" name="tenor" inputMode="numeric" defaultValue={tenor} />
              </div>
            </div>
            <div>
              <SubmitButton className="btn btn-sm">Recalculate</SubmitButton>
            </div>
            {state.error && (
              <div role="alert" className="alert alert-error">
                {state.error}
                {state.fields && (
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {Object.values(state.fields).map((v) => (
                      <li key={v}>{v}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {r && (
              <div role="status" className="card" style={{ background: "var(--surface-2, transparent)" }}>
                <p className="small" style={{ margin: 0 }}>
                  <strong>{r.outcomeLabel}</strong> · repayment {naira(r.proposedMonthlyKobo)} a month · DSR {r.dsr.percent ? `${r.dsr.percent}%` : "—"} (limit {r.dsr.thresholdPercent ?? "—"}%)
                </p>
                <p className="small muted" style={{ margin: "4px 0 0" }}>
                  Maximum supported over {r.requested.tenorMonths ?? "—"} months: {naira(r.maxEligiblePrincipalKobo)}. Scenario only; nothing was saved.
                </p>
              </div>
            )}
          </>
        );
      }}
    </ActionForm>
  );
}
