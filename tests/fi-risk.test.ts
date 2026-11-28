import { describe, expect, it } from "vitest";
import { assessRisk, extractRiskSignals, type RiskSignals } from "@/server/domain/fi-risk";
import type { FinancialIntelligence } from "@/server/domain/financial-intelligence";
import type { Recommendation } from "@/server/domain/credit-recommendation";

const N = (n: number) => n * 100;
const fi = (o: Partial<FinancialIntelligence> = {}) =>
  ({
    customerType: "BUSINESS",
    accounts: [{ bankName: "Sterling Bank", accountNumberMasked: "••••6789", accountName: "AMINA BELLO", ownership: "VERIFIED" }],
    assessmentMonths: ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"],
    totals: { loanProceedsKobo: 0 },
    monthly: { netCashFlowKobo: N(300_000), inflowVariationBps: 900, lowestInflowKobo: N(900_000), highestInflowKobo: N(1_100_000) },
    salary: { detected: false, missedMonths: [], monthsWithSalary: 0, payers: [] },
    obligations: { lenders: [], detectedMonthlyKobo: 0 },
    exceptions: [],
    ...o,
  }) as unknown as FinancialIntelligence;
const rec = (dsr = "12.5000", pass = true) =>
  ({
    dsr: { percent: dsr, thresholdPercent: "30", pass },
    proposedMonthlyKobo: N(125_000),
    obligations: { usedMonthlyKobo: 0 },
    income: { basis: "Adjusted average monthly turnover", monthlyKobo: N(1_000_000) },
    seedfi: { outcome: "PASS", score: 700 },
  }) as unknown as Recommendation;
const analytics = (o: { betting?: number; rate?: number; cheques?: number; sweep?: string; edited?: boolean; confidence?: number } = {}) => ({
  confidenceOnParsing: o.confidence ?? 0.98,
  pdfCreatedDate: "2026-11-01T09:00:00",
  pdfModifiedDate: o.edited ? "2026-11-20T15:42:00" : "2026-11-01T09:00:00",
  behavioralAnalysis: { numberOfBettingTransactions: o.betting ?? 0, gamblingRate: o.rate ?? 0, accountSweep: o.sweep ?? "No", percentOfInflowIrregularity: 10 },
  transactionPatternAnalysis: { returnCheque: o.cheques ?? 0, missingTransactions: "0", percentNumberOfDaysBalanceWasLessThan10ThousandNaira: 5 },
});
const run = (signals: RiskSignals[], o: { intelligence?: FinancialIntelligence; recommendation?: Recommendation; altered?: string[] } = {}) =>
  assessRisk({ intelligence: o.intelligence ?? fi(), recommendation: o.recommendation ?? rec(), signals, bureau: [], altered: o.altered });
const level = (r: ReturnType<typeof run>, key: string) => r.indicators.find((i) => i.key === key)?.level;

describe("Credit Risk Report", () => {
  it("a clean statement within policy grades Low risk, with mitigants listed", () => {
    const r = run([extractRiskSignals("s1.pdf", analytics())]);
    expect(r.grade).toBe("LOW");
    expect(r.counts.high).toBe(0);
    expect(r.mitigants.length).toBeGreaterThan(0);
    expect(level(r, "GAMBLING")).toBe("LOW");
  });

  it("betting is a watch signal; a high gambling rate is high", () => {
    expect(level(run([extractRiskSignals("s1.pdf", analytics({ betting: 4 }))]), "GAMBLING")).toBe("WATCH");
    expect(level(run([extractRiskSignals("s1.pdf", analytics({ betting: 20, rate: 0.08 }))]), "GAMBLING")).toBe("HIGH"); // 0.08 is read as 8%
  });

  it("returned cheques, an edited PDF or an altered statement make the grade High", () => {
    expect(run([extractRiskSignals("s1.pdf", analytics({ cheques: 2 }))]).grade).toBe("HIGH");
    const edited = run([extractRiskSignals("s1.pdf", analytics({ edited: true }))]);
    expect(level(edited, "PDF_EDITED")).toBe("HIGH");
    expect(edited.grade).toBe("HIGH");
    expect(run([extractRiskSignals("s1.pdf", analytics())], { altered: ["s2.pdf"] }).grade).toBe("HIGH");
  });

  it("a DSR above the limit is high; close to it is watch", () => {
    expect(level(run([], { recommendation: rec("31.0000", false) }), "DSR")).toBe("HIGH");
    expect(level(run([], { recommendation: rec("26.0000") }), "DSR")).toBe("WATCH");
  });

  it("fields Periculum did not return are 'not reported', never treated as clean", () => {
    const r = run([extractRiskSignals("s1.pdf", {})]);
    expect(level(r, "GAMBLING")).toBe("NOT_REPORTED");
    expect(level(r, "RETURNED_CHEQUES")).toBe("NOT_REPORTED");
    expect(r.counts.notReported).toBe(2);
  });

  it("stacked lenders, volatility and a name mismatch accumulate into the grade", () => {
    const r = run([extractRiskSignals("s1.pdf", analytics({ sweep: "Yes" }))], {
      intelligence: fi({
        obligations: { lenders: ["Carbon", "FairMoney", "Renmoney"], detectedMonthlyKobo: N(90_000), repayments: [] },
        monthly: { netCashFlowKobo: -N(10_000), inflowVariationBps: 6200, lowestInflowKobo: N(200_000), highestInflowKobo: N(2_000_000) } as FinancialIntelligence["monthly"],
        accounts: [{ bankName: "Sterling Bank", accountNumberMasked: "••••6789", accountName: "JOHN DOE", ownership: "MISMATCH" }] as unknown as FinancialIntelligence["accounts"],
      }),
    });
    expect(level(r, "LENDERS")).toBe("HIGH");
    expect(level(r, "VOLATILITY")).toBe("HIGH");
    expect(level(r, "NET_CASH")).toBe("HIGH");
    expect(level(r, "SWEEP")).toBe("WATCH");
    expect(r.grade).toBe("HIGH");
    expect(r.keyRisks.length).toBeGreaterThan(2);
  });

  it("summarises each category by its worst indicator and writes a plain-English headline", () => {
    const r = run([extractRiskSignals("s1.pdf", analytics({ betting: 2 }))]);
    const conduct = r.categories.find((c) => c.category === "CONDUCT")!;
    expect(conduct).toMatchObject({ level: "WATCH", note: "Gambling and betting: 2 transactions" });
    expect(r.categories.find((c) => c.category === "AFFORDABILITY")!.level).toBe("LOW");
    expect(r.headline).toBe("1 watch signal and no high-risk signals. Affordable at 12.50% DSR, but gambling and betting needs attention (2 transactions).");
    const over = run([], { recommendation: rec("31.0000", false) });
    expect(over.headline).toMatch(/DSR of 31\.00% is above the 30% limit\.$/);
  });
});
