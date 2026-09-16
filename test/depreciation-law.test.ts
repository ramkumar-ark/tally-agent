import { describe, expect, it } from "vitest";
import {
  ACT_RATES, DEP_LAW_NOTES, MAX_RATE,
  halfRateBoundary, isActRate, isShortPeriod,
} from "../src/depreciation-law.js";

describe("Appendix I rates", () => {
  it("accepts the rates the Act has and rejects one it does not", () => {
    expect(ACT_RATES).toContain(15);
    expect(ACT_RATES).toContain(40);
    expect(isActRate(15)).toBe(true);
    expect(isActRate(12)).toBe(false);
  });

  it("caps at 40% for years from 2017-18", () => {
    expect(MAX_RATE).toBe(40);
    expect(isActRate(60)).toBe(false);
  });
});

describe("the 180-day boundary", () => {
  it("is computed from the year end, not hard-coded", () => {
    // 3-Oct-2025 to 31-Mar-2026 inclusive is exactly 180 days.
    expect(halfRateBoundary("20260331")).toBe("20251004");
  });

  it("gives the full rate at exactly 180 days and half the day after", () => {
    expect(isShortPeriod("20251003", "20260331")).toBe(false);
    expect(isShortPeriod("20251004", "20260331")).toBe(true);
  });

  it("moves with a different year end", () => {
    expect(halfRateBoundary("20251231")).toBe("20250706");
  });
});

describe("the law notes", () => {
  it("carries one note per rule D1..D8, each citing a source", () => {
    expect(DEP_LAW_NOTES.map((n) => n.id)).toEqual(["D1","D2","D3","D4","D5","D6","D7","D8"]);
    for (const n of DEP_LAW_NOTES) expect(n.source.length).toBeGreaterThan(0);
  });
});
