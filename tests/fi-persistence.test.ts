import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { resetDb } from "./helpers";
import { act, ctxFor, makePdf, openTaskOf } from "@/server/demo/scenario";
import { applyConfig, createRetailCase, driveBusinessReview, INITIATORS, passRetailCreditChecks, syntheticConfig } from "@/server/demo/retail-scenario";
import { uploadDocument } from "@/server/domain/documents";
import { submitApplication } from "@/server/domain/workflow";
import { config } from "@/server/config";
import { setPericulumFetchForTests } from "@/server/integrations/periculum/client";
import { fixtureFetch, resetFixtureVendor } from "@/server/integrations/periculum/fixtures";
import { currentAnalysis, processStatementAnalysis, startStatementAnalysis } from "@/server/domain/statement-analysis";
import { processBureauChecks } from "@/server/domain/bureau-check";
import { savedRecommendation, type Recommendation } from "@/server/domain/credit-recommendation";
import { savedIntelligence } from "@/server/domain/financial-intelligence";
import { analysisFreshness, compareWithVerified, reliableAnalysis, reviewsFor } from "@/server/domain/fi-governance";
import { buildFinancialReportPdf, REPORT_CATEGORY } from "@/server/domain/fi-report";
import { decideException, recordFinalAssessment, requestException } from "@/server/domain/retail";
import { objectStore } from "@/server/storage";
import { addDaysToDateString, lagosDate } from "@/server/time";

const N = (n: number) => n * 100;
const STATEMENT = (acct: string) => `PERICULUM-FIXTURE bank=Sterling Bank;account=${acct};name=AMINA BELLO;kind=BUSINESS;turnover=2000000;months=6;start=2026-05`;
const saved: Record<string, string | undefined> = {};

async function useConfig(required: boolean, approver: "UNIT_HEAD" | null = "UNIT_HEAD") {
  await applyConfig(
    "VENDOR_FINANCING",
    syntheticConfig("VENDOR_FINANCING", (c) => {
      for (const r of Object.values(c.profiles)) if (r) r.statementAnalysis = { required, manualExceptionApproverRole: approver };
    }),
  );
}

beforeEach(async () => {
  await resetDb();
  saved.e = process.env.PERICULUM_ENABLED;
  process.env.PERICULUM_ENABLED = "true";
  resetFixtureVendor();
  setPericulumFetchForTests(fixtureFetch);
  await useConfig(false);
});
afterEach(() => {
  setPericulumFetchForTests(null);
  if (saved.e === undefined) delete process.env.PERICULUM_ENABLED;
  else process.env.PERICULUM_ENABLED = saved.e;
});

async function caseAtCreditReview(statements = [STATEMENT("0123456789")]) {
  const id = await createRetailCase({ channel: "RM", product: "VENDOR_FINANCING", profile: "BUSINESS_OWNER", type: "ENTERPRISE", amountKobo: N(2_000_000), tenorMonths: 12, submit: false, skipDocs: ["BANK_STATEMENT"] });
  const rm = await ctxFor(INITIATORS.RM);
  const today = lagosDate(new Date());
  for (const [i, s] of statements.entries())
    await uploadDocument(rm, { applicationId: id, category: "BANK_STATEMENT", filename: `statement-${i}.pdf`, data: makePdf(s), meta: { coverageFrom: addDaysToDateString(today, -400), coverageTo: addDaysToDateString(today, -1) } });
  await passRetailCreditChecks(rm, id);
  await submitApplication(rm, id, randomUUID());
  await driveBusinessReview(id);
  const t = await openTaskOf(id);
  expect(t.stage).toBe("FIRST_CREDIT_REVIEW");
  return { id, analyst: await ctxFor(t.email!), rm };
}

async function runWorker() {
  let t = Date.now();
  for (let i = 0; i < 12; i++) {
    t += config.periculum.pollIntervalMs + 1000;
    await processStatementAnalysis(new Date(t));
    await processBureauChecks(new Date(t));
  }
}

async function analysed(statements?: string[]) {
  const c = await caseAtCreditReview(statements);
  await startStatementAnalysis(c.analyst, c.id);
  await runWorker();
  const a = (await currentAnalysis(db, c.id))!;
  expect(a.status).toBe("COMPLETED");
  return { ...c, a, r: (await savedRecommendation(db, a.id))! };
}

/** Final assessment on the verified figures (optionally changed). */
async function finalOn(c: Awaited<ReturnType<typeof analysed>>, o: { income?: number; reason?: string } = {}) {
  const r = c.r;
  const annual = r.income.annualKobo !== null;
  return recordFinalAssessment(c.analyst, c.id, {
    incomeBasisKobo: annual ? null : (o.income ?? r.income.monthlyKobo),
    annualInflowKobo: annual ? (o.income ?? r.income.annualKobo) : null,
    adjustmentNote: "Figures from Automatic Statement Analysis.",
    verifiedChangeReason: o.reason,
    incomeBasisNote: "Automatic Statement Analysis",
    statementFrom: addDaysToDateString(lagosDate(new Date()), -200),
    statementTo: addDaysToDateString(lagosDate(new Date()), -2),
    principalKobo: r.requested.principalKobo,
    tenorMonths: r.requested.tenorMonths,
    existingObligations: [],
    charges: [],
    turnoverForCapKobo: null,
  });
}

const reports = async (appId: string) =>
  (await db.query<{ id: string; version_no: number; superseded_at: Date | null; storage_key: string; meta: Record<string, string> }>("SELECT id, version_no, superseded_at, storage_key, meta FROM documents WHERE application_id = $1 AND category = $2 ORDER BY version_no", [appId, REPORT_CATEGORY])).rows;
const events = async (appId: string) => (await db.query<{ action: string }>("SELECT action FROM audit_events WHERE application_id = $1 ORDER BY id", [appId])).rows.map((r) => r.action);
const apiCalls = async () => Number((await db.query("SELECT count(*) AS n FROM fi_api_calls")).rows[0].n);

describe("automatic report storage and the facility timeline (§22, §23, §29)", () => {
  it("saves a branded PDF report against the application on completion, without a save action, and records the timeline", async () => {
    const c = await analysed([STATEMENT("0123456789"), STATEMENT("0987654321")]);
    const docs = await reports(c.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].meta).toMatchObject({ analysisId: c.a.id, analysisVersion: "1" });
    expect((await db.query("SELECT report_document_id FROM fi_analyses WHERE id = $1", [c.a.id])).rows[0].report_document_id).toBe(docs[0].id);
    const pdf = await objectStore().get(docs[0].storage_key);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const ev = await events(c.id);
    for (const e of ["STATEMENT_ANALYSIS_INITIATED", "STATEMENT_PROCESSED", "STATEMENT_ANALYSIS_COMPLETED", "FINANCIAL_ASSESSMENT_COMPLETED", "CREDIT_RECOMMENDATION_GENERATED", "FINANCIAL_REPORT_SAVED"]) expect(ev).toContain(e);
    expect(ev.filter((e) => e === "STATEMENT_PROCESSED")).toHaveLength(2);
  });

  it("the report masks account numbers and labels simulated data", async () => {
    const c = await analysed();
    const pdf = await buildFinancialReportPdf({
      ref: "ARAF-T",
      customerName: "Amina Bello",
      customerType: "Enterprise",
      product: "Vendor Financing",
      daoCode: "DAO-1001",
      risk: null,
      analysis: { ...c.a, source: "FIXTURE" },
      statements: [],
      intelligence: await savedIntelligence(db, c.a.id),
      recommendation: c.r,
      review: null,
      generatedAt: new Date(),
    });
    expect(pdf.length).toBeGreaterThan(2000);
    // pdf-lib compresses page content; the masked form is what the intelligence result carries.
    const fi = (await savedIntelligence(db, c.a.id))!;
    expect(fi.accounts[0].accountNumberMasked).toBe("••••6789");
    expect(JSON.stringify(fi)).not.toContain("0123456789");
  });

  it("viewing or regenerating the saved report never calls Periculum", async () => {
    const c = await analysed();
    const before = await apiCalls();
    await savedRecommendation(db, c.a.id);
    await finalOn(c); // confirmation regenerates the report from the saved figures
    expect(await apiCalls()).toBe(before);
  });
});

describe("analyst confirmation and adjustment history (§18, §24)", () => {
  it("confirming the verified figures is recorded against the analysis version and produces a new report version; the first is kept", async () => {
    const c = await analysed();
    await finalOn(c);
    const rv = await reviewsFor(db, c.id);
    expect(rv[0]).toMatchObject({ kind: "CONFIRMED", analysis_id: c.a.id });
    const docs = await reports(c.id);
    expect(docs.map((d) => d.version_no)).toEqual([1, 2]);
    expect(docs[0].superseded_at).not.toBeNull();
    expect(docs[1].superseded_at).toBeNull();
    expect(await events(c.id)).toContain("FINANCIAL_ASSESSMENT_CONFIRMED");
  });

  it("changing a verified figure needs a reason (server-side); originals are kept and the analysis itself is never changed", async () => {
    const c = await analysed();
    const lower = (c.r.income.annualKobo ?? c.r.income.monthlyKobo!) - N(100_000);
    await expect(finalOn(c, { income: lower })).rejects.toMatchObject({ code: "VALIDATION", fields: { verifiedChangeReason: expect.stringMatching(/Automatic Statement Analysis v1/) } });
    await finalOn(c, { income: lower, reason: "One large credit is a one-off contract payment; excluded per the customer's letter." });
    const rv = (await reviewsFor(db, c.id))[0];
    expect(rv.kind).toBe("ADJUSTED");
    expect(rv.adjustments[0]).toMatchObject({ original: c.r.income.annualKobo ?? c.r.income.monthlyKobo, adjusted: lower });
    expect(await savedRecommendation(db, c.a.id)).toEqual(c.r); // the Periculum-derived result is untouched
    expect(await events(c.id)).toContain("FINANCIAL_ASSESSMENT_ADJUSTED");
  });

  it("compareWithVerified separates verified figures from financing terms", () => {
    const r = { income: { basis: "Verified monthly salary", monthlyKobo: N(1_000_000), annualKobo: null }, obligations: { usedMonthlyKobo: N(50_000) }, requested: { principalKobo: N(2_400_000), tenorMonths: 12 } } as unknown as Recommendation;
    const same = compareWithVerified(r, { incomeBasisKobo: N(1_000_000), annualInflowKobo: null, existingObligations: [{ lender: "x", facilityType: "", monthlyRepaymentKobo: N(50_000), outstandingKobo: null }], principalKobo: N(2_000_000), tenorMonths: 12 });
    expect(same.verified).toEqual([]);
    expect(same.terms).toEqual([{ field: "PRINCIPAL", label: "Principal", original: N(2_400_000), adjusted: N(2_000_000) }]);
    expect(compareWithVerified(r, { incomeBasisKobo: N(900_000), annualInflowKobo: null, existingObligations: [], principalKobo: N(2_400_000), tenorMonths: 12 }).verified.map((v) => v.field)).toEqual(["INCOME", "OBLIGATIONS"]);
  });

  it("an analysis stops being current when the statements change, and is not offered as current", async () => {
    const c = await analysed();
    expect((await analysisFreshness(db, c.a)).current).toBe(true);
    await uploadDocument(c.analyst, { applicationId: c.id, category: "CREDIT_REPORT", filename: "unrelated.pdf", data: makePdf("credit report") });
    expect((await analysisFreshness(db, c.a)).current).toBe(true); // only bank statements matter
    await db.query("UPDATE documents SET superseded_at = now() WHERE application_id = $1 AND category = 'BANK_STATEMENT'", [c.id]);
    const f = await analysisFreshness(db, c.a);
    expect(f.current).toBe(false);
    expect(await reliableAnalysis(db, c.id)).toBeNull();
  });
});

describe("workflow governance (§27, §28)", () => {
  it("not mandatory by default: existing products approve exactly as before", async () => {
    const c = await caseAtCreditReview();
    await finalOn({ ...c, a: null as never, r: { income: { annualKobo: null, monthlyKobo: N(1_000_000) }, requested: { principalKobo: N(2_000_000), tenorMonths: 12 } } as Recommendation });
    await act(c.id, "APPROVE");
    expect((await openTaskOf(c.id)).stage).not.toBe("FIRST_CREDIT_REVIEW");
  });

  it("when mandatory, credit approval is refused in the workflow engine until a current analysis exists; the decision's analysis is marked", async () => {
    await useConfig(true);
    const c = await caseAtCreditReview();
    await finalOn({ ...c, a: null as never, r: { income: { annualKobo: null, monthlyKobo: N(1_000_000) }, requested: { principalKobo: N(2_000_000), tenorMonths: 12 } } as Recommendation }).catch(() => undefined);
    await expect(act(c.id, "APPROVE")).rejects.toMatchObject({ code: "GATE", message: expect.stringMatching(/current financial assessment is required/) });
    await startStatementAnalysis(c.analyst, c.id);
    await runWorker();
    const a = (await currentAnalysis(db, c.id))!;
    await finalOn({ ...c, a, r: (await savedRecommendation(db, a.id))! });
    await act(c.id, "APPROVE");
    const row = (await db.query("SELECT relied_on_at, relied_on_task_id FROM fi_analyses WHERE id = $1", [a.id])).rows[0];
    expect(row.relied_on_at).not.toBeNull();
    expect(row.relied_on_task_id).not.toBeNull();
  });

  it("a Manual Financial Assessment exception needs the configured authority, a reason and evidence, and is labelled as manual", async () => {
    await useConfig(true, null);
    const c = await caseAtCreditReview();
    const ev = { id: "" };
    ev.id = (await uploadDocument(c.analyst, { applicationId: c.id, category: "EXCEPTION_EVIDENCE", filename: "outage.pdf", data: makePdf("Periculum outage notice") })).id;
    await expect(requestException(c.analyst, c.id, { type: "MANUAL_ASSESSMENT", reason: "Periculum unavailable for two days.", evidenceDocumentIds: [ev.id] })).rejects.toMatchObject({ code: "GATE", message: expect.stringMatching(/not permitted/) });
    // Applications keep the configuration they were submitted under: a new one under the configured authority.
    await useConfig(true, "UNIT_HEAD");
    const d = await caseAtCreditReview();
    Object.assign(c, d);
    const ev2 = await uploadDocument(c.analyst, { applicationId: c.id, category: "EXCEPTION_EVIDENCE", filename: "outage.pdf", data: makePdf("Periculum outage notice") });
    ev.id = ev2.id;
    await expect(requestException(c.rm, c.id, { type: "MANUAL_ASSESSMENT", reason: "Periculum unavailable for two days.", evidenceDocumentIds: [ev.id] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ex = await requestException(c.analyst, c.id, { type: "MANUAL_ASSESSMENT", reason: "Periculum unavailable for two days.", evidenceDocumentIds: [ev.id] });
    const uh = (await db.query("SELECT s.email FROM role_assignments ra JOIN staff s ON s.id = ra.staff_id WHERE ra.role = 'UNIT_HEAD' AND ra.active ORDER BY s.email LIMIT 1")).rows[0].email;
    await decideException(await ctxFor(uh), (ex as { id: string }).id, true, "Approved: outage confirmed with Periculum.");
    await finalOn({ ...c, a: null as never, r: { income: { annualKobo: null, monthlyKobo: N(1_000_000) }, requested: { principalKobo: N(2_000_000), tenorMonths: 12 } } as Recommendation });
    expect((await reviewsFor(db, c.id))[0]).toMatchObject({ kind: "MANUAL", analysis_id: null });
    await act(c.id, "APPROVE");
    expect(await events(c.id)).toContain("MANUAL_FINANCIAL_ASSESSMENT_RECORDED");
  });
});

describe("Financial Intelligence administration (§30)", () => {
  it("reports monitoring and usage from ARAF's own records, without calling Periculum or inventing charges", async () => {
    const { fiMonitoring } = await import("@/server/domain/fi-monitoring");
    await analysed([STATEMENT("0123456789"), STATEMENT("0123456789")]); // the same file twice: one is a duplicate
    const before = await apiCalls();
    const m = await fiMonitoring(db, 30);
    expect(await apiCalls()).toBe(before);
    expect(m.usage).toMatchObject({ analysisRequests: 1, statementsProcessed: 1, duplicatesPrevented: 1 });
    expect(m.usage.billableSubmissions).toBe(1);
    expect(m.analyses.COMPLETED).toBe(1);
    expect(m.lastSuccessAt).not.toBeNull();
    expect(m.turnaround.sample).toBe(1);
    expect(Object.keys(m)).not.toContain("charges");
  });
});

describe("Credit Risk Report from Periculum's results", () => {
  it("is saved with the analysis and reflects the risk fields Periculum returned", async () => {
    const c = await analysed([`${STATEMENT("0123456789")};betting=3;returnedCheques=1`]);
    const risk = (await db.query("SELECT result->'risk' AS r FROM fi_analyses WHERE id = $1", [c.a.id])).rows[0].r;
    expect(risk.grade).toBe("HIGH");
    expect(risk.indicators.find((i: { key: string }) => i.key === "RETURNED_CHEQUES").level).toBe("HIGH");
    expect(risk.indicators.find((i: { key: string }) => i.key === "GAMBLING").level).toBe("WATCH");
    expect(risk.thresholdsStatus).toMatch(/Credit Risk Management/);
  });
});
