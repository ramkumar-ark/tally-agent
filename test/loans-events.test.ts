import { describe, expect, it } from "vitest";
import { buildLoansCtx, loanLedgerEvents, type V } from "../src/loans.js";

const GROUPS = [
  { name: "Loans (Liability)", parent: " Primary" },
  { name: "Unsecured Loans", parent: "Loans (Liability)" },
  { name: "Current Assets", parent: " Primary" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Bank Accounts", parent: "Current Assets" },
];

const MASTERS = [
  { name: "Cash", parent: "Cash-in-Hand" },
  { name: "HDFC Bank", parent: "Bank Accounts" },
  { name: "Party Loan", parent: "Loans (Liability)" },
  { name: "Secured Loan", parent: "Unsecured Loans" },
];

const ctx = buildLoansCtx(MASTERS, GROUPS);

describe("buildLoansCtx ancestry predicates", () => {
  it("identifies loan ledgers through direct and nested group ancestry", () => {
    expect(ctx.isLoanLedger("Party Loan")).toBe(true);
    expect(ctx.isLoanLedger("Secured Loan")).toBe(true);
    expect(ctx.isLoanLedger("HDFC Bank")).toBe(false);
  });

  it("classifies cash and bank ledgers by ancestry membership, not root equality", () => {
    expect(ctx.isCashLedger("Cash")).toBe(true);
    expect(ctx.isBankLedger("HDFC Bank")).toBe(true);
    expect(ctx.isCashLedger("HDFC Bank")).toBe(false);
    expect(ctx.isBankLedger("Cash")).toBe(false);
  });
});

describe("loanLedgerEvents", () => {
  it("extracts a cash acceptance (Dr Cash / Cr Party Loan) with mode cash and coerced date/voucher", () => {
    const v: V = {
      date: 20250415,
      voucherNumber: 101,
      voucherType: "Receipt",
      entries: [
        { ledger: "Cash", amount: 500000 },
        { ledger: "Party Loan", amount: -500000 },
      ],
    };
    const events = loanLedgerEvents([v], ctx);
    expect(events).toEqual([
      {
        date: "20250415",
        party: "Party Loan",
        direction: "accepted",
        amount: 500000,
        mode: "cash",
        narration: "",
        voucherNumber: "101",
      },
    ]);
  });

  it("extracts a bank repayment (Dr Party Loan / Cr Bank) with mode bank", () => {
    const v: V = {
      date: "20250610",
      voucherNumber: "PY-7",
      voucherType: "Payment",
      narration: "loan instalment",
      entries: [
        { ledger: "Party Loan", amount: 200000 },
        { ledger: "HDFC Bank", amount: -200000 },
      ],
    };
    const events = loanLedgerEvents([v], ctx);
    expect(events).toEqual([
      {
        date: "20250610",
        party: "Party Loan",
        direction: "repaid",
        amount: 200000,
        mode: "bank",
        narration: "loan instalment",
        voucherNumber: "PY-7",
      },
    ]);
  });

  it("extracts a financier journal drawdown (Dr Asset / Cr Secured Loan) with mode journal", () => {
    const v: V = {
      date: "20250701",
      voucherNumber: "JV-3",
      entries: [
        { ledger: "Office Equipment", amount: 1000000 },
        { ledger: "Secured Loan", amount: -1000000 },
      ],
    };
    const events = loanLedgerEvents([v], ctx);
    expect(events).toEqual([
      {
        date: "20250701",
        party: "Secured Loan",
        direction: "accepted",
        amount: 1000000,
        mode: "journal",
        narration: "",
        voucherNumber: "JV-3",
      },
    ]);
  });

  it("emits nothing for a cash↔bank contra voucher", () => {
    const v: V = {
      date: "20250702",
      voucherNumber: "CT-1",
      entries: [
        { ledger: "Cash", amount: 50000 },
        { ledger: "HDFC Bank", amount: -50000 },
      ],
    };
    expect(loanLedgerEvents([v], ctx)).toEqual([]);
  });

  it("skips cancelled vouchers", () => {
    const v: V = {
      date: "20250703",
      voucherNumber: "RV-9",
      isCancelled: true,
      entries: [
        { ledger: "Cash", amount: 300000 },
        { ledger: "Party Loan", amount: -300000 },
      ],
    };
    expect(loanLedgerEvents([v], ctx)).toEqual([]);
  });

  it("skips blank entries (entries: [\"\"])", () => {
    const v: V = {
      date: "20250704",
      voucherNumber: "R-2",
      entries: [""],
    };
    expect(loanLedgerEvents([v], ctx)).toEqual([]);
  });

  it("when both cash and bank counters appear, cash wins", () => {
    const v: V = {
      date: "0", // replaced below
      voucherNumber: "MIX-1",
      entries: [
        { ledger: "Cash", amount: 10000 },
        { ledger: "HDFC Bank", amount: 90000 },
        { ledger: "Party Loan", amount: -100000 },
      ],
    };
    const vv = { ...v, date: "20250805" } as V;
    const events = loanLedgerEvents([vv], ctx);
    expect(events).toHaveLength(1);
    expect(events[0].mode).toBe("cash");
  });
});
