import { describe, expect, it } from "vitest";
import { allocateToAssets, analyzeDepreciation, type BlockResult, type DepCtx } from "../src/depreciation.js";
import { EMPTY_DEP_OPERATOR } from "../src/depreciation-file.js";
import type { LedgerVoucherRow } from "../src/downstream.js";

const block = (over: Partial<BlockResult> = {}): BlockResult => ({
  block: "Block 15%", rate: 15, openingWdv: 0, additionsFull: 0, additionsHalf: 0,
  deductions: 0, wdvBeforeDep: 0, normalDepreciation: 0, additionalDepreciation: 0,
  totalDepreciation: 0, closingWdv: 0, shortTermGain: 0, shortTermLoss: 0, status: "ok", ...over,
});

describe("allocateToAssets", () => {
  it("splits the statutory block figure pro-rata to each asset's own computation", () => {
    const got = allocateToAssets(block({ totalDepreciation: 300 }), [
      { ledger: "A", own: 100 }, { ledger: "B", own: 200 },
    ]);
    expect(got.get("A")).toBeCloseTo(100, 2);
    expect(got.get("B")).toBeCloseTo(200, 2);
  });

  it("sums EXACTLY to the block total even when the parts do not", () => {
    const got = allocateToAssets(block({ totalDepreciation: 1000 }), [
      { ledger: "A", own: 333.33 }, { ledger: "B", own: 333.33 }, { ledger: "C", own: 333.33 },
    ]);
    const sum = [...got.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1000, 2);
  });

  it("gives every asset nil when the block's statutory figure is nil", () => {
    const got = allocateToAssets(block({ totalDepreciation: 0, status: "extinguished" }), [
      { ledger: "A", own: 500 }, { ledger: "B", own: 500 },
    ]);
    expect(got.get("A")).toBe(0);
    expect(got.get("B")).toBe(0);
  });

  it("does not divide by zero when no asset has an own figure", () => {
    const got = allocateToAssets(block({ totalDepreciation: 100 }), [{ ledger: "A", own: 0 }]);
    expect(got.get("A")).toBe(0);
  });
});

const ROOTS: Record<string, string> = {
  "Depreciation A/c": "Indirect Expenses",
  "Machinery Supplier": "Sundry Creditors",
  "Sale of Fixed Asset A/c": "Sales Accounts",
  "Buyer of Plant": "Sundry Debtors",
};
const GROUPS: Record<string, string> = { "Mixer Plant 2": "Block 15%", "Site Shed": "Fixed Assets" };

const row = (date: string, counterparty: string, amount: number, voucherType = "Jrnl"): LedgerVoucherRow =>
  ({ date, voucherType, voucherNumber: "1", reference: "", counterparty, amount, matchStatus: "matched", tax: null });

const ctxFor = (over: Partial<DepCtx> = {}): DepCtx => ({
  fromDate: "20250401", toDate: "20260331", operator: EMPTY_DEP_OPERATOR,
  groupOf: (l) => GROUPS[l] ?? "", groupRootOf: (l) => ROOTS[l] ?? "",
  isAssetLedger: (l) => l in GROUPS,
  openingWdv: () => ({ amount: 0, source: "book-seed" }),
  bookOpening: () => 0, bookClosing: () => 0,
  additionalDepreciationEligible: () => false, ...over,
});

describe("analyzeDepreciation", () => {
  it("reports the Act charge, the book charge and the difference per asset", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250515", "Machinery Supplier", 1000000, "Purc"),
        row("20260303", "Depreciation A/c", -150000),
      ] }],
      disposalSignals: [],
      depreciationLedgerDebits: 150000,
    }, ctxFor());
    const asset = r.assets.find((a) => a.ledger === "Mixer Plant 2");
    expect(asset?.actDepreciation).toBeCloseTo(150000, 2);
    expect(asset?.bookCharge).toBeCloseTo(150000, 2);
    expect(asset?.difference).toBeCloseTo(0, 2);
    expect(r.findings.filter((f) => f.check === "dep_book_charge_differs")).toHaveLength(0);
  });

  it("raises dep_book_charge_missing where an asset carries cost but no charge", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20260320", "Machinery Supplier", 473400, "Purc")] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ctxFor());
    expect(r.findings.map((f) => f.check)).toContain("dep_book_charge_missing");
  });

  it("raises dep_charge_predates_acquisition when the journal is dated before the purchase", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250601", "Machinery Supplier", 100000, "Purc"),
        row("20260303", "Depreciation A/c", -15000),
      ] }, { ledger: "Site Shed", rows: [row("20260320", "Machinery Supplier", 50000, "Purc")] }],
      disposalSignals: [], depreciationLedgerDebits: 15000,
    }, ctxFor({ operator: { ...EMPTY_DEP_OPERATOR, rateOverrides: [{ ledger: "Site Shed", rate: 15, reason: "shed" }] } }));
    expect(r.findings.map((f) => f.check)).toContain("dep_charge_predates_acquisition");
  });

  it("excludes an unclassified credit from every figure and flags it", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250515", "Machinery Supplier", 1000000, "Purc"),
        row("20250901", "Mystery Account", -90000),
        row("20260303", "Depreciation A/c", -150000),
      ] }],
      disposalSignals: [], depreciationLedgerDebits: 150000,
    }, ctxFor());
    expect(r.excluded).toHaveLength(1);
    expect(r.findings.map((f) => f.check)).toContain("dep_credit_unclassified");
    // The block is unchanged by the excluded credit: still 15% of 10,00,000.
    expect(r.blocks[0].totalDepreciation).toBeCloseTo(150000, 2);
  });

  it("raises dep_disposal_outside_block for proceeds with no matching asset credit", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20260303", "Depreciation A/c", -15000)] }],
      disposalSignals: [{ ledger: "Sale of Fixed Asset A/c", rows: [row("20250630", "Buyer of Plant", -962000, "Sale")] }],
      depreciationLedgerDebits: 15000,
    }, ctxFor({ openingWdv: () => ({ amount: 100000, source: "book-seed" }) }));
    expect(r.findings.map((f) => f.check)).toContain("dep_disposal_outside_block");
  });

  it("raises dep_book_charge_unreconciled when the expense ledger disagrees", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20260303", "Depreciation A/c", -15000)] }],
      disposalSignals: [], depreciationLedgerDebits: 99999,
    }, ctxFor());
    expect(r.findings.map((f) => f.check)).toContain("dep_book_charge_unreconciled");
  });

  it("raises dep_block_rate_unresolved and dep_asset_ledger_outside_block together", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Site Shed", rows: [row("20250601", "Machinery Supplier", 50000, "Purc")] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ctxFor());
    const checks = r.findings.map((f) => f.check);
    expect(checks).toContain("dep_block_rate_unresolved");
    expect(checks).toContain("dep_asset_ledger_outside_block");
  });

  it("marks the whole result an unverified seed when no operator opening WDV was given", () => {
    const r = analyzeDepreciation({ ledgerRows: [], disposalSignals: [], depreciationLedgerDebits: 0 }, ctxFor());
    expect(r.seedSource).toBe("book-seed");
    expect(r.findings.map((f) => f.check)).toContain("dep_opening_wdv_unverified");
  });

  it("puts money through money() and dates through displayDate() in every detail", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250515", "Machinery Supplier", 1234567, "Purc"),
        row("20250901", "Mystery Account", -90000),
      ] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ctxFor());
    for (const f of r.findings) {
      expect(f.detail).not.toMatch(/\d{6,}/);       // scrubDigits would eat it
      expect(f.detail).not.toMatch(/\b\d{8}\b/);    // a raw YYYYMMDD
    }
  });
});

describe("analyzeDepreciation carried obligations", () => {
  // Task 7 review: rule-3 debits (attach-to-nothing on a ledger with a NON-NIL
  // opening balance) are dropped from groupAcquisitions' Acquisition[]; design
  // §10 rule 3 says they join the opening written-down value at the FULL rate.
  it("adds a rule-3 debit to the block's opening WDV at the full rate, not the half rate", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20260320", "Bank of Baroda", 40000)] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ctxFor({
      operator: { ...EMPTY_DEP_OPERATOR, openingWdv: [{ block: "Block 15%", rate: 15, amount: 100000 }] },
      openingWdv: () => ({ amount: 100000, source: "operator" }),
      bookOpening: (l) => (l === "Mixer Plant 2" ? 100000 : 0),
      bookClosing: (l) => (l === "Mixer Plant 2" ? 140000 : 0),
    }));
    expect(r.blocks[0].openingWdv).toBeCloseTo(140000, 2);   // 1,00,000 + 40,000
    expect(r.blocks[0].totalDepreciation).toBeCloseTo(21000, 2); // 15% full, not the 20260320 half
    const asset = r.assets.find((a) => a.ledger === "Mixer Plant 2");
    expect(asset?.opening).toBeCloseTo(140000, 2);
    expect(asset?.actDepreciation).toBeCloseTo(21000, 2);
    expect(asset?.shortPeriod).toBe(false);
  });
});
