import { describe, expect, it } from "vitest";
import { createVault } from "../src/vault.js";
import { faFindingId, FA_CHECK_ORDINAL } from "../src/types.js";

describe("FA finding space", () => {
  it("builds FA ids from its own ordinal space", () => {
    expect(faFindingId("fa_vehicle_incidental_expensed", 2)).toBe("FA-001-2");
    expect(faFindingId("fa_vehicle_vendor_unsettled", 1)).toBe("FA-003-1");
  });

  it("owns four checks numbered 1..4", () => {
    expect(Object.values(FA_CHECK_ORDINAL).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("doc vault role", () => {
  it("mints Doc N aliases, stable per real string", () => {
    const v = createVault();
    expect(v.pseudonym("PUR/918020045566771", "doc")).toBe("Doc 1");
    expect(v.pseudonym("PUR/918020045566771", "doc")).toBe("Doc 1");
    expect(v.pseudonym("INV-2201 PAN ABCDE1234F", "doc")).toBe("Doc 2");
    expect(v.resolve("Doc 1")).toBe("PUR/918020045566771");
  });
});
