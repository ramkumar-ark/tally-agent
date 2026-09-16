import { describe, expect, it } from "vitest";
import { computeBlock, type Acquisition, type BlockInput, type DepCtx } from "../src/depreciation.js";
import { EMPTY_DEP_OPERATOR } from "../src/depreciation-file.js";

const ctx = (over: Partial<DepCtx> = {}): DepCtx => ({
  fromDate: "20250401", toDate: "20260331", operator: EMPTY_DEP_OPERATOR,
  groupOf: () => "", groupRootOf: () => "", isAssetLedger: () => false,
  openingWdv: () => ({ amount: 0, source: "book-seed" }),
  bookOpening: () => 0, bookClosing: () => 0,
  additionalDepreciationEligible: () => false,
  ...over,
});

const acq = (firstUse: string, cost: number, netted = 0): Acquisition =>
  ({ ledger: "A", firstUse, cost, counterparty: "S", debits: [], netted });

const input = (over: Partial<BlockInput> = {}): BlockInput => ({
  block: "Block 15%", rate: 15, openingWdv: 0, acquisitions: [],
  deductions: 0, anyAssetLeft: true, carryForwardAdditional: 0, ...over,
});

describe("computeBlock", () => {
  it("charges the full rate on opening written-down value with no movement", () => {
    const r = computeBlock(input({ openingWdv: 100000 }), ctx());
    expect(r.normalDepreciation).toBeCloseTo(15000, 2);
    expect(r.closingWdv).toBeCloseTo(85000, 2);
    expect(r.status).toBe("ok");
  });

  it("charges the full rate on an addition at 180 days exactly and half the day after", () => {
    const full = computeBlock(input({ acquisitions: [acq("20251003", 100000)] }), ctx());
    const half = computeBlock(input({ acquisitions: [acq("20251004", 100000)] }), ctx());
    expect(full.normalDepreciation).toBeCloseTo(15000, 2);
    expect(half.normalDepreciation).toBeCloseTo(7500, 2);
  });

  it("depreciates an addition net of its discount", () => {
    const r = computeBlock(input({ acquisitions: [acq("20250515", 4094167.67, 207031.25)] }), ctx());
    expect(r.normalDepreciation).toBeCloseTo(583070.46, 2);
  });

  it("mixes opening WDV at the full rate with a short-period addition", () => {
    const r = computeBlock(input({ rate: 40, openingWdv: 5917.67, acquisitions: [acq("20260113", 54618.66)] }), ctx());
    // 40% x 5917.67 + 20% x 54618.66
    expect(r.normalDepreciation).toBeCloseTo(13290.80, 2);
  });

  it("reduces the block by moneys payable on a disposal", () => {
    const r = computeBlock(input({ openingWdv: 500000, deductions: 200000 }), ctx());
    expect(r.wdvBeforeDep).toBeCloseTo(300000, 2);
    expect(r.normalDepreciation).toBeCloseTo(45000, 2);
  });

  it("s.50: moneys payable above the block give a short-term gain and no depreciation", () => {
    const r = computeBlock(input({ openingWdv: 100000, deductions: 250000 }), ctx());
    expect(r.status).toBe("nil-floor");
    expect(r.shortTermGain).toBeCloseTo(150000, 2);
    expect(r.totalDepreciation).toBe(0);
    expect(r.closingWdv).toBe(0);
  });

  it("s.50: value left but no asset left gives a short-term loss and no depreciation", () => {
    const r = computeBlock(input({ openingWdv: 80000, anyAssetLeft: false }), ctx());
    expect(r.status).toBe("extinguished");
    expect(r.shortTermLoss).toBeCloseTo(80000, 2);
    expect(r.totalDepreciation).toBe(0);
  });

  it("adds 20% additional depreciation on eligible new plant", () => {
    const r = computeBlock(
      input({ acquisitions: [acq("20250515", 1000000)] }),
      ctx({ additionalDepreciationEligible: () => true }),
    );
    expect(r.normalDepreciation).toBeCloseTo(150000, 2);
    expect(r.additionalDepreciation).toBeCloseTo(200000, 2);
    expect(r.totalDepreciation).toBeCloseTo(350000, 2);
  });

  it("halves additional depreciation for a short-period addition", () => {
    const r = computeBlock(
      input({ acquisitions: [acq("20260113", 1000000)] }),
      ctx({ additionalDepreciationEligible: () => true }),
    );
    expect(r.additionalDepreciation).toBeCloseTo(100000, 2);
  });

  it("allows last year's carried-forward additional depreciation this year", () => {
    const r = computeBlock(input({ openingWdv: 0, carryForwardAdditional: 100000 }), ctx());
    expect(r.additionalDepreciation).toBeCloseTo(100000, 2);
  });

  it("does not charge additional depreciation when eligibility was not declared", () => {
    const r = computeBlock(input({ acquisitions: [acq("20250515", 1000000)] }), ctx());
    expect(r.additionalDepreciation).toBe(0);
  });
});
