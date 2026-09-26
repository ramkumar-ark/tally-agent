import { describe, expect, it } from "vitest";
import { buildGstWorksheet, fyLabel, gstWorksheetFileName, WS_REVENUE_SHEET, WS_CAPITAL_SHEET } from "../src/gst44-worksheet-template.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { zipEntries } from "../src/xlsx-read.js";
import { GST44_TREATMENT_RULES } from "../src/gst44-treatments.js";
import type { WsLedgerRow } from "../src/gst44-worksheet.js";

const seededRow = (ledger: string, amount: number): WsLedgerRow => ({
  ledger,
  group: "Indirect Expenses",
  rowKey: "revenue",
  amount,
  seed: { d: 0, e: 0, h: 0, j: 0, treatment: "others", kind: "party evidence", reason: "party GSTIN evidence: registered purchase" },
});
const blankRow = (ledger: string, amount: number): WsLedgerRow => ({
  ledger,
  group: "Indirect Expenses",
  rowKey: "revenue",
  amount,
  seed: null,
});

const build = () =>
  buildGstWorksheet({
    company: "RVS Constructions ( Firm)",
    period: "FY 25-26",
    revenueRows: [seededRow("Fuel Expenses - 18%", 12345.67), blankRow("Mystery Ledger", 700)],
    capitalRows: [],
    rules: GST44_TREATMENT_RULES,
    priorYearUsed: false,
  });

describe("buildGstWorksheet", () => {
  it("carries the reference layout: title, Registered Dealers lead row, headers, band", () => {
    const sheets = readWorkbook(build());
    const names = sheets.map((s) => s.name);
    expect(names).toEqual([WS_REVENUE_SHEET, WS_CAPITAL_SHEET, "Instructions", "Vocabulary"]);

    const rev = sheets[0];
    const cell = (row: number, col: number) => rev.rows.find((r) => r.row === row)?.cells.get(col)?.value;
    expect(cell(1, 0)).toContain("RVS Constructions ( Firm)");
    expect(cell(2, 3)).toBe("Registered Dealers");
    expect(cell(3, 0)).toBe("Particulars");
    expect(cell(3, 1)).toBe("Amount (Rs)");
    expect(cell(3, 3)).toBe("Supplies exempt from GST");
    expect(cell(3, 6)).toBe("Total");
    expect(cell(3, 9)).toBe("not supply");
    expect(cell(3, 10)).toBe("Seeded as");
    expect(cell(3, 11)).toBe("Seed reason");
    expect(cell(4, 0)).toContain("REVENUE EXPENDITURE - FY 25-26");
    const cap = sheets[1];
    expect(cap.rows.find((r) => r.row === 3)?.cells.get(9)?.value).toBe("paid to govt");
    expect(cap.rows.find((r) => r.row === 4)?.cells.get(0)?.value).toContain("CAPITAL EXPENDITURE - FY 25-26");
  });

  it("writes seeded literals into D/E/H/J + K/L, and leaves unclassified rows blank", () => {
    const sheets = readWorkbook(build());
    const rev = sheets[0];
    const rowAt = (row: number) => rev.rows.find((r) => r.row === row)!.cells;
    const seeded = rowAt(5);
    expect(seeded.get(0)?.value).toBe("Fuel Expenses - 18%");
    expect(seeded.get(1)?.value).toBe(12345.67);
    expect(seeded.get(3)?.value).toBe(0);
    expect(seeded.get(4)?.value).toBe(0);
    expect(seeded.get(7)?.value).toBe(0);
    expect(seeded.get(9)?.value).toBe(0);
    expect(seeded.get(10)?.value).toBe("Registered - others");
    expect(String(seeded.get(11)?.value)).toContain("party GSTIN evidence");
    const blank = rowAt(6);
    expect(blank.get(0)?.value).toBe("Mystery Ledger");
    expect(blank.get(1)?.value).toBe(700);
    expect(blank.get(3)?.value ?? null).toBeNull();
    expect(blank.get(4)?.value ?? null).toBeNull();
    expect(blank.get(7)?.value ?? null).toBeNull();
    expect(blank.get(9)?.value ?? null).toBeNull();
    expect(blank.get(10)?.value).toBe("UNCLASSIFIED");
    expect(String(blank.get(11)?.value)).toContain("no treatment rule matched");
  });

  it("carries the Q-C formulas on seeded rows only, plus the closing rows", () => {
    const entries = zipEntries(build());
    const rev = entries.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(rev).toContain('<f>B5</f>');
    expect(rev).toContain('<f>I5-H5-J5</f>');
    expect(rev).toContain('<f>G5-E5-D5</f>');
    expect(rev).not.toContain('<f>B6</f>');
    expect(rev).not.toContain('<f>I6-H6-J6</f>');
    expect(rev).toContain('<f>SUM(B5:B6)</f>');
    expect(rev).toContain('<f>SUM(B5:B6)</f>');
    expect(rev).toContain('<f>ROUND(B7,0)</f>');
    expect(rev).toContain('<f>B9-B7</f>');
    // the ROUNDED and Difference rows keep their formulas beyond the data rows
    expect(rev).toContain("ROUNDED (for Winman)");
    expect(rev).toContain("Difference (must stay zero)");
  });

  it("roundtrips the capital sheet empty with literal zero closers, not reversed SUMs", () => {
    const sheets = readWorkbook(build());
    const cap = sheets[1];
    const books = cap.rows.find((r) => String(r.cells.get(0)?.value ?? "").startsWith("As per books"));
    expect(books?.cells.get(1)?.value).toBe(0);
    const entries = zipEntries(build());
    const capXml = entries.get("xl/worksheets/sheet2.xml")!.toString("utf8");
    // a reversed SUM range would normalise into a circular reference; only the
    // Difference formula (books literal minus TOTAL literal) may remain
    expect(capXml).not.toContain("SUM(B5:B4)");
    expect(capXml).not.toContain("ROUND(");
    const total = cap.rows.find((r) => r.cells.get(0)?.value === "TOTAL");
    expect(total?.cells.get(1)?.value).toBe(0);
  });

  it("states the fill-only contract and the approval gate in the instructions", () => {
    const sheets = readWorkbook(build());
    const lines = sheets[2].rows.map((r) => String(r.cells.get(0)?.value ?? ""));
    expect(lines.some((l) => l.includes("Fill ONLY columns D, E, H and J"))).toBe(true);
    expect(lines.some((l) => l.includes("UNCLASSIFIED"))).toBe(true);
    expect(lines.some((l) => l.includes("No prior-year sheet was supplied"))).toBe(true);
    expect(lines.some((l) => l.includes("approved"))).toBe(true);
    expect(lines.some((l) => l.includes("PATH"))).toBe(true);
  });

  it("lists every rule in the vocabulary sheet", () => {
    const sheets = readWorkbook(build());
    const ids = sheets[3].rows.map((r) => String(r.cells.get(0)?.value ?? ""));
    for (const rule of GST44_TREATMENT_RULES) expect(ids).toContain(rule.id);
  });

  it("names the file after the company and date", () => {
    expect(gstWorksheetFileName("RVS Constructions ( Firm)", "20260926")).toBe(
      "gst-nature-wise-break-up-rvs-constructions-firm-20260926.xlsx",
    );
    expect(gstWorksheetFileName(undefined, "20260926")).toBe("gst-nature-wise-break-up-gst-20260926.xlsx");
  });

  it("labels the Indian fiscal year of a date", () => {
    expect(fyLabel("20250401")).toBe("FY 25-26");
    expect(fyLabel("20260331")).toBe("FY 25-26");
    expect(fyLabel("20250331")).toBe("FY 24-25");
    expect(fyLabel("20240401")).toBe("FY 24-25");
  });
});
