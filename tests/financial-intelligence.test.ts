import { describe, expect, it } from "vitest";
import { buildIntelligence, ownershipOf, type IntelligenceInput, type RawTransaction, type StatementInput } from "@/server/domain/financial-intelligence";

const N = (naira: number) => naira * 100;
const APPLICANT = { names: ["Amina Bello", "Amina Fabrics"] };

/** A statement over whole months with the given transactions (amounts in naira). */
function stmt(
  id: string,
  o: {
    bank: string;
    account: string;
    name?: string;
    start: string;
    end: string;
    tx: [string, number, "credit" | "debit", string][];
    salary?: [string, number][];
    loans?: [string, number][];
    repayments?: [string, number][];
    selfIn?: [string, number][];
  },
): StatementInput {
  let bal = 1_000_000;
  const transactions: RawTransaction[] = o.tx.map(([date, amount, type, description]) => {
    bal += type === "credit" ? amount : -amount;
    return { date, amount, type, description, balance: bal };
  });
  const da = (xs?: [string, number][]) => (xs ?? []).map(([date, amount]) => ({ date: `${date} 00:00:00`, amount, description: "x" }));
  return {
    statementId: id,
    filename: `${id}.pdf`,
    status: "PROCESSED",
    vendorStatus: "PROCESSED",
    errorCategory: null,
    analytics: {
      bankName: o.bank,
      accountId: o.account,
      accountName: o.name ?? "AMINA BELLO",
      startDate: `${o.start}T00:00:00`,
      endDate: `${o.end}T00:00:00`,
      incomeAnalysis: { salaryTransactions: da(o.salary) },
      behavioralAnalysis: { loanTransactions: da(o.loans), loanRepaymentTransactions: da(o.repayments) },
      transactionPatternAnalysis: { selfTransferInflowTransactions: da(o.selfIn) },
    },
    transactions,
  };
}
const input = (statements: StatementInput[], o: Partial<IntelligenceInput> = {}): IntelligenceInput => ({
  analysisStatus: "COMPLETED",
  customerType: "BUSINESS",
  requiredMonths: 3,
  applicant: APPLICANT,
  statements,
  ...o,
});

describe("one statement", () => {
  it("produces an individual assessment over complete months, and identifies salary", () => {
    const tx: [string, number, "credit" | "debit", string][] = [];
    for (const m of ["2026-06", "2026-07", "2026-08"]) {
      tx.push([`${m}-25`, 500_000, "credit", "salary acme plc"], [`${m}-27`, 50_000, "debit", "loan repayment renmoney"], [`${m}-28`, 100_000, "debit", "pos shop"]);
    }
    const s = stmt("s1", {
      bank: "Sterling Bank",
      account: "0123456789",
      start: "2026-06-01",
      end: "2026-08-31",
      tx,
      salary: tx.filter((t) => t[3].startsWith("salary")).map((t) => [t[0], t[1]]),
      repayments: tx.filter((t) => t[3].startsWith("loan")).map((t) => [t[0], t[1]]),
    });
    const r = buildIntelligence(input([s], { customerType: "SALARIED" }));
    expect(r).toMatchObject({ complete: true, statementsAnalysed: 1, uniqueAccounts: 1, assessmentMonths: ["2026-06", "2026-07", "2026-08"] });
    expect(r.salary).toMatchObject({ detected: true, verifiedMonthlyKobo: N(500_000), monthsWithSalary: 3, evidenceSufficient: true, missedMonths: [] });
    expect(r.obligations.detectedMonthlyKobo).toBe(N(50_000));
    expect(r.monthly.adjustedInflowKobo).toBe(N(500_000));
    expect(r.accounts[0]).toMatchObject({ ownership: "VERIFIED", accountNumberMasked: "••••6789", completeMonths: ["2026-06", "2026-07", "2026-08"] });
    expect(r.exceptions).toEqual([]);
  });
});

describe("two accounts at different banks", () => {
  it("₦20m external revenue, ₦8m moved to the customer's other account: adjusted inflow stays ₦20m (brief §10)", () => {
    const a = stmt("a", {
      bank: "Sterling Bank",
      account: "1111111111",
      start: "2026-06-01",
      end: "2026-08-31",
      tx: [
        ["2026-07-10", 20_000_000, "credit", "invoice payment from distributor"],
        ["2026-07-15", 8_000_000, "debit", "trf to amina bello access"],
      ],
    });
    const b = stmt("b", { bank: "Access Bank", account: "2222222222", start: "2026-06-01", end: "2026-08-31", tx: [["2026-07-16", 8_000_000, "credit", "trf from amina bello sterling"]] });
    const r = buildIntelligence(input([a, b]));
    expect(r.uniqueAccounts).toBe(2);
    expect(r.totals).toMatchObject({ grossInflowKobo: N(28_000_000), internalTransfersKobo: N(8_000_000), adjustedExternalInflowKobo: N(20_000_000), adjustedExternalOutflowKobo: 0 });
    expect(r.exclusions.filter((e) => e.kind === "INTERNAL_TRANSFER")).toHaveLength(2);
  });

  it("salary moved to another own account is not counted twice", () => {
    const tx = (m: string): [string, number, "credit" | "debit", string][] => [
      [`${m}-25`, 400_000, "credit", "salary acme"],
      [`${m}-26`, 300_000, "debit", "trf to self"],
    ];
    const months = ["2026-06", "2026-07", "2026-08"];
    const a = stmt("a", { bank: "GTBank", account: "3333333333", start: "2026-06-01", end: "2026-08-31", tx: months.flatMap(tx), salary: months.map((m) => [`${m}-25`, 400_000]) });
    const b = stmt("b", { bank: "Zenith Bank", account: "4444444444", start: "2026-06-01", end: "2026-08-31", tx: months.map((m) => [`${m}-27`, 300_000, "credit", "trf from self"]) });
    const r = buildIntelligence(input([a, b], { customerType: "SALARIED" }));
    expect(r.salary.verifiedMonthlyKobo).toBe(N(400_000));
    expect(r.monthly.adjustedInflowKobo).toBe(N(400_000)); // not 700,000
  });
});

describe("several files of the same account", () => {
  it("overlapping periods do not count transactions twice", () => {
    const shared: [string, number, "credit" | "debit", string][] = [["2026-07-10", 1_000_000, "credit", "sales"]];
    const first = stmt("f1", { bank: "Sterling Bank", account: "5555555555", start: "2026-06-01", end: "2026-07-31", tx: [["2026-06-10", 1_000_000, "credit", "sales"], ...shared] });
    const second = stmt("f2", { bank: "Sterling Bank", account: "5555555555", start: "2026-07-01", end: "2026-08-31", tx: [] });
    // Same transaction (same date, amount, direction and running balance) in both files.
    second.transactions = [first.transactions![1], { date: "2026-08-10", amount: 1_000_000, type: "credit", description: "sales", balance: 4_000_000 }];
    const r = buildIntelligence(input([first, second]));
    expect(r.uniqueAccounts).toBe(1);
    expect(r.accounts[0]).toMatchObject({ duplicatesRemoved: 1, overlapDays: 31, completeMonths: ["2026-06", "2026-07", "2026-08"] });
    expect(r.totals.adjustedExternalInflowKobo).toBe(N(3_000_000));
  });

  it("reports missing months between statements", () => {
    const a = stmt("a", { bank: "Sterling Bank", account: "6666666666", start: "2026-03-01", end: "2026-04-30", tx: [["2026-03-05", 100, "credit", "x"]] });
    const b = stmt("b", { bank: "Sterling Bank", account: "6666666666", start: "2026-06-01", end: "2026-06-30", tx: [["2026-06-05", 100, "credit", "y"]] });
    const r = buildIntelligence(input([a, b]));
    expect(r.accounts[0].missingMonths).toEqual(["2026-05"]);
    expect(r.exceptions.map((e) => e.type)).toContain("STATEMENT_GAP");
  });
});

describe("ownership, loans and evidence", () => {
  it("an account in someone else's name never increases capacity", () => {
    expect(ownershipOf("AMINA BELLO", APPLICANT).ownership).toBe("VERIFIED");
    expect(ownershipOf("AMINA FABRICS LTD", APPLICANT).ownership).toBe("VERIFIED");
    expect(ownershipOf("JOHN DOE", APPLICANT).ownership).toBe("MISMATCH");
    expect(ownershipOf(null, APPLICANT).ownership).toBe("UNVERIFIED");
    const mine = stmt("m", { bank: "Sterling Bank", account: "7777777777", start: "2026-06-01", end: "2026-08-31", tx: [["2026-07-01", 1_000_000, "credit", "sales"]] });
    const theirs = stmt("t", { bank: "Access Bank", account: "8888888888", name: "JOHN DOE", start: "2026-06-01", end: "2026-08-31", tx: [["2026-07-01", 9_000_000, "credit", "sales"]] });
    const r = buildIntelligence(input([mine, theirs]));
    expect(r.totals).toMatchObject({ adjustedExternalInflowKobo: N(1_000_000), unverifiedAccountInflowKobo: N(9_000_000) });
    expect(r.exceptions.find((e) => e.type === "OWNERSHIP_UNVERIFIED")).toMatchObject({ severity: "MATERIAL", evidence: expect.stringMatching(/JOHN DOE/) });
  });

  it("loan proceeds and unexplained self-transfers are not income", () => {
    const s = stmt("s", {
      bank: "Sterling Bank",
      account: "9999999999",
      start: "2026-06-01",
      end: "2026-08-31",
      tx: [
        ["2026-06-05", 2_000_000, "credit", "sales"],
        ["2026-07-05", 3_000_000, "credit", "renmoney loan disbursement"],
        ["2026-08-05", 500_000, "credit", "trf from self"],
      ],
      loans: [["2026-07-05", 3_000_000]],
      selfIn: [["2026-08-05", 500_000]],
    });
    const r = buildIntelligence(input([s]));
    expect(r.totals).toMatchObject({ loanProceedsKobo: N(3_000_000), unmatchedSelfTransfersKobo: N(500_000), adjustedExternalInflowKobo: N(2_000_000) });
    expect(r.exceptions.map((e) => e.type)).toContain("SELF_TRANSFER_SOURCE_NOT_PROVIDED");
  });

  it("salaried: missing salary months and too little history are flagged; no salary blocks the assessment", () => {
    const s = stmt("s", {
      bank: "Sterling Bank",
      account: "1212121212",
      start: "2026-06-01",
      end: "2026-08-31",
      tx: [
        ["2026-06-25", 400_000, "credit", "salary"],
        ["2026-08-25", 400_000, "credit", "salary"],
      ],
      salary: [
        ["2026-06-25", 400_000],
        ["2026-08-25", 400_000],
      ],
    });
    const r = buildIntelligence(input([s], { customerType: "SALARIED" }));
    expect(r.salary).toMatchObject({ monthsWithSalary: 2, missedMonths: ["2026-07"], evidenceSufficient: false });
    expect(r.exceptions.map((e) => e.type)).toEqual(expect.arrayContaining(["SALARY_HISTORY_SHORT", "SALARY_MISSED_MONTHS"]));
    const none = buildIntelligence(input([stmt("n", { bank: "Sterling Bank", account: "1313131313", start: "2026-06-01", end: "2026-08-31", tx: [["2026-06-05", 100, "credit", "gift"]] })], { customerType: "SALARIED" }));
    expect(none.complete).toBe(false);
    expect(none.exceptions.find((e) => e.type === "SALARY_NOT_IDENTIFIED")?.severity).toBe("BLOCKING");
  });

  it("a partial analysis is never presented as complete; too short a period is flagged", () => {
    const ok = stmt("ok", { bank: "Sterling Bank", account: "1414141414", start: "2026-08-01", end: "2026-08-31", tx: [["2026-08-05", 100, "credit", "sales"]] });
    const failed: StatementInput = { statementId: "bad", filename: "bad.pdf", status: "FAILED", vendorStatus: "NOT ENOUGH TRANSACTIONS", errorCategory: "NOT_ENOUGH_TRANSACTIONS", analytics: null, transactions: null };
    const r = buildIntelligence(input([ok, failed], { analysisStatus: "PARTIALLY_COMPLETED", requiredMonths: 6 }));
    expect(r.complete).toBe(false);
    expect(r.exceptions.map((e) => e.type)).toEqual(expect.arrayContaining(["PARTIAL_ANALYSIS", "STATEMENT_NOT_ANALYSED", "INSUFFICIENT_COVERAGE"]));
    const altered: StatementInput = { ...failed, statementId: "alt", filename: "alt.pdf", status: "REQUIRES_VERIFICATION", vendorStatus: "ALTERED", errorCategory: "ALTERED" };
    expect(buildIntelligence(input([ok, altered], { analysisStatus: "REQUIRES_VERIFICATION" })).exceptions.find((e) => e.type === "STATEMENT_ALTERED")?.severity).toBe("BLOCKING");
  });
});
