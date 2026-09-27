import { describe, expect, it } from "vitest";
import { booksMovements, roleResolver } from "../src/gst-adj.js";
import type { VoucherEntry, VoucherRow } from "../src/downstream.js";
import { loadGstAdjConfig } from "../src/gst-adj-config.js";
import { canonicalKey } from "../src/key.js";

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
