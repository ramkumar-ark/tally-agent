import { describe, expect, it } from "vitest";
import {
  PURCHASE_VOUCHER, SALE_PL_NAME, CHARGE_NAME, TAX_NAME, DEFAULT_BLOCK_LISTS,
  DEP3CD_CONFIRM, rateOfBlock, ADDITIONAL_DEPRECIATION_TEXT,
  INCLUDE_SAME_VOUCHER_CHARGES,
} from "../src/dep3cd-law.js";

describe("dep3cd law table", () => {
  it("purchase-class voucher types", () => {
    for (const t of ["Purchase", "GST/inwrd/Txble", "Purchase - Capital", "Inward Supply"]) expect(PURCHASE_VOUCHER.test(t)).toBe(true);
    for (const t of ["Journal", "Payment", "Debit Note", "Receipt"]) expect(PURCHASE_VOUCHER.test(t)).toBe(false);
  });
  it("P/L-on-sale names, never a sales or depreciation ledger", () => {
    for (const n of ["Profit on Sale of Fixed Asset", "Loss on Sale of Fixed Asset A/c", "Gain on disposal"]) expect(SALE_PL_NAME.test(n)).toBe(true);
    for (const n of ["Sale of Fixed Asset A/c", "Depreciation A/c", "Sales Account"]) expect(SALE_PL_NAME.test(n)).toBe(false);
  });
  it("charge and tax vocabularies", () => {
    expect(CHARGE_NAME.test("Loading and Unloading-Purchase - 18% A/c")).toBe(true);
    expect(CHARGE_NAME.test("Freight Inward")).toBe(true);
    expect(CHARGE_NAME.test("Office Rent")).toBe(false);
    for (const n of ["Input CGST A/c", "Output SGST A/c", "Input IGST", "CGST- Input to Be Claimed A/c", "TCS Receivable"]) expect(TAX_NAME.test(n)).toBe(true);
  });
  it("default block lists mirror the AY 2026-27 workbook exactly", () => {
    expect(DEFAULT_BLOCK_LISTS.additions).toEqual([
      "1. Buildings 5%:", "2. Buildings 10%:", "3. Buildings 40%:", "4. Furnitures/ fittings 10%:",
      "5. Plant/ Machinery 15%:", "6. Plant/ Machinery 30%:", "7. Plant/ Machinery 40%:",
      "9. Ships/ vessels 20%:", "10. Intangible assets 25%:",
    ]);
    expect(DEFAULT_BLOCK_LISTS.deletions).toContain("8. Plant/ Machinery 45%:");
    expect(DEFAULT_BLOCK_LISTS.deletions).toHaveLength(10);
  });
  it("rateOfBlock reads the item's percentage, not its ordinal", () => {
    expect(rateOfBlock("10. Intangible assets 25%:")).toBe(25);
    expect(rateOfBlock("5. Plant/ Machinery 15%:")).toBe(15);
    expect(rateOfBlock("no rate")).toBeNull();
  });
  it("confirm table carries C1..C15 with sources", () => {
    expect(DEP3CD_CONFIRM.map((c) => c.id)).toEqual(Array.from({ length: 15 }, (_, i) => `C${i + 1}`));
    for (const c of DEP3CD_CONFIRM) expect(c.source.length).toBeGreaterThan(0);
    expect(ADDITIONAL_DEPRECIATION_TEXT).toBe("N/A");
  });
  it("expensed same-voucher charges are not added (captain ruling)", () => {
    expect(INCLUDE_SAME_VOUCHER_CHARGES).toBe(false);
  });
});