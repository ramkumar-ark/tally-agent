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
    // The acquisition is a vehicle with no insurance/RTO anywhere: the absence
    // check fires (captain steering), and nothing else does.
    expect(r.findings.filter((f) => f.check === "fa_vehicle_incidental_missing")).toHaveLength(2);
    expect(r.findings.filter((f) => f.check !== "fa_vehicle_incidental_missing")).toHaveLength(0);
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

describe("vehicle incidental-cost check", () => {
  const vehiclePurchase = [
    row("20250710", "Safe Motors", 2000000, "Purc", "PUR/101", "INV-2201"),
  ];

  it("shows all three costs capitalised when they are debited in the vehicle ledger", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Tipper Lorry 3", rows: [
        ...vehiclePurchase,
        row("20250715", "Bharat General Insurance", 46000, "Jrnl", "J/501"),
        row("20250718", "RTO Office", 21000, "Jrnl", "J/502"),
        row("20250901", "Style Auto Accessories", 12500, "Jrnl", "J/530"),
      ] }],
      incidentalExpenseRows: [], disposalSignals: [],
    }, ctxFor());
    expect(r.findings.filter((f) => f.check.startsWith("fa_vehicle"))).toHaveLength(0);
    expect(r.purchases[0].incidentalSummary).toBe(
      "insurance: capitalised; rto: capitalised; accessories: capitalised",
    );
  });

  it("flags each cost sitting in an expense ledger, naming the ledger and the amount", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Tipper Lorry 3", rows: vehiclePurchase }],
      incidentalExpenseRows: [
        { ledger: "Insurance Expenses", rows: [row("20250712", "HDFC Bank", 46000)] },
        { ledger: "RTO and Registration", rows: [row("20250720", "HDFC Bank", 21000)] },
        { ledger: "Auto Accessories Exp", rows: [row("20250815", "HDFC Bank", 12500)] },
      ],
      disposalSignals: [],
    }, ctxFor());
    const expensed = r.findings.filter((f) => f.check === "fa_vehicle_incidental_expensed");
    expect(expensed).toHaveLength(3);
    expect(expensed.map((f) => f.amount).sort((a, b) => a - b)).toEqual([12500, 21000, 46000]);
    for (const f of expensed) {
      expect(f.detail).toContain("s.43(1)");
      expect(f.ledger).toBe("Tipper Lorry 3");
    }
    expect(r.findings.filter((f) => f.check === "fa_vehicle_incidental_missing")).toHaveLength(0);
    const ins = r.findings.find((f) => f.detail.includes("Insurance Expenses"));
    expect(ins?.detail).toContain("46,000.00");
  });

  it("does not trigger for a non-vehicle asset", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20250710", "Machinery Supplier", 800000, "Purc")] }],
      incidentalExpenseRows: [
        { ledger: "Insurance Expenses", rows: [row("20250712", "HDFC Bank", 46000)] },
      ],
      disposalSignals: [],
    }, ctxFor());
    expect(r.findings.filter((f) => f.check.startsWith("fa_vehicle"))).toHaveLength(0);
    expect(r.purchases.every((p) => !p.isVehicle)).toBe(true);
  });

  it("flags missing insurance and RTO, but not missing accessories", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Tipper Lorry 3", rows: vehiclePurchase }],
      incidentalExpenseRows: [], disposalSignals: [],
    }, ctxFor());
    const missing = r.findings.filter((f) => f.check === "fa_vehicle_incidental_missing");
    expect(missing.map((f) => f.ledger)).toEqual(["Tipper Lorry 3", "Tipper Lorry 3"]);
    expect(missing.every((f) => /insurance|rto/.test(f.detail))).toBe(true);
    expect(missing[0].detail).toContain("included in the supplier's invoice");
  });

  it("ignores an expense debit outside the window, and flags the absence instead", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Tipper Lorry 3", rows: vehiclePurchase }],
      incidentalExpenseRows: [
        { ledger: "Insurance Expenses", rows: [row("20250609", "HDFC Bank", 46000)] },  // 31 days before first use
        { ledger: "RTO and Registration", rows: [row("20251009", "HDFC Bank", 21000)] }, // 91 days after
      ],
      disposalSignals: [],
    }, ctxFor());
    expect(r.findings.filter((f) => f.check === "fa_vehicle_incidental_expensed")).toHaveLength(0);
    expect(r.findings.filter((f) => f.check === "fa_vehicle_incidental_missing")).toHaveLength(2);
  });

  it("emits ONE ambiguous finding when two vehicle acquisitions share the window", () => {
    const r = analyzeFaRegister({
      ledgerRows: [
        { ledger: "Tipper Lorry 3", rows: vehiclePurchase },
        { ledger: "Site Van 2", rows: [row("20250801", "Safe Motors", 900000, "Purc")] },
      ],
      incidentalExpenseRows: [
        { ledger: "Insurance Expenses", rows: [row("20250805", "HDFC Bank", 46000)] },
      ],
      disposalSignals: [],
    }, ctxFor({
      groupOf: (l) => (l === "Site Van 2" ? "Block 30%" : GROUPS[l] ?? ""),
      isAssetLedger: (l) => l === "Tipper Lorry 3" || l === "Site Van 2" || l === "Mixer Plant 2",
    }));
    const expensed = r.findings.filter((f) => f.check === "fa_vehicle_incidental_expensed");
    expect(expensed).toHaveLength(1);
    expect(expensed[0].detail).toContain("ambiguous");
    expect(expensed[0].detail).toContain("Tipper Lorry 3");
    expect(expensed[0].detail).toContain("Site Van 2");
  });
});

describe("vehicle vendor settlement", () => {
  it("flags a vendor whose ledger is not squared off, with side and amount", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Tipper Lorry 3", rows: [row("20250710", "Safe Motors", 2000000, "Purc")] }],
      incidentalExpenseRows: [
        { ledger: "Insurance Expenses", rows: [row("20250712", "HDFC Bank", 46000)] },
        { ledger: "RTO and Registration", rows: [row("20250720", "HDFC Bank", 21000)] },
      ],
      disposalSignals: [],
    }, ctxFor({ closingBalanceOf: (l) => (l === "Safe Motors" ? -150000 : 0) }));
    const unsettled = r.findings.filter((f) => f.check === "fa_vehicle_vendor_unsettled");
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0].ledger).toBe("Safe Motors");
    expect(unsettled[0].amount).toBe(150000);
    expect(unsettled[0].detail).toContain("1,50,000.00");
    expect(unsettled[0].detail).toContain("Cr");
    expect(r.vendors).toHaveLength(1);
    expect(r.vendors[0]).toMatchObject({
      vendor: "Safe Motors", vehicles: ["Tipper Lorry 3"], acquisitionsTotal: 2000000,
      closingBalance: -150000, side: "Cr", squaredOff: false,
    });
  });

  it("does not flag a squared-off vendor", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Tipper Lorry 3", rows: [row("20250710", "Safe Motors", 2000000, "Purc")] }],
      incidentalExpenseRows: [], disposalSignals: [],
    }, ctxFor());
    expect(r.findings.filter((f) => f.check === "fa_vehicle_vendor_unsettled")).toHaveLength(0);
    expect(r.vendors[0].squaredOff).toBe(true);
  });
});

describe("disposal signals", () => {
  it("lists an unmatched disposal-signal row and flags it; a matched one is listed without a finding", () => {
    const r = analyzeFaRegister({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250630", "Buyer of Plant", -300000, "Sale", "SL/9"),
      ] }],
      incidentalExpenseRows: [],
      disposalSignals: [
        { ledger: "Sale of Fixed Asset A/c", rows: [
          row("20250630", "Buyer of Plant", -300000, "Sale", "SL/9"),  // matches the asset credit
          row("20251005", "Buyer of Plant", -96000, "Sale", "SL/14"),   // no matching asset credit
        ] },
      ],
    }, ctxFor());
    const signals = r.disposals.filter((d) => d.kind === "disposal-signal");
    expect(signals).toHaveLength(2);
    expect(signals[0].note).toContain("matched");
    expect(signals[1].note).toContain("no matching credit");
    const unmatched = r.findings.filter((f) => f.check === "fa_disposal_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].amount).toBe(96000);
    expect(unmatched[0].detail).toContain("96,000.00");
  });
});

describe("FA ordering and derived views", () => {
  it("numbers findings per check (ordinal then ledger) and links rows and summaries to ids", () => {
    const r = analyzeFaRegister({
      ledgerRows: [
        { ledger: "Tipper Lorry 3", rows: [row("20250710", "Safe Motors", 2000000, "Purc")] },
        { ledger: "Site Van 2", rows: [row("20250801", "Safe Motors", 900000, "Purc")] },
      ],
      incidentalExpenseRows: [
        { ledger: "Insurance Expenses", rows: [row("20250712", "HDFC Bank", 46000)] },
      ],
      disposalSignals: [
        { ledger: "Sale of Fixed Asset A/c", rows: [row("20251005", "Buyer of Plant", -96000, "Sale", "SL/14")] },
      ],
    }, ctxFor({
      groupOf: (l) => (l === "Site Van 2" ? "Block 30%" : GROUPS[l] ?? ""),
      isAssetLedger: (l) => ["Tipper Lorry 3", "Site Van 2", "Mixer Plant 2"].includes(l),
      closingBalanceOf: (l) => (l === "Safe Motors" ? -150000 : 0),
    }));
    // One ambiguous expensed insurance hit (window covers both acquisitions), the
    // two rto absences ordered by ledger, one unsettled vendor, one unmatched signal.
    expect(r.findings.map((f) => f.id)).toEqual([
      "FA-001-1", "FA-002-1", "FA-002-2", "FA-003-1", "FA-004-1",
    ]);
    expect(r.vehicleCosts).toHaveLength(6); // 2 vehicles x 3 cost types
    const ins = r.vehicleCosts.filter((v) => v.costType === "insurance");
    expect(ins.every((v) => v.findingId === "FA-001-1" && v.ambiguous)).toBe(true);
    expect(r.vendors[0].findingId).toBe("FA-003-1");
    const tipper = r.purchases.find((p) => p.asset === "Tipper Lorry 3")!;
    expect(tipper.incidentalSummary).toBe(
      "insurance: expensed — FA-001-1; rto: not found — FA-002-2; accessories: none (not flagged)",
    );
    const van = r.purchases.find((p) => p.asset === "Site Van 2")!;
    expect(van.incidentalSummary).toContain("rto: not found — FA-002-1");
  });
});
