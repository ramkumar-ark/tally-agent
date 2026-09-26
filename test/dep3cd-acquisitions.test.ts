import { describe, expect, it } from "vitest";
import { classifyMovements, buildAcquisitions } from "../src/dep3cd.js";
import { D3_VOUCHERS, fixtureCtx } from "./fixtures/dep3cd-fixture.js";

describe("dep3cd acquisitions", () => {
  const ctx = fixtureCtx();
  const moves = classifyMovements(D3_VOUCHERS, ctx);
  const { additions, findings } = buildAcquisitions(moves, ctx);
  const of = (l: string) => additions.filter((a) => a.ledger === l);

  it("purchase + same-day journal + later bank fee − debit note = one row at the purchase date", () => {
    expect(of("Site Van")).toHaveLength(1);
    expect(of("Site Van")[0]).toMatchObject({ purchaseDate: "20250410", putToUse: "20250410", amount: 535000 });
  });
  it("same-voucher expensed freight is NOT added to the tax cost", () => {
    expect(of("Mixer Unit")[0].amount).toBe(100000);
    expect(findings.some((f) => f.check === "d3cd_charge_capitalised_for_tax")).toBe(false);
  });
  it("same-day twin purchases stay two rows", () => {
    expect(of("Store Box").map((a) => a.amount)).toEqual([200000, 210000]);
    expect(findings.filter((f) => f.check === "d3cd_multiple_purchases_in_ledger")).toHaveLength(1);
  });
  it("profit-on-sale debit is not an addition", () => {
    expect(of("Old Loader")).toHaveLength(0);
    expect(moves.find((m) => m.ledger === "Old Loader" && m.amount > 0)?.kind).toBe("sale_pl");
  });
  it("depreciation credits and GST lines never touch additions", () => {
    expect(moves.filter((m) => m.kind === "depreciation")).toHaveLength(2);
  });
  it("capitalised debit with no purchase this year is an orphan row, cash > 10,000 excluded", () => {
    expect(of("Desk Set")[0]).toMatchObject({ orphan: true, purchaseDate: "20250801", amount: 0 });
    expect(findings.some((f) => f.check === "d3cd_addition_to_existing_asset")).toBe(true);
    expect(findings.some((f) => f.check === "d3cd_cash_payment_in_cost")).toBe(true);
  });
  it("second-half flag follows the 180-day boundary (reported only)", () => {
    expect(of("Notebook PC")[0].secondHalf).toBe(true);
    expect(of("Site Van")[0].secondHalf).toBe(false);
  });
  it("operator 'Merge into earlier purchase' folds the second Store Box purchase", () => {
    const c2 = fixtureCtx({ operator: { groupBlocks: new Map(), ledgerBlocks: new Map(), adjustments: [
      { ledger: "Store Box", date: "20250701", voucherNumber: "P-3", action: "Merge into earlier purchase", amount: null, row: 2 }] } });
    const r = buildAcquisitions(classifyMovements(D3_VOUCHERS, c2), c2).additions.filter((a) => a.ledger === "Store Box");
    expect(r).toHaveLength(1); expect(r[0].amount).toBe(410000);
  });
  it("an adjustment that matches no movement throws citing its row", () => {
    const c3 = fixtureCtx({ operator: { groupBlocks: new Map(), ledgerBlocks: new Map(), adjustments: [
      { ledger: "Store Box", date: "20250702", voucherNumber: "P-9", action: "Exclude", amount: null, row: 7 }] } });
    expect(() => buildAcquisitions(classifyMovements(D3_VOUCHERS, c3), c3)).toThrow(/row 7/);
  });
  it("finding details never carry a bare 6+ digit run", () => {
    for (const f of findings) expect(f.detail).not.toMatch(/\d{6,}/);
  });
});