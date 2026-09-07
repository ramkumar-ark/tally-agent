import { describe, expect, it } from "vitest";
import { overdrawnBank, wrongSideBalance } from "../src/checks/index.js";
import type { GroupRole, ReviewInput, TbRow } from "../src/types.js";

const roles: Record<string, GroupRole> = {
  "Sundry Debtors": "debtor",
  "Sundry Creditors": "creditor",
  "Indirect Expenses": "expense",
  "Sales Accounts": "income",
  "Stock-in-Hand": "stock",
  "Bank Accounts": "bank",
  "Bank OD A/c": "bank_od",
};

function input(rows: TbRow[]): ReviewInput {
  return {
    asOnDate: "20260331",
    rows,
    ledgers: [],
    totalDebit: 0,
    totalCredit: 0,
    roleOf: (g) => roles[g] ?? "other",
    isPrimaryGroup: () => false,
  };
}

describe("wrongSideBalance", () => {
  it("flags a creditor with a debit balance", () => {
    const f = wrongSideBalance(input([{ name: "Acme", parent: "Sundry Creditors", balance: 41250 }]));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("wrong_side_balance");
    expect(f[0].severity).toBe("warning");
    expect(f[0].side).toBe("Dr");
    expect(f[0].expected).toBe("Cr");
  });

  it("flags a debtor with a credit balance", () => {
    const f = wrongSideBalance(input([{ name: "Beta", parent: "Sundry Debtors", balance: -900 }]));
    expect(f[0].expected).toBe("Dr");
    expect(f[0].side).toBe("Cr");
  });

  it("flags an expense with a credit balance", () => {
    const f = wrongSideBalance(input([{ name: "Rent", parent: "Indirect Expenses", balance: -500 }]));
    expect(f).toHaveLength(1);
  });

  it("flags an income with a debit balance", () => {
    const f = wrongSideBalance(input([{ name: "Sales", parent: "Sales Accounts", balance: 500 }]));
    expect(f).toHaveLength(1);
  });

  it("flags negative stock", () => {
    const f = wrongSideBalance(input([{ name: "Closing Stock", parent: "Stock-in-Hand", balance: -12 }]));
    expect(f).toHaveLength(1);
  });

  it("is silent when a debtor is at exactly zero", () => {
    expect(wrongSideBalance(input([{ name: "Beta", parent: "Sundry Debtors", balance: 0 }]))).toEqual([]);
  });

  it("is silent on correct sides", () => {
    const f = wrongSideBalance(
      input([
        { name: "Acme", parent: "Sundry Creditors", balance: -41250 },
        { name: "Beta", parent: "Sundry Debtors", balance: 900 },
        { name: "Rent", parent: "Indirect Expenses", balance: 500 },
      ]),
    );
    expect(f).toEqual([]);
  });

  it("does not judge groups with no expected side", () => {
    expect(wrongSideBalance(input([{ name: "Odd", parent: "Unknown Group", balance: -1 }]))).toEqual([]);
  });

  it("does not double-report a bank, which overdrawnBank owns", () => {
    expect(wrongSideBalance(input([{ name: "HDFC", parent: "Bank Accounts", balance: -100 }]))).toEqual([]);
  });
});

describe("overdrawnBank", () => {
  it("flags a credit balance in Bank Accounts", () => {
    const f = overdrawnBank(input([{ name: "HDFC", parent: "Bank Accounts", balance: -75000 }]));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("overdrawn_bank");
    expect(f[0].severity).toBe("warning");
    expect(f[0].amount).toBe(75000);
  });

  it("is silent on Bank OD, where a credit balance is expected", () => {
    expect(overdrawnBank(input([{ name: "OD A/c", parent: "Bank OD A/c", balance: -75000 }]))).toEqual([]);
  });

  it("is silent on a positive bank balance", () => {
    expect(overdrawnBank(input([{ name: "HDFC", parent: "Bank Accounts", balance: 75000 }]))).toEqual([]);
  });
});
