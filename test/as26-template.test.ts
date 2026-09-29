import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { buildWorkbook } from "../src/xlsx.js";
import { readWorkbook } from "../src/xlsx-read.js";
import {
  as26TemplateFileName,
  buildAs26MapTemplate,
  CREDIT_SHEET,
  loadAs26MapFile,
  parseAs26MapTemplate,
  templateDeductors,
} from "../src/as26-template.js";
import { EMPTY_AS26_MAP } from "../src/as26.js";
import type { As26File } from "../src/as26-file.js";
import { entry } from "./xlsx.test.js";

const dirs: string[] = [];
const tmpFile = (name: string, buf: Buffer | string): string => {
  const dir = mkdtempSync(join(tmpdir(), "as26-template-"));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MAPPING_COLUMNS = [
  { header: "26AS name" },
  { header: "kind" },
  { header: "26AS tax" },
  { header: "Tally ledger" },
];

const rawTemplate = (rows: Array<Array<string | number | null>>): Buffer =>
  buildWorkbook([{ name: "Mapping", columns: MAPPING_COLUMNS, rows }]);

const sheetOf = (buf: Buffer, name: string) => readWorkbook(buf).find((s) => s.name === name);

describe("templateDeductors", () => {
  it("dedupes by canonical 26AS name and sums the tax across summaries", () => {
    const file = {
      summaries: [
        { kind: "tds", name: "Alpha Traders", nameKey: "alphatraders", section: "194C", taxTotal: 1000, taxClaimed: 0, balanceCf: 0, gross: 0 },
        { kind: "tds", name: "ALPHA TRADERS", nameKey: "alphatraders", section: "194C", taxTotal: 500, taxClaimed: 0, balanceCf: 0, gross: 0 },
        { kind: "tcs", name: "Beta Minerals", nameKey: "betaminerals", section: "206CL", taxTotal: 250, taxClaimed: 0, balanceCf: 0, gross: 0 },
      ],
      transactions: [],
      skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
    } as As26File;
    expect(templateDeductors(file)).toEqual([
      { name: "Alpha Traders", kind: "tds", tax: 1500 },
      { name: "Beta Minerals", kind: "tcs", tax: 250 },
    ]);
  });
});

describe("buildAs26MapTemplate / parseAs26MapTemplate", () => {
  const deductors = [
    { name: "Alpha Traders", kind: "tds" as const, tax: 12000 },
    { name: "Beta Minerals", kind: "tcs" as const, tax: 500 },
  ];
  const map = { mappings: [{ ledger: "Alpha Traders Ledger", as26Name: "Alpha Traders" }] };
  const ledgers = ["Alpha Traders Ledger", "Beta Minerals Ledger"];

  it("round-trips an in-effect mapping and leaves the unmapped row blank", () => {
    const buf = buildAs26MapTemplate({ company: "Sample Company", deductors, map, ledgers });
    expect(parseAs26MapTemplate(buf)).toEqual({
      mappings: [{ ledger: "Alpha Traders Ledger", as26Name: "Alpha Traders" }],
      banks: [],
      creditLedgers: [],
    });
    const mapping = sheetOf(buf, "Mapping")!;
    const cell = (row: number, col: number) =>
      [...mapping.rows[row].cells.entries()].find(([c]) => c === col)?.[1].value;
    expect(cell(1, 3)).toBe("Alpha Traders Ledger");
    expect(cell(2, 3)).toBe(null);
  });

  it("round-trips several ledgers under one 26AS name, one per row", () => {
    const multi = { mappings: [
      { ledger: "Alpha Site Ledger", as26Name: "Alpha Traders" },
      { ledger: "Alpha Head Office", as26Name: "Alpha Traders" },
    ]};
    const buf = buildAs26MapTemplate({ deductors, map: multi, ledgers: ["Alpha Site Ledger", "Alpha Head Office"] });
    expect(parseAs26MapTemplate(buf)).toEqual({ ...multi, banks: [], creditLedgers: [] });
    const mapping = sheetOf(buf, "Mapping")!;
    const nameAt = (row: number) => mapping.rows[row].cells.get(0)?.value;
    const ledgerAt = (row: number) => mapping.rows[row].cells.get(3)?.value;
    expect(nameAt(1)).toBe("Alpha Traders");
    expect(ledgerAt(1)).toBe("Alpha Site Ledger");
    expect(nameAt(2)).toBe("Alpha Traders");
    expect(ledgerAt(2)).toBe("Alpha Head Office");
  });

  it("accepts a hand-added second row for the same 26AS name", () => {
    expect(parseAs26MapTemplate(rawTemplate([
      ["Alpha Traders", "tds", 12000, "Alpha Site Ledger"],
      ["Alpha Traders", "tds", "", "Alpha Head Office"],
    ]))).toEqual({ mappings: [
      { ledger: "Alpha Site Ledger", as26Name: "Alpha Traders" },
      { ledger: "Alpha Head Office", as26Name: "Alpha Traders" },
    ], banks: [], creditLedgers: [] });
  });

  it("skips fully blank rows and pre-filled rows with no ledger yet", () => {
    expect(parseAs26MapTemplate(rawTemplate([
      ["Alpha Traders", "tds", 12000, ""],
      [null, null, null, null],
      ["Beta Minerals", "tcs", 500, "Beta Minerals Ledger"],
    ]))).toEqual({
      mappings: [{ ledger: "Beta Minerals Ledger", as26Name: "Beta Minerals" }],
      banks: [],
      creditLedgers: [],
    });
  });

  it("refuses a ledger mapped twice (even to different 26AS names) citing the row number only", () => {
    let msg = "";
    try {
      parseAs26MapTemplate(rawTemplate([
        ["Alpha Traders", "tds", 1, "Alpha Ledger"],
        ["Beta Minerals", "tcs", 2, "Alpha Ledger"],
      ]));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/as26-map template row 3/);
    expect(msg).not.toContain("Alpha");
    expect(msg).not.toContain("Beta");
  });

  it("refuses a Tally ledger with no 26AS name citing the row number only", () => {
    let msg = "";
    try {
      parseAs26MapTemplate(rawTemplate([["", "", null, "Orphan Ledger"]]));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/as26-map template row 2/);
    expect(msg).not.toContain("Orphan Ledger");
  });

  it("refuses a workbook with no Mapping sheet, naming only the sheets it found", () => {
    const buf = buildWorkbook([{ name: "Nonsense", columns: [{ header: "x" }], rows: [["y"]] }]);
    expect(() => parseAs26MapTemplate(buf)).toThrow(/no "Mapping" sheet — found: Nonsense/);
  });

  it("always writes the Ledgers sheet and backs the Tally ledger dropdown with its range", () => {
    const short = buildAs26MapTemplate({ deductors, map, ledgers });
    expect(sheetOf(short, "Ledgers")).toBeDefined();

    const many = Array.from({ length: 2700 }, (_, i) => `Sample Ledger Number ${i}`);
    const wide = buildAs26MapTemplate({ deductors, map, ledgers: many });
    const ref = sheetOf(wide, "Ledgers")!;
    expect(ref.rows).toHaveLength(2701); // header plus 2700 names
    expect(ref.rows[1].cells.get(0)?.value).toBe("Sample Ledger Number 0");
    // The dropdown binds to the Ledgers range, so a real company's thousands
    // of names ride the validation without an inline list cap.
    const xml = entry(wide, "xl/worksheets/sheet2.xml"); // Mapping is sheet 2
    expect(xml).toContain("<formula1>Ledgers!$A$2:$A$2701</formula1>");
  });

  it("keeps a comma or quote in a ledger name off the dropdown formula", () => {
    const buf = buildAs26MapTemplate({
      deductors,
      map,
      ledgers: ['Sample, Traders "Unit 2"', "Plain Ledger"],
    });
    const xml = entry(buf, "xl/worksheets/sheet2.xml");
    expect(xml).toContain("<formula1>Ledgers!$A$2:$A$3</formula1>");
    expect(xml).not.toContain("Sample, Traders");
  });

  it("names the file as26-map-template-<company|all>-<date>.xlsx", () => {
    expect(as26TemplateFileName("Acme Associates", "20260923")).toBe("as26-map-template-acme-associates-20260923.xlsx");
    expect(as26TemplateFileName(undefined, "20260923")).toBe("as26-map-template-all-20260923.xlsx");
  });
});

describe("loadAs26MapFile", () => {
  it("dispatches a .xlsx template to the workbook parser", () => {
    const buf = buildAs26MapTemplate({
      deductors: [{ name: "Alpha Traders", kind: "tds", tax: 1 }],
      map: { mappings: [{ ledger: "Alpha Ledger", as26Name: "Alpha Traders" }] },
      ledgers: ["Alpha Ledger"],
    });
    expect(loadAs26MapFile(tmpFile("map.xlsx", buf))).toEqual({
      mappings: [{ ledger: "Alpha Ledger", as26Name: "Alpha Traders" }],
      banks: [],
      creditLedgers: [],
    });
  });

  it("keeps the JSON map working unchanged", () => {
    const p = tmpFile("map.json", JSON.stringify({ mappings: [{ ledger: "L", as26Name: "N" }] }));
    expect(loadAs26MapFile(p)).toEqual({ mappings: [{ ledger: "L", as26Name: "N" }] });
  });

  it("degrades a missing file to empty with a warning", () => {
    const warns: string[] = [];
    expect(loadAs26MapFile("/nonexistent/as26-map.xlsx", (w) => warns.push(w))).toEqual(EMPTY_AS26_MAP);
    expect(warns).toHaveLength(1);
  });
});

// --- addendum 2: the Bank Interest sheet (design §12.5) ---

const BANK_COLUMNS = [
  { header: "26AS name (bank)" },
  { header: "Interest income ledger" },
  { header: "FD ledger" },
];
const rawBank = (rows: Array<Array<string | number | null>>): Buffer =>
  buildWorkbook([
    { name: "Mapping", columns: MAPPING_COLUMNS, rows: [] },
    { name: "Bank Interest", columns: BANK_COLUMNS, rows },
  ]);

describe("Bank Interest mapping sheet", () => {
  it("the generated template contains the blank Bank Interest sheet", () => {
    const buf = buildAs26MapTemplate({ company: "Sample", deductors: [], map: { mappings: [] }, ledgers: [] });
    const sheet = sheetOf(buf, "Bank Interest");
    expect(sheet).toBeDefined();
    const header = [...sheet!.rows[0].cells.entries()].map(([c, cell]) => `${c}:${cell.value}`).join("|");
    expect(header).toContain("26AS name (bank)");
    expect(header).toContain("Interest income ledger");
    expect(header).toContain("FD ledger");
  });
  it("groups rows by 26AS name into one bank entry with interest and FD ledgers", () => {
    const map = parseAs26MapTemplate(rawBank([
      ["Sample Bank", "Sample Bank FD Int A/c", null],
      ["Sample Bank", null, "Sample Bank FD A/c"],
      ["Other Bank Ltd", "Other Bank Int A/c", "Other Bank FD A/c"],
      [null, null, null],
    ]));
    expect(map.mappings).toEqual([]);
    expect(map.banks).toEqual([
      { as26Name: "Sample Bank", interestLedgers: ["Sample Bank FD Int A/c"], fdLedgers: ["Sample Bank FD A/c"] },
      { as26Name: "Other Bank Ltd", interestLedgers: ["Other Bank Int A/c"], fdLedgers: ["Other Bank FD A/c"] },
    ]);
  });
  it("accepts a bank with a name but no ledgers yet (fill-in progress row)", () => {
    const map = parseAs26MapTemplate(rawBank([["Sample Bank", "", null]]));
    expect(map.banks).toEqual([{ as26Name: "Sample Bank", interestLedgers: [], fdLedgers: [] }]);
  });
  it("refuses a ledger named twice on the sheet, citing the row number only", () => {
    let msg = "";
    try {
      parseAs26MapTemplate(rawBank([
        ["Sample Bank", "Sample Bank FD Int A/c", null],
        ["Sample Bank", "Sample Bank FD Int A/c", null],
      ]));
    } catch (e) { msg = String((e as Error).message); }
    expect(msg).toMatch(/row 3/);
    expect(msg).not.toMatch(/Sample Bank/);
  });
  it("refuses ledgers filled with no bank name, citing the row number only", () => {
    expect(() =>
      parseAs26MapTemplate(rawBank([[null, "Sample Bank FD Int A/c", null]])),
    ).toThrow(/row 2 .*"26AS name \(bank\)" is blank/);
  });
  it("an older filled template without the sheet loads unchanged with empty banks", () => {
    expect(parseAs26MapTemplate(rawTemplate([
      ["Alpha Traders", "tds", 1, "Alpha Ledger"],
    ]))).toEqual({
      mappings: [{ ledger: "Alpha Ledger", as26Name: "Alpha Traders" }],
      banks: [],
      creditLedgers: [],
    });
  });
});

// --- the Credit Ledgers sheet: the operator's explicit books-side credit
// (receivable) ledgers, which replace the name heuristic when filled ---

const CREDIT_COLUMNS = [
  { header: "TDS/TCS credit ledger" },
  { header: "kind" },
];
const rawCredit = (rows: Array<Array<string | number | null>>): Buffer =>
  buildWorkbook([
    { name: "Mapping", columns: MAPPING_COLUMNS, rows: [] },
    { name: CREDIT_SHEET, columns: CREDIT_COLUMNS, rows },
  ]);

describe("Credit Ledgers sheet", () => {
  it("the generated template has the sheet, blank unless a list is already in force", () => {
    const buf = buildAs26MapTemplate({
      company: "Sample",
      deductors: [],
      map: { mappings: [], creditLedgers: [{ ledger: "TDS Receivable A/c", kind: "tds" }] },
      ledgers: ["TDS Receivable A/c"],
    });
    const sheet = sheetOf(buf, CREDIT_SHEET)!;
    expect(sheet).toBeDefined();
    const header = [...sheet!.rows[0].cells.entries()].map(([c, cell]) => `${c}:${cell.value}`).join("|");
    expect(header).toContain("TDS/TCS credit ledger");
    expect(header).toContain("kind");
    // round-trips: what the map holds comes back out of the written file
    expect(parseAs26MapTemplate(buf).creditLedgers).toEqual([{ ledger: "TDS Receivable A/c", kind: "tds" }]);

    const blank = buildAs26MapTemplate({ deductors: [], map: { mappings: [] }, ledgers: [] });
    expect(parseAs26MapTemplate(blank).creditLedgers).toEqual([]);
  });

  it("binds the ledger column to the Ledgers range and the kind to a two-value list", () => {
    const buf = buildAs26MapTemplate({
      deductors: [], map: { mappings: [] }, ledgers: ["TDS Receivable A/c", "TCS A/c"],
    });
    const xml = entry(buf, "xl/worksheets/sheet4.xml"); // Credit Ledgers is the 4th sheet
    expect(xml).toContain("<formula1>Ledgers!$A$2:$A$3</formula1>");
    expect(xml).toContain('<formula1>"tds,tcs"</formula1>');
  });

  it("reads a hand-filled row, kind case-insensitively, and skips blank rows", () => {
    const map = parseAs26MapTemplate(rawCredit([
      ["TDS (FY:25-26) A/c", "TDS"],
      [null, null],
      ["TCS Payable A/c", "tcs"],
    ]));
    expect(map.creditLedgers).toEqual([
      { ledger: "TDS (FY:25-26) A/c", kind: "tds" },
      { ledger: "TCS Payable A/c", kind: "tcs" },
    ]);
  });

  it("refuses a blank kind, a ledger named twice, and a numeric cell, citing row/column only", () => {
    expect(() => parseAs26MapTemplate(rawCredit([["TDS Receivable A/c", ""]])))
      .toThrow(/row 2.*\(kind\).*choose tds or tcs/);
    expect(() => parseAs26MapTemplate(rawCredit([
      ["TDS Receivable A/c", "tds"],
      ["tds receivable a/c", "tds"],
    ]))).toThrow(/row 3.*already named earlier/);
    expect(() => parseAs26MapTemplate(rawCredit([["TDS Receivable A/c", 12345]])))
      .toThrow(/row 2, column B \(kind\).*numeric/);
  });

  it("refuses a kind that is neither tds nor tcs, and never echoes the value", () => {
    let msg = "";
    try {
      parseAs26MapTemplate(rawCredit([["TDS Receivable A/c", "cess"]]));
    } catch (e) { msg = String((e as Error).message); }
    expect(msg).toMatch(/row 2.*expected tds or tcs/);
    expect(msg).not.toMatch(/cess/);
  });

  it("refuses a sheet with no ledger column, naming only the headers it found", () => {
    const buf = buildWorkbook([
      { name: "Mapping", columns: MAPPING_COLUMNS, rows: [] },
      { name: CREDIT_SHEET, columns: [{ header: "notes" }], rows: [["tds"]] },
    ]);
    expect(() => parseAs26MapTemplate(buf))
      .toThrow(/Credit Ledgers' sheet needs a "TDS\/TCS credit ledger" header column.*found headers: notes/);
  });

  it("a template without the sheet loads with an empty list (heuristic fallback)", () => {
    const buf = buildWorkbook([{ name: "Mapping", columns: MAPPING_COLUMNS, rows: [] }]);
    expect(parseAs26MapTemplate(buf).creditLedgers).toEqual([]);
  });
});
