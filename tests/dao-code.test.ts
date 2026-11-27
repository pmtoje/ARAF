import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { ctxFor } from "@/server/demo/scenario";
import { applyConfig, syntheticConfig } from "@/server/demo/retail-scenario";
import { createRetailDraft, retailReadiness } from "@/server/domain/retail";
import { createDraft } from "@/server/domain/workflow";
import { normaliseDaoCode } from "@/lib/dao";

const RM = "rm.bola@altbank.ng";
beforeEach(async () => {
  await resetDb();
  await applyConfig("VENDOR_FINANCING", syntheticConfig("VENDOR_FINANCING"));
});

describe("DAO code at the start of a request", () => {
  it("normalises and validates the code", () => {
    expect(normaliseDaoCode(" dao-1001 ")).toBe("DAO-1001");
    expect(normaliseDaoCode("AB/12")).toBe("AB/12");
    expect(normaliseDaoCode("")).toBeNull();
    expect(normaliseDaoCode("x")).toBeNull();
    expect(normaliseDaoCode("DAO 1001")).toBe("DAO1001");
    expect(normaliseDaoCode("<script>")).toBeNull();
  });

  it("a retail request cannot be started without it, and keeps it in the draft", async () => {
    const ctx = await ctxFor(RM);
    const base = { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE" as const };
    await expect(createRetailDraft(ctx, base)).rejects.toMatchObject({ code: "VALIDATION", fields: { daoCode: expect.any(String) } });
    const { id } = await createRetailDraft(ctx, { ...base, daoCode: "dao-77" });
    const data = (await db.query("SELECT v.data FROM applications a JOIN application_versions v ON v.application_id = a.id WHERE a.id = $1", [id])).rows[0].data;
    expect(data.daoCode).toBe("DAO-77");
  });

  it("submission is blocked if the DAO code is cleared from the draft", async () => {
    const ctx = await ctxFor(RM);
    const { id } = await createRetailDraft(ctx, { initiatorRole: "RM", productCode: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", applicantType: "ENTERPRISE", daoCode: "DAO-77" });
    expect((await retailReadiness(db, id, new Date())).fieldErrors.daoCode).toBeUndefined();
    await db.query("UPDATE application_versions SET data = jsonb_set(data, '{daoCode}', '\"\"') WHERE application_id = $1", [id]);
    expect((await retailReadiness(db, id, new Date())).fieldErrors.daoCode).toBe("DAO code is required.");
  });

  it("a WakeelBoost request needs it too", async () => {
    const ctx = await ctxFor("rm.ade@altbank.ng");
    await expect(createDraft(ctx, { initiatorRole: "RM", applicantType: "INDIVIDUAL" })).rejects.toMatchObject({ code: "VALIDATION" });
    const { id } = await createDraft(ctx, { initiatorRole: "RM", applicantType: "INDIVIDUAL", daoCode: "DAO-9" });
    expect((await db.query("SELECT v.data->>'daoCode' AS d FROM application_versions v WHERE v.application_id = $1", [id])).rows[0].d).toBe("DAO-9");
  });
});
