import { describe, expect, it } from "vitest";
import {
  analyzeDepreciation, attributeBlockToAssets, computeAssetFigure, isAssetRowInScope,
  type Acquisition, type BlockResult, type DepCtx,
} from "../src/depreciation.js";
import { EMPTY_DEP_OPERATOR } from "../src/depreciation-file.js";
import type { LedgerVoucherRow } from "../src/downstream.js";

const block = (over: Partial<BlockResult> = {}): BlockResult => ({
  block: "Block 15%", rate: 15, openingWdv: 0, additionsFull: 0, additionsHalf: 0,
  deductions: 0, wdvBeforeDep: 0, normalDepreciation: 0, additionalDepreciation: 0,
  totalDepreciation: 0, closingWdv: 0, shortTermGain: 0, shortTermLoss: 0, status: "ok", ...over,
});

const acq = (over: Partial<Acquisition> = {}): Acquisition => ({
  ledger: "A", firstUse: "20250515", cost: 0, counterparty: "Machinery Supplier",
  debits: [], netted: 0, ...over,
});

describe("computeAssetFigure", () => {
  it("rates each acquisition on its own put-to-use, not the asset's earliest", () => {
    // 20,000 put to use 2025-05-15 (a full year) and 10,600 on 2026-01-15
    // (under 180 days before 31-03-2026).
    const f = computeAssetFigure({
      rate: 15, opening: 0, additionalEligible: false, toDate: "20260331", deductions: 0,
      acquisitions: [acq({ cost: 10600, firstUse: "20260115" }), acq({ cost: 20000 })],
    });
    expect(f.additionsHalf).toBe(10600);
    expect(f.additionsFull).toBe(20000);
    expect(f.total).toBeCloseTo(20000 * 0.15 + 10600 * 0.075, 2);   // 3,795.00
  });

  it("nets an asset's own discount off that asset's additions", () => {
    const f = computeAssetFigure({
      rate: 15, opening: 0, additionalEligible: false, toDate: "20260331", deductions: 0,
      acquisitions: [acq({ cost: 3290375, netted: 150000 })],
    });
    expect(f.additionsFull).toBe(3140375);
    expect(f.total).toBeCloseTo(471056.25, 2);
  });

  it("takes its own sale credit off opening first, then the additions pools", () => {
    const f = computeAssetFigure({
      rate: 15, opening: 100000, additionalEligible: false, toDate: "20260331", deductions: 150000,
      acquisitions: [acq({ cost: 100000 })],
    });
    // 1,00,000 off the opening, the remaining 50,000 off the full pool.
    expect(f.total).toBeCloseTo(50000 * 0.15, 2);
  });

  it("floors at nil when its own credit reaches past its own value", () => {
    const f = computeAssetFigure({
      rate: 15, opening: 0, additionalEligible: false, toDate: "20260331", deductions: 50000,
      acquisitions: [acq({ cost: 30000 })],
    });
    expect(f.total).toBe(0);
  });

  it("adds its own s.32(1)(iia) charge, halved on a short-period addition", () => {
    const f = computeAssetFigure({
      rate: 15, opening: 0, additionalEligible: true, toDate: "20260331", deductions: 0,
      acquisitions: [acq({ cost: 100000 }), acq({ cost: 20000, firstUse: "20260115" })],
    });
    expect(f.additionalDepreciation).toBeCloseTo(20000 + 2000, 2);
  });
});

describe("attributeBlockToAssets", () => {
  it("gives each asset its own figure when they tie to the block exactly", () => {
    const got = attributeBlockToAssets(block({ totalDepreciation: 300 }), [
      { ledger: "A", own: 100 }, { ledger: "B", own: 200 },
    ]);
    expect(got.shares.get("A")).toBeCloseTo(100, 2);
    expect(got.shares.get("B")).toBeCloseTo(200, 2);
    expect(got.residual).toBe(0);
  });

  it("absorts a sub-rupee rounding difference into the last asset and reports none", () => {
    const got = attributeBlockToAssets(block({ totalDepreciation: 1000 }), [
      { ledger: "A", own: 333.33 }, { ledger: "B", own: 333.33 }, { ledger: "C", own: 333.33 },
    ]);
    const sum = [...got.shares.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1000, 2);
    expect(got.residual).toBe(0);
  });

  it("returns a genuine block-level difference UNSPREAD rather than pushing it onto an asset", () => {
    const got = attributeBlockToAssets(block({ totalDepreciation: 1000 }), [
      { ledger: "A", own: 400 }, { ledger: "B", own: 400 },
    ]);
    expect(got.shares.get("A")).toBe(400);
    expect(got.shares.get("B")).toBe(400);
    expect(got.residual).toBe(200);
  });

  it("gives every asset nil and no residual when the block's statutory figure is nil", () => {
    const got = attributeBlockToAssets(block({ totalDepreciation: 0, status: "extinguished" }), [
      { ledger: "A", own: 500 }, { ledger: "B", own: 500 },
    ]);
    expect(got.shares.get("A")).toBe(0);
    expect(got.shares.get("B")).toBe(0);
    expect(got.residual).toBe(0);
  });

  it("does not invent a difference when no asset has an own figure", () => {
    const got = attributeBlockToAssets(block({ totalDepreciation: 0 }), [{ ledger: "A", own: 0 }]);
    expect(got.shares.get("A")).toBe(0);
    expect(got.residual).toBe(0);
  });
});

const ROOTS: Record<string, string> = {
  "Depreciation A/c": "Indirect Expenses",
  "Machinery Supplier": "Sundry Creditors",
  "Sale of Fixed Asset A/c": "Sales Accounts",
  "Buyer of Plant": "Sundry Debtors",
};
const GROUPS: Record<string, string> = { "Mixer Plant 2": "Block 15%", "Site Shed": "Fixed Assets" };

const row = (date: string, counterparty: string, amount: number, voucherType = "Jrnl"): LedgerVoucherRow =>
  ({ date, voucherType, voucherNumber: "1", reference: "", counterparty, amount, matchStatus: "matched", tax: null });

const ctxFor = (over: Partial<DepCtx> = {}): DepCtx => ({
  fromDate: "20250401", toDate: "20260331", operator: EMPTY_DEP_OPERATOR,
  groupOf: (l) => GROUPS[l] ?? "", groupRootOf: (l) => ROOTS[l] ?? "",
  isAssetLedger: (l) => l in GROUPS,
  openingWdv: () => ({ amount: 0, source: "book-seed" }),
  bookOpening: () => 0, bookClosing: () => 0,
  additionalDepreciationEligible: () => false, ...over,
});

describe("analyzeDepreciation", () => {
  it("reports the Act charge, the book charge and the difference per asset", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250515", "Machinery Supplier", 1000000, "Purc"),
        row("20260303", "Depreciation A/c", -150000),
      ] }],
      disposalSignals: [],
      depreciationLedgerDebits: 150000,
    }, ctxFor());
    const asset = r.assets.find((a) => a.ledger === "Mixer Plant 2");
    expect(asset?.actDepreciation).toBeCloseTo(150000, 2);
    expect(asset?.bookCharge).toBeCloseTo(150000, 2);
    expect(asset?.difference).toBeCloseTo(0, 2);
    expect(r.findings.filter((f) => f.check === "dep_book_charge_differs")).toHaveLength(0);
  });

  it("raises dep_book_charge_missing where an asset carries cost but no charge", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20260320", "Machinery Supplier", 473400, "Purc")] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ctxFor());
    expect(r.findings.map((f) => f.check)).toContain("dep_book_charge_missing");
  });

  it("raises dep_charge_predates_acquisition when the journal is dated before the purchase", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250601", "Machinery Supplier", 100000, "Purc"),
        row("20260303", "Depreciation A/c", -15000),
      ] }, { ledger: "Site Shed", rows: [row("20260320", "Machinery Supplier", 50000, "Purc")] }],
      disposalSignals: [], depreciationLedgerDebits: 15000,
    }, ctxFor({ operator: { ...EMPTY_DEP_OPERATOR, rateOverrides: [{ ledger: "Site Shed", rate: 15, reason: "shed" }] } }));
    expect(r.findings.map((f) => f.check)).toContain("dep_charge_predates_acquisition");
  });

  it("excludes an unclassified credit from every figure and flags it", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250515", "Machinery Supplier", 1000000, "Purc"),
        row("20250901", "Mystery Account", -90000),
        row("20260303", "Depreciation A/c", -150000),
      ] }],
      disposalSignals: [], depreciationLedgerDebits: 150000,
    }, ctxFor());
    expect(r.excluded).toHaveLength(1);
    expect(r.findings.map((f) => f.check)).toContain("dep_credit_unclassified");
    // The block is unchanged by the excluded credit: still 15% of 10,00,000.
    expect(r.blocks[0].totalDepreciation).toBeCloseTo(150000, 2);
  });

  it("raises dep_disposal_outside_block for proceeds with no matching asset credit", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20260303", "Depreciation A/c", -15000)] }],
      disposalSignals: [{ ledger: "Sale of Fixed Asset A/c", rows: [row("20250630", "Buyer of Plant", -962000, "Sale")] }],
      depreciationLedgerDebits: 15000,
    }, ctxFor({ openingWdv: () => ({ amount: 100000, source: "book-seed" }) }));
    expect(r.findings.map((f) => f.check)).toContain("dep_disposal_outside_block");
  });

  it("raises dep_book_charge_unreconciled when the expense ledger disagrees", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20260303", "Depreciation A/c", -15000)] }],
      disposalSignals: [], depreciationLedgerDebits: 99999,
    }, ctxFor());
    expect(r.findings.map((f) => f.check)).toContain("dep_book_charge_unreconciled");
  });

  it("raises dep_block_rate_unresolved and dep_asset_ledger_outside_block together", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Site Shed", rows: [row("20250601", "Machinery Supplier", 50000, "Purc")] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ctxFor());
    const checks = r.findings.map((f) => f.check);
    expect(checks).toContain("dep_block_rate_unresolved");
    expect(checks).toContain("dep_asset_ledger_outside_block");
  });

  it("marks the whole result an unverified seed when no operator opening WDV was given", () => {
    const r = analyzeDepreciation({ ledgerRows: [], disposalSignals: [], depreciationLedgerDebits: 0 }, ctxFor());
    expect(r.seedSource).toBe("book-seed");
    expect(r.findings.map((f) => f.check)).toContain("dep_opening_wdv_unverified");
  });

  it("puts money through money() and dates through displayDate() in every detail", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [
        row("20250515", "Machinery Supplier", 1234567, "Purc"),
        row("20250901", "Mystery Account", -90000),
      ] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ctxFor());
    for (const f of r.findings) {
      expect(f.detail).not.toMatch(/\d{6,}/);       // scrubDigits would eat it
      expect(f.detail).not.toMatch(/\b\d{8}\b/);    // a raw YYYYMMDD
    }
  });
});

describe("isAssetRowInScope", () => {
  it("keeps an idle ledger that carries an opening written-down value", () => {
    expect(isAssetRowInScope(800000, false)).toBe(true);
  });

  it("keeps a moved ledger whatever its opening", () => {
    expect(isAssetRowInScope(0, true)).toBe(true);
  });

  it("leaves out a never-moved ledger with a nil opening", () => {
    expect(isAssetRowInScope(0, false)).toBe(false);
    expect(isAssetRowInScope(0.004, false)).toBe(false);
  });
});

describe("analyzeDepreciation idle assets", () => {
  // 2026-09-30 Narayanan rerun: with the FY's depreciation journal deleted, 24
  // asset ledgers carried an opening balance and no movement at all. They
  // dropped out of the asset list, so their share of the block's Act
  // depreciation was piled onto the 53 that did move.
  const IDLE_GROUPS: Record<string, string> = { "Mixer Plant 2": "Block 15%", "Idle Roller": "Block 15%" };
  const idleCtx = (over: Partial<DepCtx> = {}): DepCtx => ctxFor({
    groupOf: (l) => IDLE_GROUPS[l] ?? "",
    isAssetLedger: (l) => l in IDLE_GROUPS,
    openingWdv: () => ({ amount: 1800000, source: "book-seed" }),
    bookOpening: (l) => (l === "Mixer Plant 2" ? 1000000 : 800000),
    bookClosing: (l) => (l === "Mixer Plant 2" ? 1200000 : 800000),
    ...over,
  });

  it("gives an idle asset its own rate on its own opening WDV", () => {
    const r = analyzeDepreciation({
      ledgerRows: [
        { ledger: "Mixer Plant 2", rows: [row("20250515", "Machinery Supplier", 200000, "Purc")] },
        { ledger: "Idle Roller", rows: [] },
      ],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, idleCtx());
    const mixer = r.assets.find((a) => a.ledger === "Mixer Plant 2");
    const idle = r.assets.find((a) => a.ledger === "Idle Roller");
    expect(idle?.opening).toBeCloseTo(800000, 2);
    expect(idle?.additionsNet).toBe(0);
    expect(idle?.actDepreciation).toBeCloseTo(120000, 2);   // 15% of 8,00,000
    expect(mixer?.actDepreciation).toBeCloseTo(180000, 2);  // 15% of 12,00,000
  });

  it("leaves the block total AND the mover's own figure unchanged by the idle asset", () => {
    const withIdle = analyzeDepreciation({
      ledgerRows: [
        { ledger: "Mixer Plant 2", rows: [row("20250515", "Machinery Supplier", 200000, "Purc")] },
        { ledger: "Idle Roller", rows: [] },
      ],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, idleCtx());
    const withoutIdle = analyzeDepreciation({
      ledgerRows: [
        { ledger: "Mixer Plant 2", rows: [row("20250515", "Machinery Supplier", 200000, "Purc")] },
      ],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, idleCtx());
    expect(withIdle.blocks[0].totalDepreciation).toBeCloseTo(withoutIdle.blocks[0].totalDepreciation, 2);
    expect(withIdle.blocks[0].totalDepreciation).toBeCloseTo(300000, 2);
    // The mover is rated on its own WDV, so adding an idle asset to the block
    // no longer moves the mover's figure at all (it used to lose the idle
    // asset's share, because the share was the mover's whole story).
    expect(withIdle.assets[0].actDepreciation).toBeCloseTo(180000, 2);
    expect(withoutIdle.assets[0].actDepreciation).toBeCloseTo(180000, 2);
    expect(withIdle.assets.reduce((a, x) => a + x.actDepreciation, 0)).toBeCloseTo(300000, 2);
  });
});

describe("analyzeDepreciation per-asset own rates", () => {
  // Captain, 2026-09-30: the asset column used to be the block's statutory
  // total spread pro rata over asset WDV, which blended every asset's
  // half-rate additions and the block's netted discounts into one percentage.
  const OWN_GROUPS: Record<string, string> = {
    "Pump 1HP": "Block 15%", "Mixed Plant": "Block 15%", "Tandem Roller": "Block 15%",
  };
  const ownCtx = (bookOpening: Record<string, number> = {}, over: Partial<DepCtx> = {}): DepCtx => {
    const seed = Object.values(bookOpening).reduce((a, b) => a + b, 0);
    return ctxFor({
      groupOf: (l) => OWN_GROUPS[l] ?? "",
      isAssetLedger: (l) => l in OWN_GROUPS,
      openingWdv: () => ({ amount: seed, source: "book-seed" }),
      bookOpening: (l) => bookOpening[l] ?? 0,
      bookClosing: (l) => bookOpening[l] ?? 0,
      ...over,
    });
  };

  it("computes the 1 HP pump at its own rate: 10,600 net additions at 15% is 1,590.00", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Pump 1HP", rows: [row("20250515", "Machinery Supplier", 10600, "Purc")] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ownCtx());
    const pump = r.assets.find((a) => a.ledger === "Pump 1HP");
    expect(pump?.additionsNet).toBe(10600);
    expect(pump?.actDepreciation).toBe(1590);
    expect(r.blocks[0].totalDepreciation).toBe(1590);
    expect(r.blockResiduals).toHaveLength(0);
  });

  it("splits ONE asset's own additions into its full and half pools", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixed Plant", rows: [
        row("20250515", "Machinery Supplier", 20000, "Purc"),
        row("20260115", "Machinery Supplier", 10600, "Purc"),
      ] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ownCtx());
    const a = r.assets.find((x) => x.ledger === "Mixed Plant");
    expect(a?.additionsFull).toBe(20000);
    expect(a?.additionsHalf).toBe(10600);
    expect(a?.actDepreciation).toBeCloseTo(3795, 2);       // 3,000.00 + 795.00
    expect(a?.shortPeriod).toBe(false);                     // not EVERY addition is short
    expect(a?.notes).toMatch(/mixed put-to-use/i);
    expect(r.blocks[0].totalDepreciation).toBeCloseTo(3795, 2);
  });

  it("nets an asset's own purchase discount off that asset alone", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Tandem Roller", rows: [
        row("20250715", "Machinery Supplier", 3290375, "Purc"),
        row("20250725", "Machinery Supplier", -150000),
      ] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ownCtx());
    const t = r.assets.find((a) => a.ledger === "Tandem Roller");
    expect(t?.additionsNet).toBe(3140375);                  // 32,90,375 less 1,50,000
    expect(t?.actDepreciation).toBeCloseTo(471056.25, 2);    // 15% of 31,40,375
  });

  it("makes the asset column sum EXACTLY to the block's statutory total", () => {
    const r = analyzeDepreciation({
      ledgerRows: [
        { ledger: "Pump 1HP", rows: [row("20250515", "Machinery Supplier", 10600, "Purc")] },
        { ledger: "Mixed Plant", rows: [row("20250515", "Machinery Supplier", 10001, "Purc")] },
        { ledger: "Tandem Roller", rows: [
          row("20250715", "Machinery Supplier", 3290375, "Purc"),
          row("20250725", "Machinery Supplier", -150000),
        ] },
      ],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ownCtx());
    const assets = r.assets.reduce((a, x) => a + x.actDepreciation, 0);
    expect(assets).toBe(r.blocks[0].totalDepreciation);
    expect(r.blockResiduals).toHaveLength(0);
  });

  it("states a block-level difference on its own line rather than spreading it", () => {
    // An operator written-down value for the BLOCK belongs to no single asset.
    const r = analyzeDepreciation({
      ledgerRows: [
        { ledger: "Pump 1HP", rows: [row("20250515", "Machinery Supplier", 10600, "Purc")] },
        { ledger: "Mixed Plant", rows: [row("20250515", "Machinery Supplier", 20000, "Purc")] },
      ],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ownCtx({}, {
      operator: { ...EMPTY_DEP_OPERATOR, openingWdv: [{ block: "Block 15%", rate: 15, amount: 500000 }] },
      openingWdv: () => ({ amount: 500000, source: "operator" }),
    }));
    expect(r.assets.reduce((a, x) => a + x.actDepreciation, 0)).toBeCloseTo(4590, 2);
    expect(r.blocks[0].totalDepreciation).toBeCloseTo(79590, 2);   // 15% of 5,30,600
    expect(r.blockResiduals).toHaveLength(1);
    expect(r.blockResiduals[0].residual).toBeCloseTo(75000, 2);
    expect(r.blockResiduals[0].reason).toMatch(/written-down value|opening/i);
    expect(r.findings.map((f) => f.check)).toContain("dep_block_residual_unattributed");
  });
});

describe("analyzeDepreciation carried obligations", () => {
  // Task 7 review: rule-3 debits (attach-to-nothing on a ledger with a NON-NIL
  // opening balance) are dropped from groupAcquisitions' Acquisition[]; design
  // §10 rule 3 says they join the opening written-down value at the FULL rate.
  it("adds a rule-3 debit to the block's opening WDV at the full rate, not the half rate", () => {
    const r = analyzeDepreciation({
      ledgerRows: [{ ledger: "Mixer Plant 2", rows: [row("20260320", "Bank of Baroda", 40000)] }],
      disposalSignals: [], depreciationLedgerDebits: 0,
    }, ctxFor({
      operator: { ...EMPTY_DEP_OPERATOR, openingWdv: [{ block: "Block 15%", rate: 15, amount: 100000 }] },
      openingWdv: () => ({ amount: 100000, source: "operator" }),
      bookOpening: (l) => (l === "Mixer Plant 2" ? 100000 : 0),
      bookClosing: (l) => (l === "Mixer Plant 2" ? 140000 : 0),
    }));
    expect(r.blocks[0].openingWdv).toBeCloseTo(140000, 2);   // 1,00,000 + 40,000
    expect(r.blocks[0].totalDepreciation).toBeCloseTo(21000, 2); // 15% full, not the 20260320 half
    const asset = r.assets.find((a) => a.ledger === "Mixer Plant 2");
    expect(asset?.opening).toBeCloseTo(140000, 2);
    expect(asset?.actDepreciation).toBeCloseTo(21000, 2);
    expect(asset?.shortPeriod).toBe(false);
  });
});
