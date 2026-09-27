import { describe, expect, it } from "vitest";
import { booksMovements, roleResolver, analyzeGstAdj } from "../src/gst-adj.js";
import type { VoucherEntry, VoucherRow } from "../src/downstream.js";
import { parseThreeB } from "../src/gst-adj-3b.js";
import { loadGstAdjConfig } from "../src/gst-adj-config.js";
import { make3bWorkbook } from "./helpers/gst-adj-3b.js";

const cfg = loadGstAdjConfig(undefined, () => {});

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

    const result = analyzeGstAdj({ threeB, movements, config: cfg });

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

    const result = analyzeGstAdj({ threeB, movements, config: cfg });

    const findings = result.findings;
    const cgstWarnings = findings.filter((f) => f.id === "gadj_3b_ledger_mismatch" && f.severity === "warning");
    const cgstReviews = findings.filter((f) => f.id === "gadj_3b_ledger_mismatch" && f.severity === "review");

    expect(cgstWarnings.length).toBeGreaterThanOrEqual(1);
    expect(cgstReviews.length).toBeGreaterThanOrEqual(1);
  });
});
