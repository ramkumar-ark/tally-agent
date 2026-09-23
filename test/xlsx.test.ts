import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildWorkbook, type Sheet } from "../src/xlsx.js";

/** Read one stored/deflated entry out of the zip by name, without a zip library. */
export function entry(buf: Buffer, name: string): string {
  const target = Buffer.from(name, "utf8");
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) === 0x04034b50) {
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const compLen = buf.readUInt32LE(i + 18);
      const start = i + 30;
      if (buf.subarray(start, start + nameLen).equals(target)) {
        const dataStart = start + nameLen + extraLen;
        const raw = buf.subarray(dataStart, dataStart + compLen);
        return inflateRawSync(raw).toString("utf8");
      }
      i = start + nameLen + extraLen + compLen;
    } else {
      i += 1;
    }
  }
  throw new Error(`entry not found: ${name}`);
}

const sheet: Sheet = {
  name: "Blocks",
  title: ["Depreciation review", "UNVERIFIED BOOK SEED"],
  columns: [
    { header: "Block", width: 14, format: "text" },
    { header: "Opening WDV", width: 16, format: "money" },
    { header: "First use", width: 14, format: "date" },
  ],
  rows: [
    ["Block 15%", 482000, "20251119"],
    ['Ledger & Co <x> "q"', 0, null],
  ],
};

describe("buildWorkbook", () => {
  it("produces a zip carrying the OOXML parts Excel requires", () => {
    const buf = buildWorkbook([sheet]);
    expect(entry(buf, "[Content_Types].xml")).toContain("spreadsheetml.sheet.main+xml");
    expect(entry(buf, "_rels/.rels")).toContain("xl/workbook.xml");
    expect(entry(buf, "xl/workbook.xml")).toContain('name="Blocks"');
    expect(entry(buf, "xl/_rels/workbook.xml.rels")).toContain("worksheets/sheet1.xml");
    expect(entry(buf, "xl/styles.xml")).toContain("#,##,##0.00");
  });

  it("writes numbers as numbers and strings as inline strings", () => {
    const xml = entry(buildWorkbook([sheet]), "xl/worksheets/sheet1.xml");
    expect(xml).toContain("<v>482000</v>");
    expect(xml).toContain('t="inlineStr"');
  });

  it("converts a YYYYMMDD date column to the Excel serial for that day", () => {
    const xml = entry(buildWorkbook([sheet]), "xl/worksheets/sheet1.xml");
    // 19-Nov-2025 is 45980 days after the 1899-12-30 epoch.
    expect(xml).toContain("<v>45980</v>");
  });

  it("escapes XML metacharacters in a ledger name", () => {
    const xml = entry(buildWorkbook([sheet]), "xl/worksheets/sheet1.xml");
    expect(xml).toContain("Ledger &amp; Co &lt;x&gt; &quot;q&quot;");
    expect(xml).not.toContain("<x>");
  });

  it("is byte-identical across builds, so an artifact is reproducible", () => {
    expect(buildWorkbook([sheet]).equals(buildWorkbook([sheet]))).toBe(true);
  });

  it("gives the title and header rows the bold style and data rows none", () => {
    const xml = entry(buildWorkbook([sheet]), "xl/worksheets/sheet1.xml");
    expect(xml).toMatch(/<row r="1">[^]*?s="1"/);
    expect(xml).toMatch(/<row r="3">[^]*?s="1"/);   // header sits under two title lines
    expect(xml).toMatch(/<row r="4">[^]*?<c r="A4" t="inlineStr">/);
  });
});

describe("buildWorkbook validations", () => {
  const dropdown: Sheet = {
    name: "Pick",
    columns: [
      { header: "Section", validation: { list: ["194C", "194-I(a)", "194-I(b)"] } },
      { header: "Plain" },
    ],
    rows: [["194C", "x"]],
  };

  it("emits the dataValidations list block for a validated column", () => {
    const xml = entry(buildWorkbook([dropdown]), "xl/worksheets/sheet1.xml");
    expect(xml).toContain("<dataValidations count=\"1\">");
    expect(xml).toContain("<formula1>\"194C,194-I(a),194-I(b)\"</formula1>");
    expect(xml).toMatch(/sqref="A2:A251"/); // header at row 1, data from row 2
  });

  it("emits a raw cross-sheet range formula when asked for one", () => {
    const ranged: Sheet = {
      name: "Pick",
      columns: [
        { header: "Ledger", validation: { formula: "Ledgers!$A$2:$A$2701" } },
        { header: "Plain" },
      ],
      rows: [["x", "y"]],
    };
    const xml = entry(buildWorkbook([ranged]), "xl/worksheets/sheet1.xml");
    expect(xml).toContain("<formula1>Ledgers!$A$2:$A$2701</formula1>");
    expect(xml).toMatch(/sqref="A2:A251"/);
  });

  it("emits no validation block without a validation and leaves other sheets untouched", () => {
    const xml = entry(buildWorkbook([sheet]), "xl/worksheets/sheet1.xml");
    expect(xml).not.toContain("<dataValidation");
    const xml2 = entry(buildWorkbook([dropdown]), "xl/worksheets/sheet1.xml");
    expect(xml2).toContain("<sheetData>");
  });
});
