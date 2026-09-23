import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { buildWorkbook } from "../src/xlsx.js";
import { readWorkbook } from "../src/xlsx-read.js";
import {
  as26TemplateFileName,
  buildAs26MapTemplate,
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
    });
    const mapping = sheetOf(buf, "Mapping")!;
    const cell = (row: number, col: number) =>
      [...mapping.rows[row].cells.entries()].find(([c]) => c === col)?.[1].value;
    expect(cell(1, 3)).toBe("Alpha Traders Ledger");
    expect(cell(2, 3)).toBe(null);
  });

  it("skips fully blank rows and pre-filled rows with no ledger yet", () => {
    expect(parseAs26MapTemplate(rawTemplate([
      ["Alpha Traders", "tds", 12000, ""],
      [null, null, null, null],
      ["Beta Minerals", "tcs", 500, "Beta Minerals Ledger"],
    ]))).toEqual({ mappings: [{ ledger: "Beta Minerals Ledger", as26Name: "Beta Minerals" }] });
  });

  it("refuses a duplicate ledger or 26AS name citing the row number only", () => {
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
    expect(as26TemplateFileName("RVS Associates", "20260923")).toBe("as26-map-template-rvs-associates-20260923.xlsx");
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
