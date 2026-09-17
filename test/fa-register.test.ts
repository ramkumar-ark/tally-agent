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

import { analyzeFaRegister, type FaCtx } from "../src/fa-register.js";
import type { LedgerVoucherRow } from "../src/downstream.js";

const ROOTS: Record<string, string> = {
  "Depreciation A/c": "Indirect Expenses",
  "Machinery Supplier": "Sundry Creditors",
  "Safe Motors": "Sundry Creditors",
  "Bharat General Insurance": "Sundry Creditors",
  "RTO Office": "Sundry Creditors",
  "Style Auto Accessories": "Sundry Creditors",
  "HDFC Bank": "Bank Accounts",
  "Insurance Expenses": "Indirect Expenses",
  "RTO and Registration": "Indirect Expenses",
  "Auto Accessories Exp": "Indirect Expenses",
  "Sale of Fixed Asset A/c": "Sales Accounts",
  "Buyer of Plant": "Sundry Debtors",
  "Loss on Sale of Asset": "Indirect Expenses",
};
const GROUPS: Record<string, string> = {
  "Mixer Plant 2": "Block 15%",
  "Tipper Lorry 3": "Block 30%",
  "Site Shed": "Fixed Assets",
};
const row = (
  date: string, counterparty: string, amount: number,
  voucherType = "Jrnl", voucherNumber = "1", reference = "",
): LedgerVoucherRow =>
  ({ date, voucherType, voucherNumber, reference, counterparty, amount, matchStatus: "matched" });

const ctxFor = (over: Partial<FaCtx> = {}): FaCtx => ({
  fromDate: "20250401", toDate: "20260331",
  groupOf: (l) => GROUPS[l] ?? "", groupRootOf: (l) => ROOTS[l] ?? "",
  isAssetLedger: (l) => l in GROUPS,
  bookOpening: () => 0, closingBalanceOf: () => 0, ...over,
});

describe("analyzeFaRegister purchases", () => {
  it("lists one row per acquisition debit, with voucher identification and instalment numbering", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Tipper Lorry 3", rows: [
        row("20250710", "Safe Motors", 2000000, "Purc", "PUR/101", "INV-2201"),
        row("20251110", "HDFC Bank", 500000, "Payt", "PY/552"),
      ] }],
      incidentalExpenseRows: [], disposalSignals: [],
    }, ctxFor());
    expect(r.purchases).toHaveLength(2);
    const [first, second] = r.purchases;
    expect(first).toMatchObject({
      asset: "Tipper Lorry 3", block: "Block 30%", counterparty: "Safe Motors",
      vendor: "Safe Motors", amount: 2000000, voucherType: "Purc",
      voucherNumber: "PUR/101", reference: "INV-2201",
      acquisitionDate: "20250710", instalment: 1, instalments: 2,
      acquisitionCost: 2500000, rule: "acquisition", isVehicle: true,
    });
    // The bank instalment keeps its own counterparty but the acquisition's vendor stays the supplier.
    expect(second.counterparty).toBe("HDFC Bank");
    expect(second.vendor).toBe("Safe Motors");
    expect(second.instalment).toBe(2);
    expect(second.acquisitionCost).toBe(0); // acquisition-level fields on the first instalment only
    expect(r.findings).toHaveLength(0);
  });

  it("carries rule-3 debits as purchases with rule R3", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20260115", "HDFC Bank", 40000), // attaches to no open acquisition, opening non-nil -> R3
      ] }],
      incidentalExpenseRows: [], disposalSignals: [],
    }, ctxFor({ bookOpening: (l) => (l === "Mixer Plant 2" ? 120000 : 0) }));
    const r3 = r.purchases.find((p) => p.rule === "R3");
    expect(r3).toMatchObject({ amount: 40000, acquisitionDate: "", instalment: 0, isVehicle: false });
  });
});

describe("analyzeFaRegister disposals", () => {
  it("lists sale and write-off credits with their classification and voucher ids", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250630", "Buyer of Plant", -300000, "Sale", "SL/9", "PO-4412"),
        row("20250930", "Loss on Sale of Asset", -50000, "Jrnl", "J/88"),
      ] }],
      incidentalExpenseRows: [], disposalSignals: [],
    }, ctxFor());
    expect(r.disposals.map((d) => [d.kind, d.rule])).toEqual([["sale", "C3"], ["writeoff", "C4"]]);
    expect(r.disposals[0]).toMatchObject({
      asset: "Mixer Plant 2", counterparty: "Buyer of Plant", amount: 300000,
      voucherNumber: "SL/9", reference: "PO-4412",
    });
  });
});
