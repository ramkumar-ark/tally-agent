import { describe, expect, it } from "vitest";
import { booksMovements, roleResolver, analyzeGstAdj } from "../src/gst-adj.js";
import type { VoucherEntry, VoucherRow } from "../src/downstream.js";
import type { Head, ThreeBSummary } from "../src/gst-adj-3b.js";
import { parseThreeB } from "../src/gst-adj-3b.js";
import { loadGstAdjConfig } from "../src/gst-adj-config.js";
import { make3bWorkbook } from "./helpers/gst-adj-3b.js";

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

describe("booksMovements", () => {
  const vouchers = [
    vr("20250501", [["Input CGST A/c", -100], ["Sales", 100]]),
    vr("20250531", [["Output CGST A/c", -400], ["Sales", 400]]),
    vr("20250601" as unknown as string, [["Input CGST A/c", -50], ["P", 50]]),
  ];
  const mv = booksMovements(vouchers, roleResolver(cfg));
  it("maps month → role → net signed amount", () => {
    expect(mv.get("2025-05")!.get("input")).toBe(-100);
    expect(mv.get("2025-05")!.get("output")).toBe(-400);
    expect(mv.get("2025-06")!.get("input")).toBe(-50);
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
      { label: "Net ITC available (a-b)", values: Array(12).fill(0) },
      { label: "IGST net ITC", values: Array(12).fill(0) },
      { label: "CGST net ITC", values: [0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { label: "SGST net ITC", values: Array(12).fill(0) },
      { label: "Cess net ITC", values: Array(12).fill(0) },
    ],
  }));

  it("books kinds 1 and 2 from the 3B", () => {
    const movements = new Map<string, Map<string, number>>();
    const mayMv = new Map<string, number>();
    mayMv.set("Output CGST A/c", -400);
    mayMv.set("Output SGST A/c", -400);
    mayMv.set("Input CGST A/c", -100);
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
    mayMv.set("Output CGST A/c", -350);
    mayMv.set("Output SGST A/c", -400);
    mayMv.set("Input CGST A/c", -100);
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
});
