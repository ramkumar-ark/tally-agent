import { describe, expect, it } from "vitest";
import { ledgerInWrongGroup } from "../src/checks/index.js";
import { PRIMARY_GROUPS } from "../src/classify.js";
import { EMPTY_WRONG_GROUP, type ReviewInput, type TbRow, type WrongGroupConfig } from "../src/types.js";

const PARENT: Record<string, string> = {
  Drawings: "Capital Account",
  "Sundry Creditors": "Current Liabilities",
  "Sundry Debtors": "Current Assets",
  "Office Expenses": "Indirect Expenses",
  "Unsecured Loans": "Loans (Liability)",
};
const PRIMARY = new Set<string>(PRIMARY_GROUPS);

function input(rows: TbRow[], wrongGroup: WrongGroupConfig = EMPTY_WRONG_GROUP): ReviewInput {
  return {
    asOnDate: "20260331",
    rows,
    ledgers: [],
    totalDebit: 0,
    totalCredit: 0,
    roleOf: () => "other",
    isPrimaryGroup: (g) => PRIMARY.has(g),
    ancestryOf: (g) => {
      const chain: string[] = [];
      for (let cur = g; cur; cur = PARENT[cur] ?? "") chain.push(cur);
      return chain;
    },
    wrongGroup,
  };
}

const row = (name: string, parent: string, balance: number): TbRow => ({ name, parent, balance });

describe("ledgerInWrongGroup", () => {
  it("flags an expense ledger under Capital Account", () => {
    expect(ledgerInWrongGroup(input([row("Orchid Medical Expenses", "Capital Account", 18000)]))).toEqual([
      {
        id: "TB-008-1",
        check: "ledger_in_wrong_group",
        severity: "warning",
        ledger: "Orchid Medical Expenses",
        group: "Capital Account",
        amount: 18000,
        side: "Dr",
        expected: "expense",
        detail:
          "Orchid Medical Expenses reads as an expense ledger but is grouped under Capital Account, " +
          "with a Dr balance of 18,000.00 as of 31-Mar-2026; as placed, it is kept out of the profit and loss account. " +
          "Move it under Direct Expenses, Indirect Expenses or Purchase Accounts, " +
          "or under a Drawings sub-group of Capital Account if it is an owner's personal spending. " +
          "If the placement is deliberate, list it in wrongGroup.ignoreLedgers in config/overrides.json",
      },
    ]);
  });

  it("never quotes a word of the name outside the name itself, so masking the name hides all of it", () => {
    const [f] = ledgerInWrongGroup(input([row("Orchid Medical Expenses", "Capital Account", 18000)]));
    expect(f.detail.split("Orchid Medical Expenses").join("")).not.toMatch(/orchid|medical/i);
  });

  it("flags an expense ledger with a debit balance under a liability sub-group, naming the primary group", () => {
    const [f] = ledgerInWrongGroup(input([row("Wages", "Sundry Creditors", 5000)]));
    expect(f.expected).toBe("expense");
    expect(f.group).toBe("Sundry Creditors");
    expect(f.detail).toContain("is grouped under Current Liabilities");
  });

  it("flags an income ledger with a credit balance under an asset group, and under Capital Account", () => {
    const f = ledgerInWrongGroup(
      input([row("Scrap Sales", "Sundry Debtors", -2500), row("Other Income", "Capital Account", -4000)]),
    );
    expect(f.map((x) => [x.ledger, x.side, x.expected])).toEqual([
      ["Scrap Sales", "Cr", "income"],
      ["Other Income", "Cr", "income"],
    ]);
    expect(f[0].detail).toContain("Move it under Sales Accounts, Direct Incomes or Indirect Incomes");
    expect(f[1].detail).not.toContain("Drawings");
  });

  it("flags a party ledger in the profit and loss account, suggesting the party group for its side", () => {
    const f = ledgerInWrongGroup(
      input([row("Nimbus Enterprises", "Office Expenses", 9500), row("Nimbus Enterprises", "Indirect Expenses", -9500)]),
    );
    expect(f.map((x) => x.expected)).toEqual(["asset", "liability"]);
    expect(f[0].detail).toContain("reads as a party (debtor or creditor) ledger but is grouped under Indirect Expenses");
    expect(f[0].detail).toContain("its balance runs through the profit and loss account. Move it under Sundry Debtors");
    expect(f[1].detail).toContain("Move it under Sundry Creditors");
  });

  it("flags bank, capital and loan ledgers in the profit and loss account, numbering in row order", () => {
    const f = ledgerInWrongGroup(
      input([
        row("Zeta Bank", "Indirect Expenses", -1200),
        row("Proprietor Capital", "Indirect Incomes", -50000),
        row("Car Loan", "Direct Expenses", 30000),
      ]),
    );
    expect(f.map((x) => [x.id, x.expected])).toEqual([
      ["TB-008-1", "liability"],
      ["TB-008-2", "capital"],
      ["TB-008-3", "asset"],
    ]);
    expect(f[0].detail).toContain("Move it under Bank OD A/c");
    expect(f[1].detail).toContain("Move it under Capital Account");
    expect(f[2].detail).toContain("Move it under Loans & Advances (Asset)");
  });

  it.each([
    ["a payable", row("Salary Payable", "Sundry Creditors", 8000)],
    ["an expense name on the credit side of a liability group (reads as a payable)", row("Salary", "Sundry Creditors", -8000)],
    ["an expense name on the debit side of an asset group (reads as prepaid or a deposit)", row("Rent", "Current Assets", 12000)],
    ["an income name on the credit side of a liability group (reads as an advance received)", row("Sales", "Current Liabilities", -5000)],
    ["a prepaid expense", row("Prepaid Insurance", "Current Assets", 3000)],
    ["a tax deducted from salary", row("TDS on Salary", "Current Liabilities", 700)],
    ["rent received", row("Rent Received", "Indirect Expenses", -6000)],
    ["bank charges", row("Bank Charges", "Indirect Expenses", 350)],
    ["capital gains", row("Capital Gains", "Indirect Incomes", -9000)],
    ["income under an expense group (presentation only)", row("Other Income", "Indirect Expenses", -1000)],
    ["personal spending under a Drawings sub-group", row("Household Medical Expenses", "Drawings", 6000)],
    ["an expense name on the credit side of Capital Account", row("Medical Expenses", "Capital Account", -6000)],
    ["a zero balance", row("Medical Expenses", "Capital Account", 0)],
    ["a person's name", row("Kavya Iyer", "Indirect Expenses", 4000)],
    ["a name the vocabulary cannot read", row("चिकित्सा खर्च", "Capital Account", 4000)],
    ["Suspense A/c", row("Medical Expenses", "Suspense A/c", 4000)],
    ["Branch / Divisions", row("Medical Expenses", "Branch / Divisions", 4000)],
    ["a group missing from the group tree", row("Medical Expenses", "Unknown Group", 4000)],
    ["a loan under a loan group", row("Car Loan", "Unsecured Loans", -30000)],
  ])("stays silent for %s", (_why, r) => {
    expect(ledgerInWrongGroup(input([r]))).toEqual([]);
  });

  it("silences a ledger listed in wrongGroup.ignoreLedgers, whatever its case or spacing", () => {
    const config = { ignoreLedgers: ["  orchid   MEDICAL expenses "], keywords: {} };
    expect(ledgerInWrongGroup(input([row("Orchid Medical Expenses", "Capital Account", 18000)], config))).toEqual([]);
  });

  it("reads the operator's extra keywords", () => {
    const config = { ignoreLedgers: [], keywords: { expense: ["hospitality"] } };
    expect(ledgerInWrongGroup(input([row("Guest Hospitality", "Capital Account", 2000)], config))).toHaveLength(1);
    expect(ledgerInWrongGroup(input([row("Guest Hospitality", "Capital Account", 2000)]))).toEqual([]);
  });
});
