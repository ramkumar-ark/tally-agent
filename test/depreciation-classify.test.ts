import { describe, expect, it } from "vitest";
import { classifyCredit, parseRateFromGroup, resolveRate, type DepCtx } from "../src/depreciation.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_DEP_OPERATOR } from "../src/depreciation-file.js";

const credit = (counterparty: string, amount: number, voucherType = "Jrnl"): LedgerVoucherRow => ({
  date: "20260303", voucherType, voucherNumber: "1", reference: "",
  counterparty, amount: -Math.abs(amount), matchStatus: "matched", tax: null,
});

/** A fictional chart of accounts. Nothing here is copied from live books. */
const ROOTS: Record<string, string> = {
  "Depreciation A/c": "Indirect Expenses",
  "Loss on Sale of Asset": "Indirect Expenses",
  "Discount Received": "Indirect Incomes",
  "Sale of Fixed Asset A/c": "Sales Accounts",
  "Machinery Supplier": "Sundry Creditors",
  "Buyer of Plant": "Sundry Debtors",
  "Mixer Plant 2": "Fixed Assets",
  "Site Office Block": "Fixed Assets",
};

const ctx = (over: Partial<DepCtx> = {}): DepCtx => ({
  fromDate: "20250401",
  toDate: "20260331",
  operator: EMPTY_DEP_OPERATOR,
  groupOf: (l) => (l === "Mixer Plant 2" ? "Block 15%" : l === "Site Office Block" ? "Fixed Assets" : ""),
  groupRootOf: (l) => ROOTS[l] ?? "",
  isAssetLedger: (l) => ROOTS[l] === "Fixed Assets",
  openingWdv: () => ({ amount: 0, source: "book-seed" }),
  bookOpening: () => 0,
  bookClosing: () => 0,
  additionalDepreciationEligible: () => false,
  ...over,
});

describe("parseRateFromGroup", () => {
  it("reads the rate a block group names", () => {
    expect(parseRateFromGroup("Block 15%")).toBe(15);
    expect(parseRateFromGroup("Block 40 %")).toBe(40);
  });

  it("reads nothing from a group that names no rate", () => {
    expect(parseRateFromGroup("Fixed Assets")).toBe(null);
  });
});

describe("resolveRate", () => {
  it("takes the rate from the GROUP name", () => {
    expect(resolveRate("Mixer Plant 2", ctx())).toEqual({ rate: 15, source: "group" });
  });

  it("NEVER takes a rate from the LEDGER name — a % there is a GST rate", () => {
    const c = ctx({ groupOf: () => "Block 15%" });
    expect(resolveRate("Wheeled Loader - 28 %", c)).toEqual({ rate: 15, source: "group" });
  });

  it("resolves nothing for a ledger parked directly under Fixed Assets", () => {
    expect(resolveRate("Site Office Block", ctx())).toEqual({ rate: null, source: "none" });
  });

  it("lets an operator override beat the group", () => {
    const c = ctx({
      operator: { ...EMPTY_DEP_OPERATOR, rateOverrides: [{ ledger: "Site Office Block", rate: 10, reason: "shed" }] },
    });
    expect(resolveRate("Site Office Block", c)).toEqual({ rate: 10, source: "operator" });
  });
});

describe("classifyCredit", () => {
  it("C1: an expense counter ledger named for depreciation is the book charge", () => {
    expect(classifyCredit("Mixer Plant 2", credit("Depreciation A/c", 534949.82), ctx()).kind)
      .toBe("depreciation");
  });

  it("C2b: an income counter ledger named for a discount is a discount", () => {
    expect(classifyCredit("Mixer Plant 2", credit("Discount Received", 5000), ctx()).kind)
      .toBe("discount");
  });

  it("C3: a Sales Accounts or debtor counter ledger is a disposal", () => {
    expect(classifyCredit("Mixer Plant 2", credit("Sale of Fixed Asset A/c", 962000, "Sale"), ctx()).kind)
      .toBe("sale");
    expect(classifyCredit("Mixer Plant 2", credit("Buyer of Plant", 962000, "Sale"), ctx()).kind)
      .toBe("sale");
  });

  it("C4: an expense counter ledger named for a loss on sale is a write-off", () => {
    expect(classifyCredit("Mixer Plant 2", credit("Loss on Sale of Asset", 12000), ctx()).kind)
      .toBe("writeoff");
  });

  it("C5: another fixed-asset ledger is a transfer", () => {
    expect(classifyCredit("Mixer Plant 2", credit("Site Office Block", 1000), ctx()).kind)
      .toBe("transfer");
  });

  it("C6: an unresolvable counterparty is unresolved, and says what was missing", () => {
    const got = classifyCredit("Mixer Plant 2", credit("", 900), ctx());
    expect(got.kind).toBe(null);
    expect(got.missing).toMatch(/counter ledger/i);
  });

  it("C6: a counterparty in no known group is unresolved, never guessed", () => {
    expect(classifyCredit("Mixer Plant 2", credit("Some Unknown Account", 900), ctx()).kind).toBe(null);
  });

  it("an operator classification resolves what the rules could not", () => {
    const c = ctx({
      operator: {
        ...EMPTY_DEP_OPERATOR,
        creditClassifications: [
          { ledger: "Mixer Plant 2", date: "20260303", amount: 900, kind: "sale", block: "Block 15%" },
        ],
      },
    });
    const got = classifyCredit("Mixer Plant 2", credit("Some Unknown Account", 900), c);
    expect(got.kind).toBe("sale");
    expect(got.rule).toBe("operator");
  });
});
