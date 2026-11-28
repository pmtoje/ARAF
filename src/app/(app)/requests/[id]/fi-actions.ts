"use server";
import { requireUser } from "../../../_lib/auth";
import { toActionError, type ActionState } from "../../../_lib/action";
import { CREDIT_DETAIL_ROLES, retryStatements, startStatementAnalysis } from "@/server/domain/statement-analysis";
import { whatIf } from "@/server/domain/credit-recommendation";
import { getCase } from "@/server/domain/views";
import { db } from "@/server/db";
import { forbidden, invalid, notFound } from "@/server/errors";
import { parseNairaToKobo } from "@/server/money";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** PDF passwords arrive as pw_<documentId>; blanks are dropped. Never logged or echoed back. */
function passwords(fd: FormData) {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (k.startsWith("pw_") && typeof v === "string" && v.trim()) out[k.slice(3)] = v;
  return out;
}

export async function startAnalysisAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await startStatementAnalysis(ctx, str(fd, "applicationId"), { reason: str(fd, "reason") || null, passwords: passwords(fd) });
    const message = r.alreadyRunning
      ? "An analysis is already running for these statements."
      : r.reused
        ? "These statements were already analysed; the existing result is shown. Give a reason to re-analyse them."
        : `Automatic Statement Analysis started (version ${r.version}).`;
    return { ok: true, message, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function retryAnalysisAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await retryStatements(ctx, str(fd, "analysisId"), { reason: str(fd, "reason"), passwords: passwords(fd) });
    return { ok: true, message: "The statements are being resubmitted.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

/** Recalculates the recommendation for another amount or tenor. Read-only: nothing is saved and Periculum is not called. */
export async function whatIfAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx, roles } = await requireUser();
  try {
    if (!roles.some((r) => CREDIT_DETAIL_ROLES.includes(r))) throw forbidden("What-if is available to the credit team.");
    const analysisId = str(fd, "analysisId");
    if (!/^[0-9a-f-]{36}$/.test(analysisId)) throw notFound("Analysis not found.");
    const a = (await db.query<{ application_id: string }>("SELECT application_id FROM fi_analyses WHERE id = $1", [analysisId])).rows[0];
    if (!a) throw notFound("Analysis not found.");
    await getCase(ctx, a.application_id); // the same access rule as the request itself
    const fields: Record<string, string> = {};
    const principalRaw = str(fd, "principal");
    const principal = principalRaw ? parseNairaToKobo(principalRaw) : null;
    if (principalRaw && (principal === null || principal <= 0)) fields.principal = "Enter a naira amount greater than zero.";
    const tenorRaw = str(fd, "tenor");
    const tenor = tenorRaw ? Number.parseInt(tenorRaw, 10) : null;
    if (tenorRaw && (!Number.isInteger(tenor) || tenor! < 1 || tenor! > 120 || String(tenor) !== tenorRaw)) fields.tenor = "Enter a whole number of months.";
    if (Object.keys(fields).length) throw invalid("Check the scenario.", fields);
    const r = await whatIf(db, analysisId, ctx.now, { principalKobo: principal ?? undefined, tenorMonths: tenor ?? undefined });
    if (!r) throw invalid("The analysis has no verified figures to recalculate.");
    return { ok: true, data: r, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
