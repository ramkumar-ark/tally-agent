import { describe, expect, it } from "vitest";
import { EMPTY_DEP_OPERATOR, parseDepOperatorFile } from "../src/depreciation-file.js";

const FROM = "20250401";
const TO = "20260331";

const good = JSON.stringify({
  schema: "tally-agent-depreciation.v1",
  financialYear: { from: "2025-04-01", to: "2026-03-31" },
  openingWdv: [{ block: "Block 15%", rate: 15, amount: 4820000 }],
  rateOverrides: [{ ledger: "Asset Suspense", rate: 15, reason: "outside a block group" }],
  assetClass: [{ ledger: "Mixer Plant 2", class: "plant", newAsset: true, additionalDepreciation: true }],
  creditClassifications: [{ ledger: "Tipper Lorry 3", date: "2025-06-30", amount: 962000, kind: "sale", block: "Block 15%" }],
  costAdjustments: [{ ledger: "Mixer Plant 2", date: "2025-05-15", amount: -250000, reason: "capital subsidy" }],
  additionalDepreciationCarryForward: [{ block: "Block 15%", amount: 186000 }],
});

describe("parseDepOperatorFile", () => {
  it("normalises dates and keeps every stanza", () => {
    const f = parseDepOperatorFile(good, FROM, TO);
    expect(f.openingWdv).toEqual([{ block: "Block 15%", rate: 15, amount: 4820000 }]);
    expect(f.creditClassifications[0].date).toBe("20250630");
    expect(f.creditClassifications[0].kind).toBe("sale");
    expect(f.costAdjustments[0].amount).toBe(-250000);
  });

  it("rejects a file whose financial year does not match the review period", () => {
    const wrong = good.replace("2026-03-31", "2025-03-31");
    expect(() => parseDepOperatorFile(wrong, FROM, TO)).toThrow(/financialYear/);
  });

  it("rejects the whole file when one row is malformed, with no partial result", () => {
    const bad = JSON.stringify({
      schema: "tally-agent-depreciation.v1",
      financialYear: { from: "2025-04-01", to: "2026-03-31" },
      openingWdv: [{ block: "Block 15%", rate: 15, amount: 100 }, { block: "", rate: 15, amount: 1 }],
    });
    expect(() => parseDepOperatorFile(bad, FROM, TO)).toThrow(/openingWdv\[1\]/);
  });

  it("never echoes a value in an error message", () => {
    const bad = JSON.stringify({
      schema: "tally-agent-depreciation.v1",
      financialYear: { from: "2025-04-01", to: "2026-03-31" },
      rateOverrides: [{ ledger: "Sundry Secret Machine", rate: "not-a-number" }],
    });
    try {
      parseDepOperatorFile(bad, FROM, TO);
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("rateOverrides[0]");
      expect(msg).not.toContain("Sundry Secret Machine");
      expect(msg).not.toContain("not-a-number");
    }
  });

  it("rejects an unknown credit kind rather than silently dropping it", () => {
    const bad = JSON.stringify({
      schema: "tally-agent-depreciation.v1",
      financialYear: { from: "2025-04-01", to: "2026-03-31" },
      creditClassifications: [{ ledger: "L", date: "2025-06-30", amount: 1, kind: "maybe-a-sale" }],
    });
    expect(() => parseDepOperatorFile(bad, FROM, TO)).toThrow(/creditClassifications\[0\]/);
  });

  it("treats an absent file as empty, not as an error", () => {
    expect(EMPTY_DEP_OPERATOR.openingWdv).toEqual([]);
    expect(EMPTY_DEP_OPERATOR.creditClassifications).toEqual([]);
  });
});
