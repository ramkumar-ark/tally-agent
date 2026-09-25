import { describe, expect, it } from "vitest";
import {
  CONFIRM_POINTS,
  DEFAULT_BANK_MODE,
  LOANS_LIMIT,
  NARRATION_MODE_HINTS,
  NONAC_MODES,
  RECEIPT_MODES,
  S269ST_LIMIT,
} from "../src/loans-law.js";

describe("loans law table", () => {
  it("has the statutory limits", () => {
    expect(LOANS_LIMIT).toBe(20_000); // s.269SS / s.269T
    expect(S269ST_LIMIT).toBe(2_00_000); // s.269ST
  });

  it("RECEIPT_MODES tokens are byte-exact", () => {
    expect([...RECEIPT_MODES]).toEqual([
      "A/c payee Cheque",
      "A/c payee DD",
      "ECS",
      "Credit card",
      "Debit card",
      "Net Banking",
      "IMPS",
      "UPI",
      "RTGS",
      "NEFT",
      "BHIM",
      "Non-A/c payee modes",
      "Other A/c payee modes:",
    ]);
  });

  it("NONAC_MODES tokens are byte-exact", () => {
    expect([...NONAC_MODES]).toEqual([
      "Cash",
      "Cheque (Not a/c payee)",
      "DD (Not a/c payee)",
      "Transfer of asset",
      "Transfer of liability",
      "Conversion of assets",
      "Conversion of liabilities",
      "Journal entry",
      "Others:",
    ]);
  });

  it("NARRATION_MODE_HINTS is first-match-wins ordered", () => {
    expect(NARRATION_MODE_HINTS.map((h) => h.mode)).toEqual(["RTGS", "NEFT", "IMPS", "UPI"]);
    const re = NARRATION_MODE_HINTS[0].re;
    expect(NARRATION_MODE_HINTS[0].re).toBe(re);
    // first match wins: a narration naming two modes resolves to the earliest hint
    const hit = (s: string) => NARRATION_MODE_HINTS.find((h) => h.re.test(s))?.mode;
    expect(hit("NEFT transfer via RTGS ref 5")).toBe("RTGS");
    expect(hit("paid by UPI xyz")).toBe("UPI");
    expect(re.source.length).toBeGreaterThan(0);
  });

  it("DEFAULT_BANK_MODE is the C4 ECS default", () => {
    expect(DEFAULT_BANK_MODE).toBe("ECS");
  });

  it("CONFIRM_POINTS covers C1..C8 with non-empty text", () => {
    expect(CONFIRM_POINTS.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]);
    for (const c of CONFIRM_POINTS) {
      expect(c.point.length).toBeGreaterThan(0);
      expect(c.defaultApplied.length).toBeGreaterThan(0);
    }
  });
});
