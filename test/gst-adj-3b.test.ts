import { describe, expect, it } from "vitest";
import { make3bWorkbook, SECTIONS } from "./helpers/gst-adj-3b.js";
import { parseThreeB } from "../src/gst-adj-3b.js";

describe("parseThreeB month binding", () => {
  it("binds 12 fuzzy month headers positionally and reads the header block", () => {
    const s = parseThreeB(make3bWorkbook());
    expect(s.months).toEqual(["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
    expect(s.companyName).toBe("Test Constructions");
    expect(s.gstin).toBe("33AAAAA0000A0Z0");
    expect(s.state).toBe("Tamil Nadu");
  });
  it("accepts a part-year file", () => {
    const s = parseThreeB(make3bWorkbook({ months: ["October", "November", "December"] }));
    expect(s.months).toEqual(["2025-10", "2025-11", "2025-12"]);
  });
  it("throws citing the row when a header is not a month", () => {
    expect(() => parseThreeB(make3bWorkbook({ months: ["Foo", "May"] }))).toThrow(/row 4/i);
  });
});

describe("parseThreeB section extraction", () => {
  const s = parseThreeB(make3bWorkbook());
  it("extracts outwardTaxable", () => {
    expect(s.outwardTaxable["2025-05"]).toBe(1000);
  });
  it("extracts outwardTax by head", () => {
    expect(s.outwardTax["2025-05"].igst).toBe(103.03);
    expect(s.outwardTax["2025-05"].sgst).toBe(102.02);
    expect(s.outwardTax["2025-05"].cess).toBe(104.04);
    expect(s.outwardTax["2025-05"].cgst).toBe(101.01);
  });
  it("extracts rcmTax by head", () => {
    expect(s.rcmTax["2025-05"].igst).toBe(11.12);
    expect(s.rcmTax["2025-05"].cgst).toBe(11.11);
  });
  it("extracts itcRcm by head", () => {
    expect(s.itcRcm["2025-05"].igst).toBe(21.22);
    expect(s.itcRcm["2025-05"].sgst).toBe(21.21);
  });
  it("extracts itcOther by head", () => {
    expect(s.itcOther["2025-05"].igst).toBe(31.32);
    expect(s.itcOther["2025-05"].cgst).toBe(31.31);
  });
  it("adds itcReversed parts together", () => {
    expect(s.itcReversed["2025-05"].igst).toBe(41.41 + 42.42);
    expect(s.itcReversed["2025-05"].sgst).toBe(41.41 + 42.42);
    expect(s.itcReversed["2025-05"].cess).toBe(41.41 + 43.43);
    expect(s.itcReversed["2025-05"].cgst).toBe(41.41 + 43.43);
  });
  it("derives netItc as 4C = 4A − 4B(1) (RCM + all-other − reversed), excluding reclaim", () => {
    expect(s.netItc["2025-05"].igst).toBe(s.itcRcm["2025-05"].igst + s.itcOther["2025-05"].igst - s.itcReversed["2025-05"].igst);
    expect(s.netItc["2025-05"].sgst).toBe(s.itcRcm["2025-05"].sgst + s.itcOther["2025-05"].sgst - s.itcReversed["2025-05"].sgst);
    expect(s.netItc["2025-05"].cess).toBe(s.itcRcm["2025-05"].cess + s.itcOther["2025-05"].cess - s.itcReversed["2025-05"].cess);
    expect(s.netItc["2025-05"].cgst).toBe(s.itcRcm["2025-05"].cgst + s.itcOther["2025-05"].cgst - s.itcReversed["2025-05"].cgst);
  });
  it("extracts itcReclaimed by head", () => {
    expect(s.itcReclaimed["2025-05"].sgst).toBe(52.52);
  });
  it("flags tdsSectionPresent from Table 12", () => {
    expect(s.tdsSectionPresent).toBe(true);
  });
  it("degrades to all-zero on a workbook without the TDS sheet", () => {
    const s2 = parseThreeB(make3bWorkbook({ rows: SECTIONS.filter((r) => !r.label.includes("reclaimed") && !r.label.toLowerCase().includes("table 12")) }));
    expect(s2.tdsSectionPresent).toBe(false);
    expect(s2.itcReclaimed["2025-05"].sgst).toBe(0);
  });
});
