import { describe, expect, it } from "vitest";
import { TDS_CHECK_ORDINAL, tdsFindingId, type TdsFinding } from "../src/types.js";
import { findingId, LEDGER_CHECK_ORDINAL, ledgerFindingId, sideOf } from "../src/types.js";
import { DEP_CHECK_ORDINAL, depFindingId } from "../src/types.js";

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

describe("ledger_in_wrong_group ids", () => {
  it("takes ordinal 8, after the seven milestone 1 checks", () => {
    expect(findingId("ledger_in_wrong_group", 2)).toBe("TB-008-2");
  });
});

describe("TDS finding space", () => {
  it("builds stable TDS-space ids from its own ordinal table", () => {
    expect(tdsFindingId("tds_not_deducted", 1)).toBe("TDS-001-1");
    expect(tdsFindingId("tds_master_gap", 3)).toBe("TDS-012-3");
  });
  it("keeps 12 checks without touching the TB/GST/LS tables", () => {
    expect(Object.keys(TDS_CHECK_ORDINAL)).toEqual([
      "tds_not_deducted", "tds_short_deducted", "tds_late_deducted",
      "tds_not_deposited", "tds_late_deposit", "tds_statement_late",
      "tds_statement_missing", "tds_deposit_mismatch", "tds_exposure_40a_ia",
      "tds_exposure_271c", "tds_section_unknown", "tds_master_gap",
      "tds_threshold_crossed",
    ]);
  });
  it("a TdsFinding carries deductee, section, amount, detail and schedule rows", () => {
    const f: TdsFinding = {
      id: "TDS-001-1", check: "tds_not_deducted", severity: "critical",
      deductee: "Sample Builders LLP", group: "Sundry Creditors",
      section: "194C", amount: 5000,
      detail: "booking 16-May-2025: no duty credit found",
      schedule: [{ kind: "i", amount: 100, from: "20250516", to: "20250628", basis: "1% of 2 months" }],
    };
    expect(f.schedule?.[0].amount).toBe(100);
  });
});

describe("DEP- finding space", () => {
  it("pads the ordinal to three digits like every other family", () => {
    expect(depFindingId("dep_block_rate_unresolved", 1)).toBe("DEP-001-1");
    expect(depFindingId("dep_additional_depreciation_unclaimed", 4)).toBe("DEP-015-4");
  });

  it("pins the ordinals so they are never renumbered", () => {
    expect(DEP_CHECK_ORDINAL).toEqual({
      dep_block_rate_unresolved: 1,
      dep_asset_ledger_outside_block: 2,
      dep_opening_wdv_unverified: 3,
      dep_rate_not_in_act: 4,
      dep_credit_unclassified: 5,
      dep_discount_unattributed: 6,
      dep_disposal_outside_block: 7,
      dep_book_charge_missing: 8,
      dep_book_charge_differs: 9,
      dep_block_charge_differs: 10,
      dep_book_charge_unreconciled: 11,
      dep_charge_predates_acquisition: 12,
      dep_block_extinguished: 13,
      dep_block_wdv_nil: 14,
      dep_additional_depreciation_unclaimed: 15,
    });
  });
});
