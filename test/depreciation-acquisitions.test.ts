import { describe, expect, it } from "vitest";
import { groupAcquisitions, netDiscounts, type DepCtx } from "../src/depreciation.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_DEP_OPERATOR } from "../src/depreciation-file.js";

const ROOTS: Record<string, string> = {
  "Machinery Supplier": "Sundry Creditors",
  "Car Dealer": "Sundry Creditors",
  "Company Bank OD": "Bank Accounts",
};

const ctx = (over: Partial<DepCtx> = {}): DepCtx => ({
  fromDate: "20250401", toDate: "20260331", operator: EMPTY_DEP_OPERATOR,
  groupOf: () => "Block 15%", groupRootOf: (l) => ROOTS[l] ?? "",
  isAssetLedger: () => false,
  openingWdv: () => ({ amount: 0, source: "book-seed" }),
  bookOpening: () => 0, bookClosing: () => 0,
  additionalDepreciationEligible: () => false,
  ...over,
});

const dr = (date: string, counterparty: string, amount: number, voucherType = "Purc"): LedgerVoucherRow =>
  ({ date, voucherType, voucherNumber: "1", reference: "", counterparty, amount, matchStatus: "matched", tax: null });
const cr = (date: string, counterparty: string, amount: number, voucherType = "D/Note"): LedgerVoucherRow =>
  ({ date, voucherType, voucherNumber: "1", reference: "", counterparty, amount: -amount, matchStatus: "matched", tax: null });

describe("groupAcquisitions", () => {
  it("keeps a later bank instalment on the SAME acquisition, at the first entry's date", () => {
    const rows = [
      dr("20250912", "Machinery Supplier", 3250000),
      dr("20251119", "Company Bank OD", 316332.16, "Pymt"),
    ];
    const got = groupAcquisitions("Roller 9", rows, ctx());
    expect(got).toHaveLength(1);
    expect(got[0].firstUse).toBe("20250912");
    expect(got[0].cost).toBeCloseTo(3566332.16, 2);
  });

  it("keeps same-day journals from the same supplier on one acquisition", () => {
    const rows = [
      dr("20250410", "Car Dealer", 1955836),
      dr("20250410", "Car Dealer", 407080, "Jrnl"),
      dr("20250422", "Company Bank OD", 40000, "Pymt"),
      dr("20250519", "Car Dealer", 9999, "Jrnl"),
    ];
    const got = groupAcquisitions("Staff Car 4", rows, ctx());
    expect(got).toHaveLength(1);
    expect(got[0].firstUse).toBe("20250410");
    expect(got[0].cost).toBeCloseTo(2412915, 2);
  });

  it("opens a SECOND acquisition for the same supplier beyond the 90-day gap", () => {
    const rows = [
      dr("20250410", "Machinery Supplier", 100000),
      dr("20251215", "Machinery Supplier", 60000),
    ];
    const got = groupAcquisitions("Pooled Equipment", rows, ctx());
    expect(got).toHaveLength(2);
    expect(got.map((a) => a.firstUse)).toEqual(["20250410", "20251215"]);
  });

  it("opens an acquisition for a bank debit when the ledger opened at nil", () => {
    const rows = [dr("20250905", "Company Bank OD", 50000, "Pymt")];
    const got = groupAcquisitions("New Tool", rows, ctx({ bookOpening: () => 0 }));
    expect(got).toHaveLength(1);
    expect(got[0].firstUse).toBe("20250905");
  });

  it("attaches a bank debit to the opening WDV when the ledger already carried value", () => {
    const rows = [dr("20250905", "Company Bank OD", 50000, "Pymt")];
    const got = groupAcquisitions("Old Tool", rows, ctx({ bookOpening: () => 120000 }));
    expect(got).toHaveLength(0);   // it is cost of an asset already in use, not a new acquisition
  });
});

describe("netDiscounts", () => {
  it("nets a supplier credit note raised the day after the invoice", () => {
    const acqs = groupAcquisitions("Tipper 7", [dr("20250515", "Machinery Supplier", 4094167.67)], ctx());
    const { netted, unattributed } = netDiscounts(acqs, [{ row: cr("20250516", "Machinery Supplier", 207031.25) }], ctx());
    expect(unattributed).toHaveLength(0);
    expect(netted[0].cost - netted[0].netted).toBeCloseTo(3887136.42, 2);
  });

  it("does not net a credit from a different supplier", () => {
    const acqs = groupAcquisitions("Tipper 7", [dr("20250515", "Machinery Supplier", 100000)], ctx());
    const { unattributed } = netDiscounts(acqs, [{ row: cr("20250516", "Car Dealer", 5000) }], ctx());
    expect(unattributed).toHaveLength(1);
  });

  it("does not net a credit outside the 30-day window", () => {
    const acqs = groupAcquisitions("Tipper 7", [dr("20250515", "Machinery Supplier", 100000)], ctx());
    const { unattributed } = netDiscounts(acqs, [{ row: cr("20250720", "Machinery Supplier", 5000) }], ctx());
    expect(unattributed).toHaveLength(1);
  });

  it("nets the nearest acquisition first when two qualify, and is deterministic", () => {
    const acqs = groupAcquisitions("Pooled Equipment", [
      dr("20250401", "Machinery Supplier", 10000),
      dr("20250720", "Machinery Supplier", 10000),
    ], ctx());
    const run = () => netDiscounts(acqs.map((a) => ({ ...a, netted: 0 })), [{ row: cr("20250715", "Machinery Supplier", 3000) }], ctx());
    const a = run();
    const b = run();
    expect(a.netted[1].netted).toBe(3000);   // 20250720 is nearer to 20250715
    expect(a.netted[0].netted).toBe(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never drives an acquisition below nil; the remainder is unattributed", () => {
    const acqs = groupAcquisitions("Tipper 7", [dr("20250515", "Machinery Supplier", 1000)], ctx());
    const { netted, unattributed } = netDiscounts(acqs, [{ row: cr("20250516", "Machinery Supplier", 2500) }], ctx());
    expect(netted[0].netted).toBe(1000);
    expect(unattributed).toHaveLength(1);
  });
});
