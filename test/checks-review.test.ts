import { describe, expect, it } from "vitest";
import { dormantBalance, ledgerUnderPrimaryGroup } from "../src/checks/index.js";
import type { LedgerMaster, ReviewInput, TbRow } from "../src/types.js";

const PRIMARY = new Set(["Current Assets", "Current Liabilities", "Indirect Expenses"]);

function input(rows: TbRow[], ledgers: LedgerMaster[] = []): ReviewInput {
  return {
    asOnDate: "20260331",
    rows,
    ledgers,
    totalDebit: 0,
    totalCredit: 0,
    roleOf: () => "other",
    isPrimaryGroup: (g) => PRIMARY.has(g),
  };
}

describe("ledgerUnderPrimaryGroup", () => {
  it("flags a ledger parked directly under a primary group", () => {
    const f = ledgerUnderPrimaryGroup(input([{ name: "Odds", parent: "Current Assets", balance: 10 }]));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("ledger_under_primary_group");
    expect(f[0].severity).toBe("review");
  });

  it("is silent for a ledger under a proper sub-group", () => {
    expect(
      ledgerUnderPrimaryGroup(input([{ name: "Acme", parent: "Sundry Debtors", balance: 10 }])),
    ).toEqual([]);
  });

  it("flags even a nil-balance ledger, because this is a master defect", () => {
    const f = ledgerUnderPrimaryGroup(input([{ name: "Odds", parent: "Current Assets", balance: 0 }]));
    expect(f).toHaveLength(1);
  });
});

describe("dormantBalance", () => {
  const ledgers: LedgerMaster[] = [
    { name: "Old Advance", parent: "Sundry Debtors", openingBalance: 25000, closingBalance: 25000 },
    { name: "Active Party", parent: "Sundry Debtors", openingBalance: 25000, closingBalance: 31000 },
    { name: "Moved By One", parent: "Sundry Debtors", openingBalance: 25000, closingBalance: 25001 },
    { name: "Nil Both Ends", parent: "Sundry Debtors", openingBalance: 0, closingBalance: 0 },
  ];

  it("flags a non-zero balance that never moved", () => {
    const f = dormantBalance(input([], ledgers));
    expect(f.map((x) => x.ledger)).toEqual(["Old Advance"]);
    expect(f[0].severity).toBe("review");
    expect(f[0].amount).toBe(25000);
  });

  it("does not flag an account that moved by one rupee", () => {
    const f = dormantBalance(input([], ledgers));
    expect(f.map((x) => x.ledger)).not.toContain("Moved By One");
  });

  it("does not flag an account with no balance at either end", () => {
    const f = dormantBalance(input([], ledgers));
    expect(f.map((x) => x.ledger)).not.toContain("Nil Both Ends");
  });
});
