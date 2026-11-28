import { describe, expect, it } from "vitest";
import { recommend, type RecommendationParams } from "@/server/domain/credit-recommendation";
import { computeAffordability, type AssessmentRules } from "@/server/domain/affordability";
import type { FinancialIntelligence } from "@/server/domain/financial-intelligence";

const N = (naira: number) => naira * 100;

/** Approved-style rules: 30% DSR on verified salary, flat pricing (0% so repayment = principal ÷ tenor). */
const rules = (o: Partial<AssessmentRules> = {}): AssessmentRules => ({
  configId: "cfg",
  configVersion: 12,
  productCode: "ALT_POWER",
  profile: "SALARY_EARNER",
  structure: "MURABAHA",
  dsrMaxPercent: "30",
  denominator: "VERIFIED_MONTHLY_NET_SALARY",
  dsrExceptionAllowed: false,
  dsrExceptionApproverRole: null,
  principalTurnoverCap: { applies: false, maxPercent: null },
  maxAmountKobo: N(50_000_000),
  minAmountKobo: N(100_000),
  maxTenorMonths: 24,
  minTenorMonths: 6,
  inflowRecognitionPercent: "100",
  eligibleApplicantTypes: ["INDIVIDUAL", "ENTERPRISE", "LIMITED"],
  ratePercent: "0",
  rateConvention: "FLAT_PER_ANNUM",
  insuranceBearer: "CUSTOMER",
  equityContribution: { applies: false, minPercent: null },
  ...o,
});

/** A complete, verified intelligence result with the given salary / inflow and detected repayments. */
const fi = (
  o: { salary?: number | null; inflow?: number | null; repayments?: number; exceptions?: FinancialIntelligence["exceptions"]; complete?: boolean; ownership?: "VERIFIED" | "MISMATCH"; analysed?: number } = {},
): FinancialIntelligence =>
  ({
    version: "t",
    complete: o.complete ?? true,
    customerType: "SALARIED",
    statementsAnalysed: o.analysed ?? 2,
    statementsTotal: 2,
    uniqueAccounts: 2,
    accounts: [{ ownership: o.ownership ?? "VERIFIED" }],
    assessmentMonths: ["2026-06", "2026-07", "2026-08"],
    months: [],
    totals: {
      grossInflowKobo: 0,
      internalTransfersKobo: N(8_000_000),
      duplicatesExcludedKobo: 0,
      loanProceedsKobo: 0,
      unmatchedSelfTransfersKobo: 0,
      unverifiedAccountInflowKobo: 0,
      adjustedExternalInflowKobo: 0,
      grossOutflowKobo: 0,
      adjustedExternalOutflowKobo: 0,
    },
    monthly: {
      adjustedInflowKobo: o.inflow === undefined ? N(1_000_000) : o.inflow === null ? null : N(o.inflow),
      adjustedOutflowKobo: null,
      netCashFlowKobo: null,
      highestInflowKobo: null,
      lowestInflowKobo: null,
      inflowVariationBps: null,
    },
    salary: {
      detected: true,
      verifiedMonthlyKobo: o.salary === undefined ? N(1_000_000) : o.salary === null ? null : N(o.salary),
      monthsWithSalary: 3,
      missedMonths: [],
      lowestKobo: null,
      highestKobo: null,
      mostRecentKobo: null,
      payers: [],
      evidenceSufficient: true,
    },
    obligations: { detectedMonthlyKobo: N(o.repayments ?? 0), repayments: [], lenders: [] },
    exclusions: [],
    exceptions: o.exceptions ?? [],
  }) as unknown as FinancialIntelligence;

const params = (o: Partial<RecommendationParams> = {}): RecommendationParams => ({
  intelligence: fi(),
  rules: rules(),
  applicantType: "INDIVIDUAL",
  requestedPrincipalKobo: N(2_400_000),
  tenorMonths: 12,
  declaredObligations: [{ lender: "Bank X", monthlyRepaymentKobo: N(50_000) }],
  assetCostKobo: null,
  equityContributionKobo: null,
  seedfi: { outcome: "PASS", score: 640 },
  ...o,
});

describe("30% DSR (brief §13.5 mandatory example)", () => {
  it("₦1,000,000 income, ₦50,000 existing, ₦200,000 proposed → 25%: within policy; capacity ₦250,000", () => {
    const r = recommend(params());
    expect(r.proposedMonthlyKobo).toBe(N(200_000));
    expect(r.dsr).toMatchObject({ percent: "25.0000", thresholdPercent: "30", pass: true, allowedMonthlyKobo: N(300_000) });
    expect(r.availableCapacityKobo).toBe(N(250_000));
    expect(r.outcome).toBe("WITHIN_CAPACITY");
    expect(r.commentary.join(" ")).toMatch(/supports the requested ₦2,400,000\.00.*does not constitute approval/);
  });

  it("₦300,000 proposed → 35%: exceeds policy; a reduced amount (₦3,000,000 over 12 months) is recommended", () => {
    const r = recommend(params({ requestedPrincipalKobo: N(3_600_000) }));
    expect(r.dsr).toMatchObject({ percent: "35.0000", pass: false });
    expect(r.outcome).toBe("REDUCED_AMOUNT");
    expect(r.maxEligiblePrincipalKobo).toBe(N(3_000_000)); // 250,000 × 12
    expect(r.recommendedPrincipalKobo).toBe(N(3_000_000));
    expect(r.differenceKobo).toBe(-N(600_000));
  });

  it("exactly 30% passes; 30.0001% fails (exact comparison, not the rounded display)", () => {
    const at = (monthly: number) =>
      computeAffordability(rules(), {
        kind: "FINAL",
        applicantType: "INDIVIDUAL",
        incomeBasisKobo: N(1_000_000),
        annualInflowKobo: null,
        incomeBasisNote: "",
        statementFrom: null,
        statementTo: null,
        evidenceDocumentIds: [],
        existingObligations: [{ lender: "x", facilityType: "", monthlyRepaymentKobo: N(50_000), outstandingKobo: null }],
        principalKobo: monthly * 12,
        tenorMonths: 12,
        proposedMonthlyObligationKobo: null,
        turnoverForCapKobo: null,
        assetCostKobo: null,
        equityContributionKobo: null,
        charges: [],
        firstDueDate: null,
      });
    expect(at(N(250_000)).dsr!.pass).toBe(true); // 30%
    expect(at(N(249_900)).dsr!.pass).toBe(true); // 29.99%
    const over = at(N(250_000) + 1); // 30.0000012%: displays as 30.0000% but fails
    expect(over.dsr!.percent).toBe("30.0000");
    expect(over.dsr!.pass).toBe(false);
  });

  it("missing income is never treated as zero: Insufficient Financial Evidence", () => {
    const r = recommend(params({ intelligence: fi({ salary: null }) }));
    expect(r.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.dsr.percent).toBeNull();
  });
});

describe("obligations, evidence and policy", () => {
  it("declared and statement-detected repayments are the same debts: the larger is used once, never added", () => {
    const r = recommend(params({ intelligence: fi({ repayments: 80_000 }) }));
    expect(r.obligations).toMatchObject({ declaredMonthlyKobo: N(50_000), detectedMonthlyKobo: N(80_000), usedMonthlyKobo: N(80_000), source: "STATEMENTS" });
    expect(r.obligations.reconciliationNote).toMatch(/larger is used once/);
    expect(r.dsr.percent).toBe("28.0000"); // (80,000 + 200,000) / 1,000,000
  });

  it("partial analysis, unverified ownership and short evidence change the outcome", () => {
    expect(
      recommend(params({ intelligence: fi({ complete: false, exceptions: [{ type: "PARTIAL_ANALYSIS", severity: "BLOCKING", affected: "", reason: "1 of 2", evidence: "", impact: "", resolution: "" }] }) })).outcome,
    ).toBe("REQUIRES_REVIEW");
    expect(recommend(params({ intelligence: fi({ ownership: "MISMATCH" }) })).outcome).toBe("OWNERSHIP_VERIFICATION");
    expect(
      recommend(params({ intelligence: fi({ exceptions: [{ type: "SALARY_HISTORY_SHORT", severity: "MATERIAL", affected: "", reason: "2 months.", evidence: "", impact: "", resolution: "Request payslips." }] }) }))
        .outcome,
    ).toBe("ADDITIONAL_DOCUMENTATION");
    expect(recommend(params({ intelligence: fi({ analysed: 0 }) })).outcome).toBe("UNABLE_TO_ASSESS");
  });

  it("a configured income DSR other than 30% is flagged, not overridden", () => {
    const r = recommend(params({ rules: rules({ dsrMaxPercent: "33" }) }));
    expect(r.dsr.thresholdPercent).toBe("33");
    expect(r.policyFlags[0]).toMatchObject({ type: "DSR_THRESHOLD_NOT_30" });
    // A turnover-based rule (e.g. 10% of turnover) is a separate approved rule and is not flagged.
    expect(recommend(params({ rules: rules({ dsrMaxPercent: "10", denominator: "AVERAGE_MONTHLY_BUSINESS_TURNOVER", profile: "BUSINESS_OWNER" }) })).policyFlags).toEqual([]);
  });

  it("business on annual inflow: adjusted monthly inflow × 12 feeds the approved engine", () => {
    const r = recommend(
      params({
        rules: rules({ productCode: "VENDOR_FINANCING", denominator: "AVERAGE_MONTHLY_INFLOW_FROM_ANNUAL", profile: "BUSINESS_OWNER" }),
        intelligence: fi({ inflow: 2_000_000 }),
        applicantType: "ENTERPRISE",
        declaredObligations: [],
      }),
    );
    expect(r.income).toMatchObject({ monthlyKobo: N(2_000_000), annualKobo: N(24_000_000) });
    expect(r.dsr.percent).toBe("10.0000"); // 200,000 / 2,000,000
    expect(r.outcome).toBe("WITHIN_CAPACITY");
    expect(r.maxEligiblePrincipalKobo).toBe(N(7_200_000)); // 600,000 × 12
  });
});
