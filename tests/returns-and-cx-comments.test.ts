import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { act, ctxFor, openTaskOf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, recordFinal, syntheticConfig } from "@/server/demo/retail-scenario";
import { markReturnPromptsSeen, pendingReturnPrompts } from "@/server/domain/return-prompts";

const N = (n: number) => n * 100;
const CX_NOTE = "CX review: eligibility, documents and DSR verified.";
const MGMT = { reason: "Analysis verified; certified for credit.", visitComments: "Management visit completed; business operating as described.", rmPhotoConfirmed: true };

async function addStaff(email: string, name: string, role: string) {
  const id = (await db.query("INSERT INTO staff (email, full_name, region, business_unit, status) VALUES ($1,$2,'LAGOS','Credit','ACTIVE') RETURNING id", [email, name])).rows[0].id;
  await db.query("INSERT INTO role_assignments (staff_id, role, active) VALUES ($1,$2,true)", [id, role]);
  return id as string;
}
const sid = async (email: string) => (await db.query("SELECT id FROM staff WHERE email = $1", [email])).rows[0].id as string;
const config = (policy: "RETAIL_CX_V1" | "STANDARD") =>
  applyConfig(
    "VENDOR_FINANCING",
    syntheticConfig("VENDOR_FINANCING", (c) => {
      c.approvalPolicy = policy;
      for (const r of Object.values(c.profiles)) {
        if (!r) continue;
        r.dsr.maxPercent = "30";
        r.minTenorMonths = 12;
        r.maxTenorMonths = 36;
      }
    }),
  );
const vfCase = (channel: "RM" | "TL") => createRetailCase({ channel, product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", amountKobo: N(2_000_000), tenorMonths: 12, incomeBasisKobo: N(10_000_000), proposedMonthlyKobo: N(200_000) });

beforeEach(async () => {
  await resetDb();
});

describe("one-time return prompt", () => {
  it("is shown once to the holder of the correction task and only they can mark it seen", async () => {
    await config("RETAIL_CX_V1");
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    const id = await vfCase("TL");
    await act(id, "RETURN", { reason: "Add the latest bank statement page." });
    const holder = await openTaskOf(id);
    expect(holder.stage).toBe("INITIATOR_CORRECTION");

    const prompts = await pendingReturnPrompts(db, holder.assignee_id!);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ applicationId: id, returnedBy: "Ada CX-Reviewer", reason: "Add the latest bank statement page.", fromStage: "CX credit review" });

    // Nobody else sees it, and nobody else can dismiss it.
    const cxId = await sid("cx.one@altbank.ng");
    expect(await pendingReturnPrompts(db, cxId)).toHaveLength(0);
    expect(await markReturnPromptsSeen(await ctxFor("cx.one@altbank.ng"), [prompts[0].correctionId])).toBe(0);
    expect(await pendingReturnPrompts(db, holder.assignee_id!)).toHaveLength(1);

    // The holder closes it once; it does not come back.
    expect(await markReturnPromptsSeen(await ctxFor(holder.email!), [prompts[0].correctionId])).toBe(1);
    expect(await pendingReturnPrompts(db, holder.assignee_id!)).toHaveLength(0);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE application_id = $1 AND action = 'RETURN_PROMPT_SEEN'", [id]);
    expect(audit.rowCount).toBe(1);

    // After resubmission the prompt is gone for good; a second return prompts again.
    await act(id, "RESUBMIT");
    expect(await pendingReturnPrompts(db, holder.assignee_id!)).toHaveLength(0);
    await act(id, "RETURN", { reason: "The statement page is still missing." });
    const again = await pendingReturnPrompts(db, holder.assignee_id!);
    expect(again.map((p) => p.reason)).toEqual(["The statement page is still missing."]);
  });
});

describe("returned requests go back to the reviewer who returned them", () => {
  it("CX policy: with two CX reviewers, resubmission returns to the one who treated it", async () => {
    await config("RETAIL_CX_V1");
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    await addStaff("cx.two@altbank.ng", "Tunde CX-Reviewer", "CX_CREDIT_REVIEWER");
    for (let i = 0; i < 3; i++) {
      const id = await vfCase("TL");
      const returner = (await openTaskOf(id)).email!;
      await act(id, "RETURN", { reason: "Add the latest bank statement page." });
      await act(id, "RESUBMIT");
      const back = await openTaskOf(id);
      expect(back.stage).toBe("FIRST_CREDIT_REVIEW");
      expect(back.email).toBe(returner);
    }
  });
});

describe("CX review comment on approval", () => {
  it("is required, and is recorded with the decision for the approvers who follow", async () => {
    await config("RETAIL_CX_V1");
    await addStaff("cx.one@altbank.ng", "Ada CX-Reviewer", "CX_CREDIT_REVIEWER");
    const id = await vfCase("RM");
    await act(id, "RECOMMEND", MGMT);
    expect((await openTaskOf(id)).assignee_role).toBe("CX_CREDIT_REVIEWER");
    await recordFinal(id);
    await expect(act(id, "APPROVE", {})).rejects.toThrow(/CX review comment/);
    await expect(act(id, "APPROVE", { reason: "ok" })).rejects.toThrow(/CX review comment/);
    expect((await openTaskOf(id)).stage).toBe("FIRST_CREDIT_REVIEW");
    await act(id, "APPROVE", { reason: CX_NOTE });
    expect((await openTaskOf(id)).stage).toBe("UNIT_HEAD_REVIEW");
    const d = (await db.query("SELECT reason, actor_role FROM decisions WHERE application_id = $1 AND action = 'APPROVE' AND stage = 'FIRST_CREDIT_REVIEW'", [id])).rows[0];
    expect(d).toMatchObject({ reason: CX_NOTE, actor_role: "CX_CREDIT_REVIEWER" });
  });
});
