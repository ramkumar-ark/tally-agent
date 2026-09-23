import { deflateRawSync, crc32 } from "node:zlib";

/**
 * A 100% synthetic, Winman-shaped .xlsm. The real `PF ESI funds.xlsm` is not
 * committed: it carries client data and a signed third-party VBA project, and
 * at 403 KB it would not be reviewable. This fixture reproduces the exact
 * self-describing shape the reader depends on (design of record
 * docs/design/2026-09-23-winman-3cd-pf-esi-design.md §2.1, §2.3) with invented
 * values only — no real names, PAN, TAN or amounts anywhere.
 *
 * The zip writer below is deliberately independent of src/xlsm.ts (and of
 * src/xlsx.ts, src/xlsx-read.ts): the fixture must not be built with the code
 * under test, or a bug in the reader's package handling would be invisible.
 */

const part = (name: string, body: string) => [name, Buffer.from(body, "utf8")] as const;

/** Rows 1/2/4/5/6 exactly as the real "P.F." sheet has them (see design §2.1). */
const PF_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:I6"/><sheetData>
<row r="1" hidden="1"><c r="A1" s="78" t="s"><v>0</v></c><c r="B1" s="78" t="s"><v>1</v></c><c r="C1" s="82" t="s"><v>2</v></c><c r="D1" s="82" t="s"><v>3</v></c></row>
<row r="2" hidden="1"><c r="A2" s="78" t="s"><v>4</v></c><c r="B2" s="78" t="s"><v>5</v></c><c r="C2" s="82" t="s"><v>6</v></c><c r="D2" s="82" t="s"><v>7</v></c></row>
<row r="4"><c r="A4" s="87" t="s"><v>8</v></c></row>
<row r="5"><c r="A5" s="81" t="s"><v>9</v></c></row>
<row r="6" hidden="1"><c r="A6" s="88" t="s"><v>10</v></c><c r="B6" s="88" t="s"><v>10</v></c><c r="C6" s="89" t="s"><v>10</v></c><c r="D6" s="89" t="s"><v>10</v></c><c r="E6" s="90" t="s"><v>10</v></c><c r="F6" s="93" t="s"><v>10</v></c></row>
</sheetData></worksheet>`;

const INTER_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G10"/><sheetData>
<row r="1"><c r="A1" t="s"><v>11</v></c><c r="B1" t="s"><v>12</v></c><c r="C1" t="s"><v>13</v></c><c r="D1" t="s"><v>14</v></c><c r="E1" t="s"><v>15</v></c><c r="G1"><v>1</v></c></row>
</sheetData></worksheet>`;

const SS = ["EmployeePFESIfunds", "P.F.", "7", "4.03.50.10.*.00", "DUEDATE", "PAIDON", "AMOUNTPAID", "AMOUNTCOLLECTED", "Due date", "P.F.Contributions", "-", "$WiNsArAlXlImPoRt2$", "9.6.1", "1623", "2026-2027", "F"];

/** cellXfs indices mirror the real workbook: 88/89 are quotePrefix prototypes, 80/84 their twins. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="172" formatCode="dd\\-mmm\\-yy"/></numFmts>
<cellXfs count="94">${Array.from({ length: 94 }, (_, i) => {
  if (i === 80) return `<xf numFmtId="172" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`;
  if (i === 84) return `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`;
  if (i === 88) return `<xf numFmtId="172" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>`;
  if (i === 89) return `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>`;
  if (i === 93) return `<xf numFmtId="49" fontId="0" fillId="4" borderId="0" xfId="0" quotePrefix="1"/>`;
  return `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;
}).join("")}</cellXfs></styleSheet>`;

export const PF_PART = "xl/worksheets/sheet1.xml";
export const ESI_PART = "xl/worksheets/sheet2.xml";

export function makeWinmanFixture(opts: { esiSheet?: boolean } = {}): Buffer {
  const parts = [
    part("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`),
    part("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    // sheetId deliberately disagrees with the part number: resolution must go
    // through the rels, never through sheetN.xml == sheetId N.
    part("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="P.F." sheetId="2" state="hidden" r:id="rId1"/>${opts.esiSheet === false ? "" : `<sheet name="E.S.I." sheetId="3" state="hidden" r:id="rId2"/>`}<sheet name="INTER" sheetId="9" state="hidden" r:id="rId3"/></sheets></workbook>`),
    part("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`),
    part(PF_PART, PF_SHEET),
    part(ESI_PART, PF_SHEET.replace("<v>1</v>", "<v>16</v>")),
    part("xl/worksheets/sheet3.xml", INTER_SHEET),
    part("xl/styles.xml", STYLES),
    part("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${SS.length + 1}" uniqueCount="${SS.length + 1}">${[...SS, "E.S.I."].map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`),
  ];
  // A STORED (method 0) binary entry plus deflated macro parts: the entries that
  // must survive verbatim (Task 3 writes through these).
  const bins: Array<readonly [string, Buffer, 0 | 8]> = [
    ["xl/media/image1.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]), 0],
    ["xl/vbaProject.bin", Buffer.from("MACRO\u0000\u0001BYTES", "binary"), 8],
    ["xl/vbaProjectSignature.bin", Buffer.from("SIG\u0000\u00ff", "binary"), 8],
  ];
  return zipOf([...parts.map(([n, b]) => [n, b, 8] as const), ...bins]);
}

function zipOf(files: ReadonlyArray<readonly [string, Buffer, 0 | 8]>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const [name, raw, method] of files) {
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nb = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw) >>> 0, 14); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc32(raw) >>> 0, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
