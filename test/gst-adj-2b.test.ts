import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { make2bWorkbook, ser } from "./helpers/gst-adj-2b.js";
import { monthDiff, parseItc2bFolder } from "../src/gst-adj-2b.js";

function makeWarn(): { calls: string[]; warn: (msg: string) => void } {
  const calls: string[] = [];
  return { calls, warn: (msg: string) => calls.push(msg) };
}

describe("parseItc2bFolder", () => {
  it("parses a v2 workbook: period, gstin, compound header, key, tax", async () => {
    const { calls, warn } = makeWarn();
    const dir = mkdtempSync(join(tmpdir(), "gadj-2b-"));
    writeFileSync(join(dir, "apr.xlsx"), make2bWorkbook({ period: "1-Apr-25 to 30-Apr-25", layout: "v2", rows: [
      { date: ser(2025, 4, 7), party: "Test Traders", vchNo: "15", docNo: "8", cgst: 13332.42, sgst: 13332.42 },
      { date: ser(2025, 4, 9), party: "Test Agency", vchNo: "18", docNo: "1305", cgst: 9160.2000000000007, sgst: 9160.2000000000007 },
    ] }));
    const { lists, gstinByMonth } = await parseItc2bFolder(dir, warn);
    expect(gstinByMonth.get("2025-04")).toBe("33AAAAA0000A0Z0");
    const list = lists.get("2025-04")!;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ key: "8|33AAAAA0000A0Z0", docNo: "8", vchNo: "15", date: "20250407" });
    expect(list[1].tax.cgst).toBe(9160.2);
    expect(list[1].tax.igst).toBe(0);
    expect(list[1].tax.sgst).toBe(9160.2);
    rmSync(dir, { recursive: true, force: true });
    void calls;
  });
  it("remaps v3/v4 by header text, not position", async () => {
    const { warn } = makeWarn();
    const dir = mkdtempSync(join(tmpdir(), "gadj-2b-"));
    // v3: Vch Type + Vch No., no Doc No. → key from vchNo
    writeFileSync(join(dir, "mar_v3.xlsx"), make2bWorkbook({ period: "1-Mar-25 to 31-Mar-25", layout: "v3", rows: [
      { date: ser(2025, 3, 10), party: "Alpha", vchNo: "55", cgst: 100, sgst: 100 },
    ] }));
    // v4: Doc No. + Doc Date, no Vch No. → key from docNo
    writeFileSync(join(dir, "feb_v4.xlsx"), make2bWorkbook({ period: "1-Feb-25 to 28-Feb-25", layout: "v4", rows: [
      { date: ser(2025, 2, 14), party: "Beta", docNo: "99", cgst: 200, igst: 200 },
    ] }));
    const { lists } = await parseItc2bFolder(dir, warn);
    const mar = lists.get("2025-03")!;
    expect(mar).toHaveLength(1);
    expect(mar[0]).toMatchObject({ key: "55|33AAAAA0000A0Z0", docNo: null, vchNo: "55" });
    expect(mar[0].tax.cgst).toBe(100);
    const feb = lists.get("2025-02")!;
    expect(feb).toHaveLength(1);
    expect(feb[0]).toMatchObject({ key: "99|33AAAAA0000A0Z0", docNo: "99", vchNo: null });
    expect(feb[0].tax.igst).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  });
  it("reads a registration GSTIN whose check digit is a letter (DSV 33AAMFD4273C1ZP)", async () => {
    const { warn } = makeWarn();
    const dir = mkdtempSync(join(tmpdir(), "gadj-2b-"));
    writeFileSync(join(dir, "apr.xlsx"), make2bWorkbook({
      period: "1-Apr-25 to 30-Apr-25",
      gstin: "33AAMFD4273C1ZP",
      layout: "v2",
      rows: [{ date: ser(2025, 4, 7), party: "Test Traders", gstin: "33AAMFD4273C1ZP", vchNo: "15", docNo: "8", cgst: 100 }],
    }));
    const { lists, gstinByMonth } = await parseItc2bFolder(dir, warn);
    expect(gstinByMonth.get("2025-04")).toBe("33AAMFD4273C1ZP");
    expect(lists.get("2025-04")![0]).toMatchObject({ key: "8|33AAMFD4273C1ZP" });
    rmSync(dir, { recursive: true, force: true });
  });
  it("is case-insensitive on the sheet name and treats a missing sheet as no list", async () => {
    const { warn } = makeWarn();
    const dir = mkdtempSync(join(tmpdir(), "gadj-2b-"));
    writeFileSync(join(dir, "may.xlsx"), make2bWorkbook({ period: "1-May-25 to 31-May-25", sheetName: "NOT REFLECTED", layout: "v1", rows: [
      { date: ser(2025, 5, 5), party: "Gamma", cgst: 50 },
    ] }));
    writeFileSync(join(dir, "jun.xlsx"), make2bWorkbook({ period: "1-Jun-25 to 30-Jun-25", sheetName: "OtherSheet", layout: "v1", rows: [
      { date: ser(2025, 6, 5), party: "Delta", cgst: 60 },
    ] }));
    const { lists, gstinByMonth } = await parseItc2bFolder(dir, warn);
    expect(lists.get("2025-05")?.length).toBe(1);
    expect(lists.has("2025-06")).toBe(false);
    expect(gstinByMonth.get("2025-06")).toBe("33AAAAA0000A0Z0");
    rmSync(dir, { recursive: true, force: true });
  });
  it("ignores a repeated period with a warning (first wins)", async () => {
    const { calls, warn } = makeWarn();
    const dir = mkdtempSync(join(tmpdir(), "gadj-2b-"));
    writeFileSync(join(dir, "jan.xlsx"), make2bWorkbook({ period: "1-Jan-26 to 31-Jan-26", layout: "v1", rows: [
      { date: ser(2026, 1, 10), party: "Epsilon", cgst: 30 },
    ] }));
    writeFileSync(join(dir, "jan_copy.xlsx"), make2bWorkbook({ period: "1-Jan-26 to 31-Jan-26", layout: "v1", rows: [
      { date: ser(2026, 1, 11), party: "Zeta", cgst: 999 },
    ] }));
    const { lists } = await parseItc2bFolder(dir, warn);
    const jan = lists.get("2026-01")!;
    expect(jan).toHaveLength(1);
    expect(jan[0].party).toBe("Epsilon");
    expect(calls.some((c) => c.includes("repeated period"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it("warns when the filename month disagrees with the A3 period", async () => {
    const { calls, warn } = makeWarn();
    const dir = mkdtempSync(join(tmpdir(), "gadj-2b-"));
    writeFileSync(join(dir, "feb.xlsx"), make2bWorkbook({ period: "1-Jan-26 to 31-Jan-26", layout: "v1", rows: [
      { date: ser(2026, 1, 15), party: "Eta", cgst: 10 },
    ] }));
    await parseItc2bFolder(dir, warn);
    expect(calls.some((c) => c.includes("feb.xlsx"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
describe("monthDiff", () => {
  it("diffs against the previous month; a missing month is an empty list", () => {
    const lists = new Map<string, { key: string }[]>();
    const X = { key: "X" }, Y = { key: "Y" };
    lists.set("2025-04", [X]);
    lists.set("2025-05", [X, Y]);
    lists.set("2025-06", [Y]);
    const d = monthDiff(lists, ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08"]);
    expect(d["2025-05"].newly.map((e) => e.key)).toEqual([Y.key]);
    expect(d["2025-05"].dropped.map((e) => e.key)).toEqual([]);
    expect(d["2025-06"].newly.map((e) => e.key)).toEqual([]);
    expect(d["2025-06"].dropped.map((e) => e.key)).toEqual([X.key]);
    expect(d["2025-07"].dropped.map((e) => e.key)).toEqual([Y.key]);
    expect(d["2025-07"].newly.map((e) => e.key)).toEqual([]);
    expect(d["2025-08"]).toEqual({ newly: [], dropped: [] });
  });
});
