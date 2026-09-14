import { describe, expect, it } from "vitest";
import {
  NEUTRAL_WORDS,
  SIGNAL_WORDS,
  natureOfPrimary,
  signalOf,
  tokens,
  vocabulary,
} from "../src/checks/nameSignal.js";

const builtIn = vocabulary();

describe("tokens", () => {
  it("canonicalises, then splits on anything that is not a letter or a digit", () => {
    expect(tokens("  Medical\r\nExp. A/c ")).toEqual(["medical", "exp", "a", "c"]);
  });
});

describe("signalOf", () => {
  it.each([
    ["Medical Expenses", "expense"],
    ["SALARY A/c", "expense"],
    ["Sales - Domestic", "income"],
    ["Nimbus Enterprises", "party"],
    ["Zeta Bank", "bank"],
    ["Proprietor's Capital", "capital"],
    ["Car Loan", "loan"],
    ["Zeta Bank Car Loan", "loan"],
    ["Zeta Bank Ltd", "bank"],
  ])("reads %s as %s", (name, signal) => {
    expect(signalOf(name, builtIn)).toBe(signal);
  });

  it.each([
    "Salary Payable",
    "Prepaid Rent",
    "Rent Deposit",
    "TDS on Salary",
    "Rent Received",
    "Bank Charges",
    "Capital Gains",
    "Loan Processing Fees",
    "Purchase Returns",
    "Capital Goods Purchase",
    "Rent - Nimbus Enterprises",
    "Sales Expenses",
    "Kavya Iyer",
    "Current Account",
    "Bankura Stores",
    "चिकित्सा खर्च",
    "",
  ])("reads %j as nothing", (name) => {
    expect(signalOf(name, builtIn)).toBeNull();
  });

  it("adds operator words, and lets an operator neutral word veto a built-in signal", () => {
    const v = vocabulary({ expense: ["hospitality"], neutral: ["reimbursable"] });
    expect(signalOf("Guest Hospitality", v)).toBe("expense");
    expect(signalOf("Medical Reimbursable", v)).toBeNull();
    expect(signalOf("Guest Hospitality", builtIn)).toBeNull();
  });

  it("lets an operator word win a clash with a built-in word of either kind", () => {
    const v = vocabulary({ expense: ["sales", "interest"], neutral: ["medical"] });
    expect(signalOf("Sales Promotion", v)).toBe("expense");
    expect(signalOf("Interest Paid", v)).toBe("expense");
    expect(signalOf("Medical Expenses", v)).toBeNull();
    expect(signalOf("Sales Promotion", builtIn)).toBe("income");
    expect(signalOf("Interest Paid", builtIn)).toBeNull();
  });

  it("keeps the built-in word lists disjoint", () => {
    const all = [...Object.values(SIGNAL_WORDS).flat(), ...NEUTRAL_WORDS];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("natureOfPrimary", () => {
  it.each([
    ["Capital Account", "capital"],
    ["Loans (Liability)", "liability"],
    ["current liabilities", "liability"],
    ["Fixed Assets", "asset"],
    ["Investments", "asset"],
    ["Current Assets", "asset"],
    ["Misc. Expenses (ASSET)", "asset"],
    ["Sales Accounts", "income"],
    ["Direct Incomes", "income"],
    ["Indirect Incomes", "income"],
    ["Purchase Accounts", "expense"],
    ["Direct Expenses", "expense"],
    ["Indirect Expenses", "expense"],
  ])("reads %s as %s", (group, nature) => {
    expect(natureOfPrimary(group)).toBe(nature);
  });

  it("says nothing for Suspense A/c, Branch / Divisions or a group that is not primary", () => {
    expect(natureOfPrimary("Suspense A/c")).toBeNull();
    expect(natureOfPrimary("Branch / Divisions")).toBeNull();
    expect(natureOfPrimary("Sundry Creditors")).toBeNull();
  });
});
