"use client";
import { ActionForm, ReasonAction, SubmitButton } from "@/components/forms";
import { pwaCaseAction, pwaRetryCallbacksAction } from "../actions";

const DANGER = new Set(["REJECT"]);

export function CaseActions({ caseId, lockVersion, actions }: { caseId: string; lockVersion: number; actions: { action: string; label: string; placeholder: string }[] }) {
  if (actions.length === 0) return <p className="muted">No action is open to you at this stage.</p>;
  return (
    <div className="stack">
      {actions.map((a) => (
        <ReasonAction
          key={a.action}
          action={pwaCaseAction}
          hidden={{ caseId, action: a.action, lockVersion: String(lockVersion) }}
          label={a.label}
          danger={DANGER.has(a.action)}
          placeholder={a.placeholder}
        />
      ))}
    </div>
  );
}

export function RetryCallbacks({ caseId }: { caseId: string }) {
  return (
    <ActionForm action={pwaRetryCallbacksAction}>
      <input type="hidden" name="caseId" value={caseId} />
      <SubmitButton className="btn btn-dark">Send the undelivered updates to Pay with ARAF again</SubmitButton>
    </ActionForm>
  );
}
