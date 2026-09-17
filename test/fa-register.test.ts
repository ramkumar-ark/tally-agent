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

import { ACCESSORY_NAME, COST_VOCAB, inVehicleWindow, isVehicleAsset, INSURANCE_NAME, RTO_NAME, VEHICLE_NAME } from "../src/fa-register.js";

describe("vehicle recognition", () => {
  it("matches a vehicle by ledger name or by block group name", () => {
    expect(isVehicleAsset("Tipper Lorry 3", "Block 30%")).toBe(true);
    expect(isVehicleAsset("Office Equipment", "Motor Vehicles")).toBe(true);
    expect(VEHICLE_NAME.test("HDFC Car Loan")).toBe(true); // loan ledger, not an asset row: guarded by caller
  });

  it("does not match plant, furniture, or GST-rate-suffixed names", () => {
    expect(isVehicleAsset("Mixer Plant 2", "Block 15%")).toBe(false);
    expect(isVehicleAsset("Carrier Pumps - 18%", "Block 15%")).toBe(false); // \bcar\b must not hit "Carrier"
    expect(isVehicleAsset("Vandana Traders", "Block 15%")).toBe(false);     // \bvan\b must not hit "Vandana"
    expect(isVehicleAsset("Computers", "Block 40%")).toBe(false);
  });

  it("matches the three cost vocabularies", () => {
    expect(INSURANCE_NAME.test("Bharat General Insurance")).toBe(true);
    expect(INSURANCE_NAME.test("Insurance Expenses")).toBe(true);
    expect(RTO_NAME.test("RTO and Registration Fees")).toBe(true);
    expect(RTO_NAME.test("Road Tax Payable")).toBe(true);
    expect(ACCESSORY_NAME.test("Auto Accessories Exp")).toBe(true);
    expect(COST_VOCAB.rto.test("Registration")).toBe(true);
    expect(COST_VOCAB.insurance.test("Freight")).toBe(false);
  });

  it("windows a cost 30 days before through 90 days after first use", () => {
    expect(inVehicleWindow("20250710", "20250610")).toBe(true);   // exactly 30 before
    expect(inVehicleWindow("20250710", "20250609")).toBe(false);  // 31 before
    expect(inVehicleWindow("20250710", "20251008")).toBe(true);   // exactly 90 after
    expect(inVehicleWindow("20250710", "20251009")).toBe(false);  // 91 after
  });
});
