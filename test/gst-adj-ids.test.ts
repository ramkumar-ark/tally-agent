import { describe, expect, it } from "vitest";
import { GADJ_CHECK_ORDINAL, gadjFindingId } from "../src/types.js";

describe("GADJ ordinal space", () => {
  it("has the eight approved checks", () => {
    expect(Object.keys(GADJ_CHECK_ORDINAL).sort()).toEqual([
      "gadj_3b_ledger_mismatch",
      "gadj_books_missing",
      "gadj_claim_exceeds_books",
      "gadj_config_ledger_missing",
      "gadj_list_reappearance",
      "gadj_registration_mismatch",
      "gadj_residual_untraced",
      "gadj_tds_credit_unsupported",
    ]);
  });
  it("formats ids like the other spaces", () => {
    expect(gadjFindingId("gadj_books_missing", 1)).toBe("GADJ-001-1");
  });
});
