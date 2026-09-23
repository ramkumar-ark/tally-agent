import { describe, expect, it } from "vitest";
import { findFundLedgers, employeeEvents } from "../src/pf-esi.js";

// Synthetic ledgers and amounts only: the real operator's fund ledgers, party
// names and figures never appear in the repo (captain ruling 2026-09-23).
const GROUPS: Record<string, string> = {
  "Staff PF Payable": "Provisions",
  "Staff ESI Payable": "Provisions",
  "PF Employer Contribution": "Indirect Expenses",
  "ESI Employer Contribution": "Indirect Expenses",
  Salaries: "Indirect Expenses",
  "Synthetic Consultant": "Sundry Creditors",
  "Weighing Machine XY-PF": "Plant & Machinery",
};
const ROOTS: Record<string, string> = {
  Provisions: "Current Liabilities",
  "Indirect Expenses": "Indirect Expenses",
  "Sundry Creditors": "Current Liabilities",
  "Plant & Machinery": "Fixed Assets",
};
const ctx = {
  groupOf: (l: string) => GROUPS[l] ?? "",
  rootOf: (l: string) => ROOTS[GROUPS[l] ?? ""] ?? "",
};
const masters = Object.entries(GROUPS).map(([name, parent]) => ({ name, parent }));

describe("fund ledger discovery", () => {
  it("finds the PF and ESI payable ledgers under a liability root", () => {
    const f = findFundLedgers(masters, ctx);
    expect(f.pf).toEqual(["Staff PF Payable"]);
    expect(f.esi).toEqual(["Staff ESI Payable"]);
  });

  // Review Focus #4
  it("does not pick up a fixed asset that merely matches by name", () => {
    const f = findFundLedgers(masters, ctx);
    expect(f.pf).not.toContain("Weighing Machine XY-PF");
    expect([...f.pf, ...f.esi]).not.toContain("PF Employer Contribution");
  });

  it("takes an operator override over the heuristic", () => {
    const f = findFundLedgers(masters, ctx, { pf: ["Some Other PF Ledger"] });
    expect(f.pf).toEqual(["Some Other PF Ledger"]);
  });
});

describe("employee contribution extraction", () => {
  // positive = debit downstream of the gateway, so a contribution CREDIT is NEGATIVE.
  const salaryJv = {
    date: "20250430", voucherType: "Journal", voucherNumber: "423", partyLedgerName: "", cancelled: false,
    entries: [{ ledger: "Salaries", amount: 250000 }, { ledger: "Staff PF Payable", amount: -30000 }],
  };
  const employerJv = {
    date: "20250430", voucherType: "Journal", voucherNumber: "421", partyLedgerName: "", cancelled: false,
    entries: [{ ledger: "PF Employer Contribution", amount: 33000 }, { ledger: "Staff PF Payable", amount: -33000 }],
  };
  const clearJv = {
    date: "20250430", voucherType: "Journal", voucherNumber: "422", partyLedgerName: "Synthetic Consultant", cancelled: false,
    entries: [{ ledger: "Staff PF Payable", amount: 63000 }, { ledger: "Synthetic Consultant", amount: -63000 }],
  };
  const funds = { pf: ["Staff PF Payable"], esi: ["Staff ESI Payable"] };

  it("takes the credit inside the salary journal and nothing else", () => {
    const { events } = employeeEvents([salaryJv, employerJv, clearJv] as never, funds, ctx);
    expect(events).toEqual([{ fund: "PF", wageMonth: "2025-04", date: "20250430", voucherNumber: "423", ledger: "Staff PF Payable", amount: 30000 }]);
  });

  it("reports the amount as a positive rupee figure although the entry is a credit", () => {
    const { events } = employeeEvents([salaryJv] as never, funds, ctx);
    expect(events[0].amount).toBeGreaterThan(0);
  });

  it("splits one salary journal that carries both funds", () => {
    const both = { ...salaryJv, voucherNumber: "5006", date: "20260131",
      entries: [...salaryJv.entries, { ledger: "Staff ESI Payable", amount: -1200 }] };
    const { events } = employeeEvents([both] as never, funds, ctx);
    expect(events.map((e) => [e.fund, e.amount])).toEqual([["PF", 30000], ["ESI", 1200]]);
  });

  it("ignores cancelled vouchers and survives entries: ['']", () => {
    const junk = { date: "20250531", voucherType: "Journal", voucherNumber: "413", partyLedgerName: "", cancelled: true, entries: [""] };
    expect(() => employeeEvents([junk, salaryJv] as never, funds, ctx)).not.toThrow();
    expect(employeeEvents([junk, salaryJv] as never, funds, ctx).events).toHaveLength(1);
  });

  it("raises a finding, not a silent drop, for a fund credit it cannot classify", () => {
    const mystery = { date: "20250731", voucherType: "Journal", voucherNumber: "999", partyLedgerName: "", cancelled: false,
      entries: [{ ledger: "Some Unknown Ledger", amount: 5000 }, { ledger: "Staff PF Payable", amount: -5000 }] };
    const { events, findings } = employeeEvents([mystery] as never, funds, ctx);
    expect(events).toHaveLength(0);
    expect(findings.map((f) => f.check)).toContain("pf_esi_unclassified_contribution");
    expect(findings[0].detail).toContain("5,000.00");   // money(), never a bare 6+-digit run
  });
});
