import { describe, expect, it } from "vitest";
import { CHECK_ORDINAL, findingId } from "../src/types.js";

describe("gst44 check ids", () => {
  it("occupy ordinals 15-18 without disturbing the existing space", () => {
    expect(CHECK_ORDINAL.gst44_composition_unknown).toBe(15);
    expect(CHECK_ORDINAL.gst44_unattributed_expenditure).toBe(16);
    expect(CHECK_ORDINAL.gst44_party_not_in_masters).toBe(17);
    expect(CHECK_ORDINAL.gst44_status_override_unknown_ledger).toBe(18);
    expect(CHECK_ORDINAL.pf_esi_due_date_not_working_day).toBe(14);
    expect(findingId("gst44_composition_unknown", 1)).toBe("TB-015-1");
  });
});
