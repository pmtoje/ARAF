"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { markReturnPromptsSeenAction } from "./return-prompt-actions";
import { useRubberBand } from "@/components/motion";

export interface ReturnPromptItem {
  correctionId: string;
  applicationId: string;
  ref: string;
  customer: string | null;
  fromStage: string;
  returnedBy: string;
  reason: string;
  returnedAt: string;
}

/**
 * Shown once per return to the person who must rework the request; closing it records that it was seen.
 * One clear next step (open the request, or the queue when there are several) and a quiet "Later" keep the choice small.
 */
export function ReturnPromptDialog({ items }: { items: ReturnPromptItem[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState<string | null>(items.length === 1 ? items[0].correctionId : null);
  useRubberBand(list);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  // Recorded the moment the prompt closes; the user never waits on it.
  const seen = () => void markReturnPromptsSeenAction(items.map((i) => i.correctionId));
  const close = () => ref.current?.close();
  const one = items.length === 1;
  return (
    <dialog ref={ref} className="modal modal-return" aria-labelledby="ret-dlg-title" onClose={seen}>
      <div className="modal-body">
        <p className="eyebrow stage-in" style={{ marginBottom: 4 }}>
          Action needed
        </p>
        <h2 id="ret-dlg-title" className="stage-in">
          {one ? "A request was returned to you for rework" : `${items.length} requests were returned to you for rework`}
        </h2>
        <ul ref={list} className="return-list stage-in">
          {items.map((i) => {
            const expanded = open === i.correctionId;
            return (
              <li key={i.correctionId} className="return-item" data-open={expanded || undefined}>
                <Head one={one} expanded={expanded} controls={`ret-${i.correctionId}`} onToggle={() => setOpen(expanded ? null : i.correctionId)}>
                  <span className="return-title">
                    <strong>{i.ref}</strong>
                    {i.customer ? <span className="muted return-cust">{i.customer}</span> : null}
                    <span className="small muted return-meta">
                      Returned by {i.returnedBy} at {i.fromStage} · {i.returnedAt}
                    </span>
                  </span>
                  {!one && (
                    <span className="icon-swap" aria-hidden="true" data-state={expanded ? "b" : "a"}>
                      <span className="icon-a">+</span>
                      <span className="icon-b">−</span>
                    </span>
                  )}
                </Head>
                <div id={`ret-${i.correctionId}`} className="return-detail" role="region" aria-label={`Reason for ${i.ref}`}>
                  <div>
                    <p className="small" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                      <strong>Reason:</strong> {i.reason}
                    </p>
                    {!one && (
                      <p style={{ margin: "8px 0 0" }}>
                        <Link href={`/requests/${i.applicationId}`} className="btn btn-sm" onClick={close} tabIndex={expanded ? 0 : -1}>
                          Open {i.ref}
                        </Link>
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="small muted stage-in" style={{ margin: "12px 0 0" }}>
          Make the changes and resubmit. It goes back to the reviewer who returned it.
        </p>
      </div>
      <div className="modal-actions modal-actions-reach">
        <button type="button" className="btn btn-ghost" onClick={close}>
          Later
        </button>
        <Link href={one ? `/requests/${items[0].applicationId}` : "/queue"} className="btn btn-primary btn-reach" onClick={close} autoFocus>
          {one ? `Open ${items[0].ref}` : "Open My Action Queue"}
        </Link>
      </div>
    </dialog>
  );
}

/** The single item is simply shown; with several, each heading expands its own card in place. */
function Head({ one, expanded, controls, onToggle, children }: { one: boolean; expanded: boolean; controls: string; onToggle: () => void; children: ReactNode }) {
  if (one) return <div className="return-head">{children}</div>;
  return (
    <button type="button" className="return-head" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      {children}
    </button>
  );
}
