"use server";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { actOnCase, actionLabel, retryDeadCallbacks, PWA_ACTIONS, type PwaAction } from "@/server/paywitharaf/cases";
import { invalid } from "@/server/errors";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function pwaCaseAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const action = s(fd, "action") as PwaAction;
    if (!PWA_ACTIONS.includes(action)) throw invalid("Unknown action.");
    await actOnCase(ctx, { caseId: s(fd, "caseId"), action, note: s(fd, "reason"), lockVersion: Number(s(fd, "lockVersion")) });
    return { ok: true, message: `${actionLabel(action)}: done.`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function pwaRetryCallbacksAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const n = await retryDeadCallbacks(ctx, s(fd, "caseId"));
    return { ok: true, message: n ? `${n} update${n === 1 ? "" : "s"} queued for Pay with ARAF.` : "Nothing to send again.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
