import { describe, expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { readWorkbook, type GridSheet } from "../src/xlsx-read.js";

/**
 * A test-local zip assembler: method-8 entries, local headers, central
 * directory, EOCD — the same flat shape Excel/Winman and the project's own
 * writer emit. Written here because the reader must never depend on the
 * writer, and there is no zip library to import.
 */
function zip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const comp = deflateRawSync(data);
    const sum = crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(sum, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(sum, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const CONTENT_TYPES = `[Content_Types].xml-placeholder-not-read`;

function workbookXml(sheets: string[]): string {
  return `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;
}

function relsXml(pairs: Array<[string, string]>): string {
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pairs
    .map(([id, target]) => `<Relationship Id="${id}" Type="worksheet" Target="${target}"/>`)
    .join("")}</Relationships>`;
}

const cell = (ref: string, inner: string, attrs = ""): string => `<c r="${ref}"${attrs}>${inner}</c>`;

function sheetXml(rows: string[]): string {
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join(
    "",
  )}</sheetData></worksheet>`;
}

function rowXml(n: number, cells: string): string {
  return `<row r="${n}">${cells}</row>`;
}

/** (a) shared strings: entities and a two-run rich-text <si>. */
const SHARED = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Acme &amp; Co &lt;Ltd&gt;</t></si><si><r><rPr><b/></rPr><t>Bold </t></r><r><t>plain run</t></r></si><si><t></t></si></sst>`;

/** (d) styles: builtin 14 on xf id 1, a custom numFmt id 164 on xf id 2. */
const STYLES = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\-mmm\\-yy"/></numFmts><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
const STYLES_CONDITIONAL = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="[Red][&gt;100]0.0%d"/></numFmts><cellXfs count="1"><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;

describe("readWorkbook", () => {
  it("reads shared strings with entities and a rich-text run concatenation", () => {
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/sharedStrings.xml", SHARED],
      ["xl/styles.xml", STYLES],
      [
        "xl/worksheets/sheet1.xml",
        sheetXml([
          rowXml(1, cell("A1", "<v>0</v>", ' t="s"') + cell("B1", "<v>1</v>", ' t="s"') + cell("C1", "<v>2</v>", ' t="s"')),
        ]),
      ],
    ]);
    const [sheet] = readWorkbook(buf);
    expect(sheet.name).toBe("Data");
    expect(sheet.state).toBe("visible");
    const cells = sheet.rows[0].cells;
    expect(cells.get(0)).toEqual({ value: "Acme & Co <Ltd>", isDate: false });
    // Rich text: the runs concatenate into one cell string.
    expect(cells.get(1)).toEqual({ value: "Bold plain run", isDate: false });
    expect(cells.get(2)).toEqual({ value: "", isDate: false });
  });

  it("reads inline strings (the project writer's style) and plain numbers", () => {
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/styles.xml", STYLES],
      [
        "xl/worksheets/sheet1.xml",
        sheetXml([rowXml(1, cell("A1", "<is><t>inline text</t></is>", ' t="inlineStr"') + cell("B1", "<v>4200.5</v>"))]),
      ],
    ]);
    const cells = readWorkbook(buf)[0].rows[0].cells;
    expect(cells.get(0)).toEqual({ value: "inline text", isDate: false });
    expect(cells.get(1)).toEqual({ value: 4200.5, isDate: false });
  });

  it("tolerates self-closing cells and a row-index gap", () => {
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/styles.xml", STYLES],
      [
        "xl/worksheets/sheet1.xml",
        sheetXml([rowXml(3, `<c r="A3" s="0"/>` + cell("B3", "<v>7</v>")) + rowXml(5, cell("A5", "<v>9</v>"))]),
      ],
    ]);
    const rows = readWorkbook(buf)[0].rows;
    expect(rows.map((r) => r.row)).toEqual([3, 5]);
    expect(rows[0].cells.get(0)).toEqual({ value: null, isDate: false });
    expect(rows[0].cells.get(1)).toEqual({ value: 7, isDate: false });
    expect(rows[1].cells.get(0)).toEqual({ value: 9, isDate: false });
  });

  it("marks a cell a date by its style: builtin 14 and a custom dd-mmm-yy numFmt", () => {
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/styles.xml", STYLES],
      [
        "xl/worksheets/sheet1.xml",
        sheetXml([rowXml(1, cell("A1", "<v>45980</v>", ' s="1"') + cell("B1", "<v>45981</v>", ' s="2"') + cell("C1", "<v>45982</v>", ' s="0"'))]),
      ],
    ]);
    const cells = readWorkbook(buf)[0].rows[0].cells;
    // The serial stays a number; isDate tells the caller how to interpret it.
    expect(cells.get(0)).toEqual({ value: 45980, isDate: true });
    expect(cells.get(1)).toEqual({ value: 45981, isDate: true });
    expect(cells.get(2)).toEqual({ value: 45982, isDate: false });
  });

  it("does not count a bracketed condition part as a date format by itself relaxing", () => {
    // [Red][>100]0.0%d — the code after the bracket conditions carries d, so
    // the custom format is date-bearing; assert the raw behaviour directly.
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/styles.xml", STYLES_CONDITIONAL],
      ["xl/worksheets/sheet1.xml", sheetXml([rowXml(1, cell("A1", "<v>1</v>", ' s="0"'))])],
    ]);
    expect(readWorkbook(buf)[0].rows[0].cells.get(0)!.isDate).toBe(true);
  });

  it("keeps hidden and veryHidden sheets, flagged by state", () => {
    const wb = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="List" sheetId="1" state="veryHidden" r:id="rId1"/><sheet name="Challan" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    const buf = zip([
      ["xl/workbook.xml", wb],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"], ["rId2", "worksheets/sheet2.xml"]])],
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", sheetXml([rowXml(1, cell("A1", "<v>1</v>"))])],
      ["xl/worksheets/sheet2.xml", sheetXml([rowXml(1, cell("A1", "<v>2</v>"))])],
    ]);
    const sheets = readWorkbook(buf);
    expect(sheets.map((s: GridSheet) => [s.name, s.state])).toEqual([
      ["List", "veryHidden"],
      ["Challan", "visible"],
    ]);
  });

  it("resolves sheet names through the rels even when the rId order is shuffled against sheet order", () => {
    // rId2 -> sheet1.xml carries the FIRST-named workbook sheet.
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Alpha", "Beta"])],
      [
        "xl/_rels/workbook.xml.rels",
        relsXml([
          ["rId1", "worksheets/sheet2.xml"],
          ["rId2", "worksheets/sheet1.xml"],
        ]),
      ],
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", sheetXml([rowXml(1, cell("A1", "<v>11</v>"))])],
      ["xl/worksheets/sheet2.xml", sheetXml([rowXml(1, cell("A1", "<v>22</v>"))])],
    ]);
    const sheets = readWorkbook(buf);
    expect(sheets.find((s) => s.name === "Alpha")!.rows[0].cells.get(0)!.value).toBe(22);
    expect(sheets.find((s) => s.name === "Beta")!.rows[0].cells.get(0)!.value).toBe(11);
  });

  it("tolerates rows and cells without r attributes, continuing sequentially", () => {
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", sheetXml([rowXml(1, "<c><v>1</v></c><c><v>2</v></c>")])],
    ]);
    const cells = readWorkbook(buf)[0].rows[0].cells;
    expect(cells.get(0)!.value).toBe(1);
    expect(cells.get(1)!.value).toBe(2);
  });

  it("reads a workbook with no sharedStrings part at all (inline-str only)", () => {
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", sheetXml([rowXml(1, cell("A1", "<is><t>only</t></is>", ' t="inlineStr"'))])],
    ]);
    expect(readWorkbook(buf)[0].rows[0].cells.get(0)!.value).toBe("only");
  });

  it("throws one clear error on a truncated zip", () => {
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", sheetXml([])],
    ]);
    const truncated = buf.subarray(0, buf.length - 15);
    expect(() => readWorkbook(truncated)).toThrow(/zip/i);
  });

  it("throws one clear error naming the part on malformed XML", () => {
    const buf = zip([
      ["xl/workbook.xml", workbookXml(["Data"])],
      ["xl/_rels/workbook.xml.rels", relsXml([["rId1", "worksheets/sheet1.xml"]])],
      ["xl/styles.xml", STYLES],
      // A close tag is expected but missing: the text below it ends up in <row>.
      ["xl/worksheets/sheet1.xml", sheetXml([rowXml(1, cell("A1", "<v>1</v>"))]).replace("</worksheet>", "guess")],
    ]);
    expect(() => readWorkbook(buf)).toThrow(/sheet1\.xml/i);
  });
});
