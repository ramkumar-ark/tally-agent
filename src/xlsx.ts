import { crc32, deflateRawSync } from "node:zlib";

/** A cell: text, a number, or blank. Dates arrive as YYYYMMDD in a "date" column. */
export type CellValue = string | number | null;

export interface Column {
  header: string;
  width?: number;
  format?: "text" | "money" | "date" | "pct";
  /**
   * An in-cell dropdown for the column's data rows (OOXML list validation).
   * `list` is a comma-joined quoted formula (an inline list); `formula` is a
   * raw formula1 body (e.g. `Ledgers!$A$2:$A$40` or a defined name) so a
   * cross-sheet range reference can back the dropdown whatever its length.
   * Convenience only — the parser re-validates everything it reads.
   */
  validation?: { list: string[] } | { formula: string };
}

export interface Sheet {
  name: string;
  /** Lines above the header row, each bold in column A. */
  title?: string[];
  /** Sheet visibility, as OOXML spells it (fixture-only today; see winman fixture). */
  state?: string;
  columns: Column[];
  rows: CellValue[][];
}

const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
function colName(n: number): string {
  let s = "";
  let i = n + 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = (i - r - 1) / 26;
  }
  return s;
}

/** Excel's serial day number: days since 1899-12-30. */
function serial(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Style ids used below: 0 plain, 1 bold, 2 money, 3 date, 4 percent. */
const STYLE_PLAIN = 0;
const STYLE_BOLD = 1;
const STYLE_OF: Record<NonNullable<Column["format"]>, number> = {
  text: STYLE_PLAIN, money: 2, date: 3, pct: 4,
};

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##,##0.00"/><numFmt numFmtId="165" formatCode="dd\\-mmm\\-yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function cellXml(ref: string, v: CellValue, style: number): string {
  const s = style === STYLE_PLAIN ? "" : ` s="${style}"`;
  if (v === null || v === undefined || v === "") return `<c r="${ref}"${s}/>`;
  if (typeof v === "number") return `<c r="${ref}"${s}><v>${v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const out: string[] = [];
  let r = 0;
  for (const line of sheet.title ?? []) {
    r += 1;
    out.push(`<row r="${r}">${cellXml(`A${r}`, line, STYLE_BOLD)}</row>`);
  }
  r += 1;
  out.push(
    `<row r="${r}">${sheet.columns.map((c, i) => cellXml(`${colName(i)}${r}`, c.header, STYLE_BOLD)).join("")}</row>`,
  );
  for (const dataRow of sheet.rows) {
    r += 1;
    const cells = sheet.columns.map((c, i) => {
      let v = dataRow[i] ?? null;
      const style = STYLE_OF[c.format ?? "text"];
      if (c.format === "date" && typeof v === "string" && /^\d{8}$/.test(v)) v = serial(v);
      return cellXml(`${colName(i)}${r}`, v, style);
    });
    out.push(`<row r="${r}">${cells.join("")}</row>`);
  }
  const cols = sheet.columns.some((c) => c.width)
    ? `<cols>${sheet.columns
        .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 12}" customWidth="1"/>`)
        .join("")}</cols>`
    : "";
  // In-cell dropdowns on the data rows of a validated column (never the header).
  const validations = sheet.columns.filter((c) =>
    c.validation ? ("list" in c.validation ? c.validation.list.length > 0 : !!c.validation.formula) : false,
  );
  const dataValidations = validations.length
    ? `<dataValidations count="${validations.length}">${validations
        .map((c) => {
          const idx = sheet.columns.indexOf(c);
          const firstDataRow = (sheet.title?.length ?? 0) + 2;
          const v = c.validation!;
          const body = "list" in v ? `"${v.list.join(",")}"` : v.formula;
          return (
            `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" ` +
            `sqref="${colName(idx)}${firstDataRow}:${colName(idx)}${firstDataRow + 249}">` +
            `<formula1>${body}</formula1></dataValidation>`
          );
        })
        .join("")}</dataValidations>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${out.join("")}</sheetData>${dataValidations}</worksheet>`;
}

/**
 * A deterministic zip: no timestamps anywhere, so the same input always
 * produces the same bytes and a review artifact is reproducible.
 */
function zip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const comp = deflateRawSync(data, { level: 9 });
    const sum = crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, "utf8");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);      // deflate
    lh.writeUInt16LE(0, 10);     // mod time: fixed, for determinism
    lh.writeUInt16LE(0, 12);     // mod date: fixed, for determinism
    lh.writeUInt32LE(sum, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(sum, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export function buildWorkbook(sheets: Sheet[]): Buffer {
  const parts: Array<[string, string]> = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ["xl/styles.xml", STYLES],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(parts);
}
