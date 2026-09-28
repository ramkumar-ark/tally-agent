import { describe, expect, it } from "vitest";
import { booksMovements, roleResolver, analyzeGstAdj } from "../src/gst-adj.js";
import { displayDate } from "../src/format.js";
import type { VoucherEntry, VoucherRow } from "../src/downstream.js";
import type { Head, ThreeBSummary } from "../src/gst-adj-3b.js";
import type { Itc2bEntry } from "../src/gst-adj-2b.js";
import { parseThreeB } from "../src/gst-adj-3b.js";
import { loadGstAdjConfig } from "../src/gst-adj-config.js";
import { make3bWorkbook } from "./helpers/gst-adj-3b.js";

function applyLegs(
  movements: Map<string, Map<string, number>>,
  entries: Array<{ month: string; legs: Array<{ dr: string; cr: string; amount: number }> }>,
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const [month, roleMap] of movements) {
    result.set(month, new Map(roleMap));
  }
  for (const entry of entries) {
    const mv = result.get(entry.month);
    if (!mv) continue;
    for (const leg of entry.legs) {
      mv.set(leg.dr, (mv.get(leg.dr) ?? 0) + leg.amount);
      mv.set(leg.cr, (mv.get(leg.cr) ?? 0) - leg.amount);
    }
  }
  return result;
}

const cfg = loadGstAdjConfig(undefined, () => {});

function makeAdjThreeB(overrides: Partial<ThreeBSummary>): ThreeBSummary {
  return {
    companyName: "Test Constructions",
    gstin: "33AAAAA0000A0Z0",
    state: "Tamil Nadu",
    months: ["2025-05"],
    outwardTaxable: {},
    outwardTax: {},
    rcmTax: {},
    itcRcm: {},
    itcOther: {},
    itcReversed: {},
    netItc: {},
    itcReclaimed: {},
    ...overrides,
  };
}

const emptyHead: Head = { igst: 0, cgst: 0, sgst: 0, cess: 0 };

function vr(date: string, entries: Array<[string, number]>, extra: Partial<VoucherRow> = {}): VoucherRow {
  return {
    date,
    voucherType: "Journal",
    voucherNumber: "1",
    partyLedgerName: "",
    cancelled: false,
    entries: entries.map(([ledger, amount]): VoucherEntry => ({ ledger, amount })),
    ...extra,
  };
}

function makeHead(h: Partial<Head>): Head {
  return { ...emptyHead, ...h };
}

function makeEntry(key: string, tax: Partial<Head>): Itc2bEntry {
  return {
    key,
    docNo: null,
    vchNo: null,
    date: "20250501",
    party: "P",
    gstin: "",
    tax: makeHead(tax) as Head,
  };
}

describe("booksMovements", () => {
  const vouchers = [
    vr("20250501", [["Input CGST A/c", -100], ["Sales", 100]]),
    vr("20250531", [["Output CGST A/c", -400], ["Sales", 400]]),
    vr("20250601" as unknown as string, [["Input CGST A/c", -50], ["P", 50]]),
  ];
  const mv = booksMovements(vouchers, roleResolver(cfg));
  it("maps month → ledger → net signed amount", () => {
    expect(mv.get("2025-05")!.get("Input CGST A/c")).toBe(-100);
    expect(mv.get("2025-05")!.get("Output CGST A/c")).toBe(-400);
    expect(mv.get("2025-06")!.get("Input CGST A/c")).toBe(-50);
  });
});

describe("analyzeGstAdj", () => {
  const threeB = parseThreeB(make3bWorkbook({
    rows: [
      { label: "Tax on outward supply", values: Array(12).fill(0) },
      { label: "IGST on outward supply", values: Array(12).fill(0) },
      { label: "CGST on outward supply", values: [0, 400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { label: "SGST on outward supply", values: [0, 400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { label: "Cess on outward supply", values: Array(12).fill(0) },
      { label: "All other ITC", values: Array(12).fill(0) },
      { label: "IGST all other ITC", values: Array(12).fill(0) },
      { label: "CGST all other ITC", values: [0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { label: "SGST all other ITC", values: Array(12).fill(0) },
      { label: "Cess all other ITC", values: Array(12).fill(0) },
      { label: "ITC reversed) as per rules 38", values: Array(12).fill(0) },
      { label: "IGST", values: Array(12).fill(0) },
      { label: "CGST", values: Array(12).fill(0) },
      { label: "SGST", values: Array(12).fill(0) },
      { label: "Cess", values: Array(12).fill(0) },
      { label: "ITC reversed) (2) others", values: Array(12).fill(0) },
      { label: "IGST", values: Array(12).fill(0) },
      { label: "CGST", values: Array(12).fill(0) },
      { label: "SGST", values: Array(12).fill(0) },
      { label: "Cess", values: Array(12).fill(0) },
      { label: "Net ITC available (a-b)", values: Array(12).fill(0) },
      { label: "IGST net ITC", values: Array(12).fill(0) },
      { label: "CGST net ITC", values: Array(12).fill(0) },
      { label: "SGST net ITC", values: Array(12).fill(0) },
      { label: "Cess net ITC", values: Array(12).fill(0) },
    ],
  }));

  it("books kinds 1 and 2 from the 3B", () => {
    const movements = new Map<string, Map<string, number>>();
    const mayMv = new Map<string, number>();
    mayMv.set("Output CGST A/c", -400);
    mayMv.set("Output SGST A/c", -400);
    mayMv.set("Input CGST A/c", 100);
    movements.set("2025-05", mayMv);

    const result = analyzeGstAdj({ threeB, movements, config: cfg, knownLedgers: new Set() });

    const entries = result.entries;
    expect(entries).toHaveLength(2);

    const kind1 = entries.find((e) => e.kind === 1);
    expect(kind1).toBeDefined();
    expect(kind1!.month).toBe("2025-05");
    expect(kind1!.date).toBe("20250531");
    expect(kind1!.narration).toBe("being output gst for the month May 2025");
    expect(kind1!.legs).toHaveLength(2);
    expect(kind1!.legs[0]).toEqual({ dr: "Output CGST A/c", cr: "CGST Payable A/c", amount: 400 });
    expect(kind1!.legs[1]).toEqual({ dr: "Output SGST A/c", cr: "SGST Payable A/c", amount: 400 });

    const kind2 = entries.find((e) => e.kind === 2);
    expect(kind2).toBeDefined();
    expect(kind2!.month).toBe("2025-05");
    expect(kind2!.date).toBe("20250531");
    expect(kind2!.narration).toBe("being input gst for the month May 2025");
    expect(kind2!.legs).toHaveLength(1);
    expect(kind2!.legs[0]).toEqual({ dr: "CGST Payable A/c", cr: "Input CGST A/c", amount: 100 });
  });

  it("reports mismatch and review findings when books differ from 3B", () => {
    const movements = new Map<string, Map<string, number>>();
const mayMv = new Map<string, number>();
      mayMv.set("Output CGST A/c", 350);
      mayMv.set("Output SGST A/c", -400);
      mayMv.set("Input CGST A/c", 100);
    movements.set("2025-05", mayMv);

    const result = analyzeGstAdj({ threeB, movements, config: cfg, knownLedgers: new Set() });

    const findings = result.findings;
    const cgstWarnings = findings.filter((f) => f.id === "gadj_3b_ledger_mismatch" && f.severity === "warning");
    const cgstReviews = findings.filter((f) => f.id === "gadj_3b_ledger_mismatch" && f.severity === "review");

    expect(cgstWarnings.length).toBeGreaterThanOrEqual(1);
    expect(cgstReviews.length).toBeGreaterThanOrEqual(1);
  });

  describe("kind 3 — RCM attribution", () => {
    it("produces tieout + review finding when RCM ITC exceeds RCM liability", () => {
      const threeB = makeAdjThreeB({
        itcRcm: { "2025-05": { ...emptyHead, cgst: 200 } },
        rcmTax: { "2025-05": { ...emptyHead, cgst: 100 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const result = analyzeGstAdj({ threeB, movements, config: cfg, knownLedgers: new Set() });

      const tieout = result.tieout.filter((t) => t.kind === 3);
      expect(tieout).toHaveLength(1);
      expect(tieout[0]).toEqual({ month: "2025-05", kind: 3, head: "cgst", entry: 0, threeB: 200, note: "included in the 4C claim (kind 2)" });

      const findings = result.findings.filter((f) => f.id === "gadj_3b_ledger_mismatch");
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("review");
      expect(findings[0].detail).toBe("RCM ITC without matching RCM liability for cgst");
    });

    it("produces tieout only when RCM ITC equals RCM liability", () => {
      const threeB = makeAdjThreeB({
        itcRcm: { "2025-05": { ...emptyHead, cgst: 100 } },
        rcmTax: { "2025-05": { ...emptyHead, cgst: 100 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const result = analyzeGstAdj({ threeB, movements, config: cfg, knownLedgers: new Set() });

      const tieout = result.tieout.filter((t) => t.kind === 3);
      expect(tieout).toHaveLength(1);
      expect(result.findings.filter((f) => f.id === "gadj_3b_ledger_mismatch")).toHaveLength(0);
    });
  });

  describe("kind 4 — 4(B)(1) reversal", () => {
    it("produces kind-4 entry with reversal narration and tieout", () => {
      const threeB = makeAdjThreeB({
        itcReversed: { "2025-05": { ...emptyHead, cgst: 50 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const result = analyzeGstAdj({ threeB, movements, config: cfg, knownLedgers: new Set() });

      const entries = result.entries;
      const kind4 = entries.find((e) => e.kind === 4);
      expect(kind4).toBeDefined();
      expect(kind4!.month).toBe("2025-05");
      expect(kind4!.date).toBe("20250531");
      expect(kind4!.narration).toBe("being itc reversal 4(b)(1) for the month May 2025");
      expect(kind4!.legs).toHaveLength(1);
      expect(kind4!.legs[0]).toEqual({ dr: "Input CGST To Be Reversed A/c", cr: "Input CGST A/c", amount: 50 });

      const tieout = result.tieout.filter((t) => t.kind === 4);
      expect(tieout).toHaveLength(1);
      expect(tieout[0]).toEqual({ month: "2025-05", kind: 4, head: "cgst", entry: 0, threeB: 50, note: "reversal already inside 4C (kind 2); ledger reclassification only" });
    });
  });

  describe("kind 7 — TDS credit from config", () => {
    it("reports warning when tds ledger movement differs from config figure", () => {
      const cfg7 = { ...cfg, gstTdsCredit: { "2025-05": { cgst: 300 } } };
      const threeB = makeAdjThreeB({ tdsSectionPresent: true });
      const movements = new Map<string, Map<string, number>>();
      const mayMv = new Map<string, number>();
      mayMv.set("GST TDS CGST A/c", -350);
      movements.set("2025-05", mayMv);
      const result = analyzeGstAdj({ threeB, movements, config: cfg7, knownLedgers: new Set() });

      const findings = result.findings.filter((f) => f.id === "gadj_tds_credit_unsupported");
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("warning");
      expect(findings[0].detail).toBe("tds credit 300 differs from books 350");
    });

    it("reports review when tds ledger has no books movement but exists in knownLedgers", () => {
      const cfg7 = { ...cfg, gstTdsCredit: { "2025-05": { cgst: 300 } } };
      const threeB = makeAdjThreeB({ tdsSectionPresent: true });
      const movements = new Map<string, Map<string, number>>();
      const knownLedgers = new Set<string>();
      knownLedgers.add("GST TDS CGST A/c");
      const result = analyzeGstAdj({ threeB, movements, config: cfg7, knownLedgers });

      const findings = result.findings.filter((f) => f.id === "gadj_tds_credit_unsupported");
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("review");
      expect(findings[0].detail).toBe("tds ledger has no books movement");
    });

    it("appends 3B section note when tdsSectionPresent is false", () => {
      const cfg7 = { ...cfg, gstTdsCredit: { "2025-05": { cgst: 300 } } };
      const threeB = makeAdjThreeB({ tdsSectionPresent: false });
      const movements = new Map<string, Map<string, number>>();
      const knownLedgers = new Set<string>();
      knownLedgers.add("GST TDS CGST A/c");
      const result = analyzeGstAdj({ threeB, movements, config: cfg7, knownLedgers });

      const findings = result.findings.filter((f) => f.id === "gadj_tds_credit_unsupported");
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("review");
      expect(findings[0].detail).toBe("tds ledger has no books movement; the 3B workbook carries no TDS section; figure taken from config");
    });
  });

  describe("kind 5 — newly listed in 2B", () => {
    it("produces kind-5 entry Dr unclaimed/Cr input when newly listed amount exceeds tolerance", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-05", "2025-06"],
        netItc: { "2025-05": { ...emptyHead, cgst: 600 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const mayMv = new Map<string, number>();
      mayMv.set("Input CGST A/c", 1000);
      movements.set("2025-05", mayMv);
      const junMv = new Map<string, number>();
      junMv.set("Input CGST A/c", 600);
      movements.set("2025-06", junMv);

      const listDiffs = {
        "2025-05": {
          newly: [makeEntry("X-cgst-05", { cgst: 400 })],
          dropped: [],
        },
        "2025-06": { newly: [], dropped: [] },
      };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });

      const kind5 = result.entries.find((e) => e.kind === 5);
      expect(kind5).toBeDefined();
      expect(kind5!.month).toBe("2025-05");
      expect(kind5!.date).toBe("20250531");
      expect(kind5!.narration).toBe("being input gst for the month May 2025");
      expect(kind5!.legs).toHaveLength(1);
      expect(kind5!.legs[0]).toEqual({ dr: "Unclaimed CGST A/c", cr: "Input CGST A/c", amount: 400 });

      const tieout = result.tieout.filter((t) => t.kind === 5);
      expect(tieout).toHaveLength(1);
      expect(tieout[0]).toEqual({ month: "2025-05", kind: 5, head: "cgst", entry: 400, threeB: null, note: "newly listed in 2B" });
    });

    it("does not produce kind 5 when newly listed amount is within tolerance", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-05"],
        netItc: { "2025-05": { ...emptyHead, cgst: 600 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const mayMv = new Map<string, number>();
      mayMv.set("Input CGST A/c", 1000);
      movements.set("2025-05", mayMv);

      const listDiffs = {
        "2025-05": {
          newly: [makeEntry("X-cgst-05", { cgst: 1 })],
          dropped: [],
        },
      };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });
      expect(result.entries.find((e) => e.kind === 5)).toBeUndefined();
      expect(result.tieout.filter((t) => t.kind === 5)).toHaveLength(0);
    });
  });

  describe("kind 6 — reflected + claimed", () => {
    it("produces kind-6 entry Dr input/Cr unclaimed when reflected amount exceeds tolerance", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-06"],
        netItc: { "2025-06": { ...emptyHead, cgst: 1000 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const junMv = new Map<string, number>();
      junMv.set("Input CGST A/c", 600);
      movements.set("2025-06", junMv);

      const listDiffs = {
        "2025-06": { newly: [], dropped: [makeEntry("X-cgst-06", { cgst: 400 })] },
      };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });

      const kind6 = result.entries.find((e) => e.kind === 6);
      expect(kind6).toBeDefined();
      expect(kind6!.month).toBe("2025-06");
      expect(kind6!.date).toBe("20250630");
      expect(kind6!.narration).toBe("being input gst for the month June 2025");
      expect(kind6!.legs).toHaveLength(1);
      expect(kind6!.legs[0]).toEqual({ dr: "Input CGST A/c", cr: "Unclaimed CGST A/c", amount: 400 });

      const tieout = result.tieout.filter((t) => t.kind === 6);
      expect(tieout).toHaveLength(1);
      expect(tieout[0]).toEqual({ month: "2025-06", kind: 6, head: "cgst", entry: 400, threeB: null, note: "reflected+claimed" });
    });
  });

  describe("kind R — residual routing", () => {
    it("routes residual to toBeBooked when no residual mark", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-07"],
        netItc: { "2025-07": { ...emptyHead, cgst: 100 } },
        itcReversed: {},
      });
      const movements = new Map<string, Map<string, number>>();
      const julMv = new Map<string, number>();
      julMv.set("Input CGST A/c", 300);
      movements.set("2025-07", julMv);

      const listDiffs = {
        "2025-07": { newly: [], dropped: [] },
      };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });

      const kindR = result.entries.find((e) => e.kind === 8);
      expect(kindR).toBeDefined();
      expect(kindR!.month).toBe("2025-07");
      expect(kindR!.date).toBe("20250731");
      expect(kindR!.narration).toBe("being input gst for the month July 2025");
      expect(kindR!.legs).toHaveLength(1);
      expect(kindR!.legs[0]).toEqual({ dr: "Input CGST To Be Booked A/c", cr: "Input CGST A/c", amount: 200 });

      const tieout = result.tieout.filter((t) => t.kind === 8);
      expect(tieout).toHaveLength(1);
      expect(tieout[0]).toEqual({ month: "2025-07", kind: 8, head: "cgst", entry: 200, threeB: null, note: "residual routed to toBeBooked" });
    });

    it("routes residual to toBeReversed when residual mark says so", () => {
      const cfgR = {
        ...cfg,
        residualMarks: { "2025-07": { cgst: "reversed" } },
      };
      const threeB = makeAdjThreeB({
        months: ["2025-07"],
        netItc: { "2025-07": { ...emptyHead, cgst: 100 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const julMv = new Map<string, number>();
      julMv.set("Input CGST A/c", 300);
      movements.set("2025-07", julMv);

      const listDiffs = { "2025-07": { newly: [], dropped: [] } };

      const result = analyzeGstAdj({ threeB, movements, config: cfgR, listDiffs });

      const kindR = result.entries.find((e) => e.kind === 8);
      expect(kindR).toBeDefined();
      expect(kindR!.legs[0]).toEqual({ dr: "Input CGST To Be Reversed A/c", cr: "Input CGST A/c", amount: 200 });

      const tieout = result.tieout.filter((t) => t.kind === 8);
      expect(tieout[0]).toEqual({ month: "2025-07", kind: 8, head: "cgst", entry: 200, threeB: null, note: "residual routed to toBeReversed" });
    });

    it("reports over-claim finding and produces no kind R when residual is negative", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-07"],
        netItc: { "2025-07": { ...emptyHead, cgst: 100 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const julMv = new Map<string, number>();
      julMv.set("Input CGST A/c", 50);
      movements.set("2025-07", julMv);

      const listDiffs = { "2025-07": { newly: [], dropped: [] } };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });

      expect(result.entries.find((e) => e.kind === 8)).toBeUndefined();

      const overClaim = result.findings.find((f) => f.id === "gadj_claim_exceeds_books");
      expect(overClaim).toBeDefined();
      expect(overClaim!.severity).toBe("warning");
      expect(overClaim!.detail).toContain(displayDate("20250731"));
    });
  });

  describe("gadj_claim_exceeds_books", () => {
    it("fires with displayDate of last day of month when books credit is less than claimed", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-07"],
        netItc: { "2025-07": { ...emptyHead, cgst: 100 } },
      });
      const movements = new Map<string, Map<string, number>>();
      const julMv = new Map<string, number>();
      julMv.set("Input CGST A/c", 50);
      movements.set("2025-07", julMv);

      const listDiffs = { "2025-07": { newly: [], dropped: [] } };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });

      const overClaim = result.findings.find((f) => f.id === "gadj_claim_exceeds_books");
      expect(overClaim).toBeDefined();
      expect(overClaim!.severity).toBe("warning");
      expect(overClaim!.detail).toContain(displayDate("20250731"));
      expect(result.entries.find((e) => e.kind === 8)).toBeUndefined();
    });
  });

  describe("gadj_list_reappearance", () => {
    it("flags review when a dropped key reappears in a later month", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-05", "2025-06", "2025-07"],
        netItc: {
          "2025-05": { ...emptyHead, cgst: 600 },
          "2025-06": { ...emptyHead, cgst: 1000 },
          "2025-07": { ...emptyHead, cgst: 100 },
        },
      });
      const movements = new Map<string, Map<string, number>>();
      const mayMv = new Map<string, number>();
      mayMv.set("Input CGST A/c", 1000);
      movements.set("2025-05", mayMv);
      const junMv = new Map<string, number>();
      junMv.set("Input CGST A/c", 600);
      movements.set("2025-06", junMv);
      const julMv = new Map<string, number>();
      julMv.set("Input CGST A/c", 300);
      movements.set("2025-07", julMv);

      const listDiffs = {
        "2025-05": { newly: [makeEntry("X-cgst-05", { cgst: 400 })], dropped: [] },
        "2025-06": { newly: [], dropped: [makeEntry("X-cgst", { cgst: 400 })] },
        "2025-07": { newly: [], dropped: [makeEntry("X-cgst", { cgst: 400 })] },
      };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });

      const reappearance = result.findings.find((f) => f.id === "gadj_list_reappearance");
      expect(reappearance).toBeDefined();
      expect(reappearance!.severity).toBe("review");
      expect(reappearance!.detail).toContain("X-cgst");

      const kind5may = result.entries.find((e) => e.kind === 5 && e.month === "2025-05");
      expect(kind5may).toBeDefined();

      const kind6jun = result.entries.find((e) => e.kind === 6 && e.month === "2025-06");
      expect(kind6jun).toBeDefined();
    });

    it("does not flag reappearance when key does not reappear", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-05", "2025-06"],
        netItc: {
          "2025-05": { ...emptyHead, cgst: 600 },
          "2025-06": { ...emptyHead, cgst: 1000 },
        },
      });
      const movements = new Map<string, Map<string, number>>();
      const mayMv = new Map<string, number>();
      mayMv.set("Input CGST A/c", 1000);
      movements.set("2025-05", mayMv);
      const junMv = new Map<string, number>();
      junMv.set("Input CGST A/c", 600);
      movements.set("2025-06", junMv);

      const listDiffs = {
        "2025-05": { newly: [makeEntry("X-cgst-05", { cgst: 400 })], dropped: [] },
        "2025-06": { newly: [], dropped: [makeEntry("Y-cgst-06", { cgst: 400 })] },
      };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });
      expect(result.findings.filter((f) => f.id === "gadj_list_reappearance")).toHaveLength(0);
    });
  });

  describe("X-flow invariant", () => {
    it("X-flow: kinds 5/6/R produce balanced entries; applyLegs verifies net zero input", () => {
      const threeB = makeAdjThreeB({
        months: ["2025-05", "2025-06", "2025-07"],
        netItc: {
          "2025-05": { ...emptyHead, cgst: 600 },
          "2025-06": { ...emptyHead, cgst: 1000 },
          "2025-07": { ...emptyHead, cgst: 100 },
        },
        itcReversed: {},
      });
      const movements = new Map<string, Map<string, number>>();
      const mayMv = new Map<string, number>();
      mayMv.set("Input CGST A/c", 1000);
      movements.set("2025-05", mayMv);
      const junMv = new Map<string, number>();
      junMv.set("Input CGST A/c", 600);
      movements.set("2025-06", junMv);
      const julMv = new Map<string, number>();
      julMv.set("Input CGST A/c", 300);
      movements.set("2025-07", julMv);

      const listDiffs = {
        "2025-05": { newly: [makeEntry("X-cgst-05", { cgst: 400 })], dropped: [] },
        "2025-06": { newly: [], dropped: [makeEntry("X-cgst-06", { cgst: 400 })] },
        "2025-07": { newly: [], dropped: [] },
      };

      const result = analyzeGstAdj({ threeB, movements, config: cfg, listDiffs });

      const entries56R = result.entries.filter((e) => [5, 6, 8].includes(e.kind));
      const adjusted = applyLegs(movements, entries56R);

      const mayInput = adjusted.get("2025-05")!.get("Input CGST A/c") ?? 0;
      const junInput = adjusted.get("2025-06")!.get("Input CGST A/c") ?? 0;
      const julInput = adjusted.get("2025-07")!.get("Input CGST A/c") ?? 0;

      expect(mayInput).toBe(600);
      expect(junInput).toBe(1000);
      expect(julInput).toBe(100);

      const kind5may = result.entries.find((e) => e.kind === 5);
      expect(kind5may).toBeDefined();
      const kind6jun = result.entries.find((e) => e.kind === 6);
      expect(kind6jun).toBeDefined();
      const kindRjul = result.entries.find((e) => e.kind === 8);
      expect(kindRjul).toBeDefined();
      expect(kindRjul!.legs[0]).toEqual({ dr: "Input CGST To Be Booked A/c", cr: "Input CGST A/c", amount: 200 });

      const reappearance = result.findings.find((f) => f.id === "gadj_list_reappearance");
      expect(reappearance).toBeUndefined();
    });
  });
});
