import { describe, expect, it } from "vitest";
import { findingId, LEDGER_CHECK_ORDINAL, ledgerFindingId, sideOf } from "../src/types.js";

describe("sideOf", () => {
  it("returns Dr for a positive balance", () => {
    expect(sideOf(41250)).toBe("Dr");
  });

  it("returns Cr for a negative balance", () => {
    expect(sideOf(-41250)).toBe("Cr");
  });

  it("returns null inside the rounding tolerance", () => {
    expect(sideOf(0.004)).toBeNull();
    expect(sideOf(-0.004)).toBeNull();
  });
});

describe("findingId", () => {
  it("builds a stable id from check ordinal and row ordinal", () => {
    expect(findingId("wrong_side_balance", 17)).toBe("TB-004-17");
  });
});

describe("ledgerFindingId", () => {
  it("builds LS-<ledgerSeq>-<ordinal>-<n> ids from a fixed, gap-free ordinal space", () => {
    expect(ledgerFindingId("ls_duplicate_reference", 2, 1)).toBe("LS-2-004-1");
    expect(ledgerFindingId("ls_gst_untaxed_supply", 1, 3)).toBe("LS-1-011-3");
    expect(Object.values(LEDGER_CHECK_ORDINAL).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });
});
