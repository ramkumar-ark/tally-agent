import { describe, expect, it } from "vitest";
import { findingId, sideOf } from "../src/types.js";

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
