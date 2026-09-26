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

/**
 * The clause-44 "Break-up of GST expenditure" sheet (design §2.1): row 1 gives
 * form id / sheet key / first data row / empty field path, row 2 gives the six
 * machine keys (cols A–F), row 7 is the hidden '-' prototype (first data row 8
 * minus one), rows 8/9 are pre-filled labels — invented values only.
 */
const GST44_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F9"/><sheetData>
<row r="1" hidden="1"><c r="A1" s="81" t="s"><v>17</v></c><c r="B1" s="81" t="s"><v>18</v></c><c r="C1" s="81" t="s"><v>19</v></c><c r="D1" s="81" t="s"><v>20</v></c></row>
<row r="2" hidden="1"><c r="A2" s="81" t="s"><v>21</v></c><c r="B2" s="81" t="s"><v>22</v></c><c r="C2" s="81" t="s"><v>23</v></c><c r="D2" s="81" t="s"><v>24</v></c><c r="E2" s="81" t="s"><v>25</v></c><c r="F2" s="81" t="s"><v>26</v></c></row>
<row r="7" hidden="1"><c r="A7" s="87" t="s"><v>10</v></c><c r="B7" s="88" t="s"><v>10</v></c><c r="C7" s="88" t="s"><v>10</v></c><c r="D7" s="88" t="s"><v>10</v></c><c r="E7" s="88" t="s"><v>10</v></c><c r="F7" s="88" t="s"><v>10</v></c></row>
<row r="8"><c r="A8" s="81" t="s"><v>27</v></c></row>
<row r="9"><c r="A9" s="81" t="s"><v>28</v></c></row>
</sheetData></worksheet>`;

const GST44_SS = [
  "3CDGSTbreakup44", "Break-up of GST expenditure", "8", "",
  "PARTICULARS", "TOTALEXPENDITURE", "TOWARDSSUPPLIES", "COMPOSITIONSUPPLIER", "OTHERS", "REGISTEREDUNDERGST",
  "Capital Expenditure", "Revenue Expenditure",
];

/** cellXfs indices mirror the real workbook: 88/89 are quotePrefix prototypes, 80/84 their twins. */
const DEFAULT_XF = `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;
const styleSheetOf = (specials: Readonly<Record<number, string>>): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="172" formatCode="dd\\-mmm\\-yy"/></numFmts>
<cellXfs count="94">${Array.from({ length: 94 }, (_, i) => specials[i] ?? DEFAULT_XF).join("")}</cellXfs></styleSheet>`;

const DEFAULT_SPECIALS: Readonly<Record<number, string>> = {
  80: `<xf numFmtId="172" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
  84: `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
  88: `<xf numFmtId="172" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>`,
  89: `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>`,
  93: `<xf numFmtId="49" fontId="0" fillId="4" borderId="0" xfId="0" quotePrefix="1"/>`,
};

const STYLES = styleSheetOf(DEFAULT_SPECIALS);

/**
 * The clause-44 workbook's styles: 87 is a quotePrefix text prototype whose
 * twin (81, same minus quotePrefix) already exists, while 88 is a quotePrefix
 * numFmt-1 prototype that has NO twin — so writing rows 8+ exercises
 * `resolveStyleTwins`' append path through this fixture.
 */
const GST44_STYLES = styleSheetOf({
  ...DEFAULT_SPECIALS,
  81: `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0"/>`,
  87: `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/>`,
  88: `<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>`,
});

export const PF_PART = "xl/worksheets/sheet1.xml";
export const ESI_PART = "xl/worksheets/sheet2.xml";
export const GST44_PART = "xl/worksheets/sheet4.xml";

export interface TdsTcsFixture {
  buf: Buffer;
  parts: Record<"TDS" | "TCS" | "RET" | "INT_TDS" | "INT_TCS", string>;
}

interface TdsTcsSheetSpec {
  name: string;
  fieldPath: string;
  /** row-2 machine keys, null = the real workbook's unkeyed column C. */
  keys: Array<string | null>;
  /** columns whose prototype carries the number/date twin (s89); the rest s88. */
  numeric: Set<number>;
}

const TDS_TCS_SPECS: TdsTcsSheetSpec[] = [
  {
    name: "TDS",
    fieldPath: "6.00.15.*.00.00",
    keys: ["DEDUCTOR", "TAN", "TDS", "NATUREOFPAYMENT", "TOTALPAYMENTS", "TDSSUMLIABLE", "TDSATRATESUMLIABLE", "TDSATRATETDS", "TDSATMINRATESUMLIABLE", "TDSATMINRATETDS", "TDSDEDUCTED"],
    numeric: new Set([4, 5, 6, 7, 8, 9, 10]),
  },
  {
    name: "TCS",
    fieldPath: "6.00.35.*.00.00",
    keys: ["COLLECTOR", "TAN", null, "NATUREOFRECEIPT", "TOTALRECIEPT", "TCSSUMLIABLE", "TCSATRATESUMLIABLE", "TCSATRATETDS", "TCSATMINRATESUMLIABLE", "TCSATMINRATETDS", "TCSCOLLECTED"],
    numeric: new Set([4, 5, 6, 7, 8, 9, 10]),
  },
  {
    name: "Return details",
    fieldPath: "6.00.62.07.*.00",
    keys: ["DEDUCTOR", "TAN", "FORMNO", "QUARTER", "DUEDATE", "DATEOFFILING", "RETURNISINACCURATE", "RETURNACCURATE"],
    numeric: new Set([4, 5]),
  },
  {
    name: "Interest on TDS",
    fieldPath: "6.00.75.*.00.00",
    keys: ["DEDUCTOR", "TAN", "FORMNO", "QUARTER", "INTERESTPAYABLE", "INTERESTPAID", "DATEOFPAYMENT"],
    numeric: new Set([4, 5, 6]),
  },
  {
    name: "Interest on TCS",
    fieldPath: "6.00.95.*.00.00",
    keys: ["COLLECTOR", "TAN", "FORMNO", "QUARTER", "INTERESTPAYABLE", "INTERESTPAID", "DATEOFPAYMENT"],
    numeric: new Set([4, 5, 6]),
  },
];

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

export function makeTdsTcsFixture(opts: { tcsSheet?: boolean } = {}): TdsTcsFixture {
  const specs = opts.tcsSheet === false ? TDS_TCS_SPECS.filter((s) => s.name !== "TCS") : TDS_TCS_SPECS;

  const ss: string[] = ["$WiNsArAlXlImPoRt2$", "9.6.1", "1623", "2026-2027", "F"];
  const idx = (s: string): number => {
    let i = ss.indexOf(s);
    if (i < 0) { i = ss.length; ss.push(s); }
    return i;
  };
  const dash = idx("-");

  const sheets = specs.map((spec) => {
    const lastCol = spec.keys.length - 1;
    const cell = (rower: number, i: number, shared: number | null): string => {
      const ref = `${String.fromCharCode(65 + i)}${rower}`;
      if (shared === null) return `<c r="${ref}"/>`;
      return `<c r="${ref}" t="s"><v>${shared}</v></c>`;
    };
    const row1 = spec.keys.map((_, i) => cell(1, i, [idx("3cdTDS"), idx(spec.name), idx("7"), idx(spec.fieldPath)][i])).join("");
    const row2 = spec.keys.map((key, i) => cell(2, i, key === null ? null : idx(key))).join("");
    const row6 = spec.keys.map((_, i) =>
      `<c r="${String.fromCharCode(65 + i)}6" s="${spec.numeric.has(i) ? 89 : 88}" t="s"><v>${dash}</v></c>`).join("");
    return part(`xl/worksheets/sheet${specs.indexOf(spec) + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${String.fromCharCode(65 + lastCol)}6"/><sheetData>
<row r="1" hidden="1">${row1}</row>
<row r="2" hidden="1">${row2}</row>
<row r="6" hidden="1">${row6}</row>
</sheetData></worksheet>`);
  });

  const workbookSheets = specs.map((spec, i) =>
    `<sheet name="${spec.name}" sheetId="${i + 2}" state="hidden" r:id="rId${i + 1}"/>`).join("");
  const rels = specs.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  const interRid = `rId${specs.length + 1}`;
  const interPart = `xl/worksheets/sheet${specs.length + 1}.xml`;

  const parts = [
    part("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`),
    part("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    part("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}<sheet name="INTER" sheetId="9" state="hidden" r:id="${interRid}"/></sheets></workbook>`),
    part("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="${interRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${specs.length + 1}.xml"/></Relationships>`),
    ...sheets,
    part(interPart, INTER_TDS_SHEET),
    part("xl/styles.xml", STYLES),
    part("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ss.length}" uniqueCount="${ss.length}">${ss.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`),
  ];

  const bins: Array<readonly [string, Buffer, 0 | 8]> = [
    ["xl/media/image1.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]), 0],
    ["xl/vbaProject.bin", Buffer.from("MACRO\u0000\u0001BYTES", "binary"), 8],
    ["xl/vbaProjectSignature.bin", Buffer.from("SIG\u0000\u00ff", "binary"), 8],
  ];

  const partNames = {} as TdsTcsFixture["parts"];
  const byName: Record<string, string> = { TDS: "TDS", TCS: "TCS", "Return details": "RET", "Interest on TDS": "INT_TDS", "Interest on TCS": "INT_TCS" };
  for (const spec of specs) partNames[byName[spec.name]] = `xl/worksheets/sheet${specs.indexOf(spec) + 1}.xml`;

  return { buf: zipOf([...parts.map(([n, b]) => [n, b, 8] as const), ...bins]), parts: partNames };
}

const INTER_TDS_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G1"/><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="G1"><v>1</v></c></row>
</sheetData></worksheet>`;

interface WinmanZipOpts {
  esiSheet?: boolean;
  gst44Sheet?: boolean;
  styles?: string;
  extraSs?: readonly string[];
}

function winmanZip(opts: WinmanZipOpts): Buffer {
  const { esiSheet, gst44Sheet, styles = STYLES, extraSs = [] } = opts;
  const parts = [
    part("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`),
    part("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    // sheetId deliberately disagrees with the part number: resolution must go
    // through the rels, never through sheetN.xml == sheetId N.
    part("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="P.F." sheetId="2" state="hidden" r:id="rId1"/>${esiSheet === false ? "" : `<sheet name="E.S.I." sheetId="3" state="hidden" r:id="rId2"/>`}${gst44Sheet ? `<sheet name="Break-up of GST expenditure" sheetId="5" state="hidden" r:id="rId4"/>` : ""}<sheet name="INTER" sheetId="9" state="hidden" r:id="rId3"/></sheets></workbook>`),
    part("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>${gst44Sheet ? `<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>` : ""}</Relationships>`),
    part(PF_PART, PF_SHEET),
    part(ESI_PART, PF_SHEET.replace("<v>1</v>", "<v>16</v>")),
    part("xl/worksheets/sheet3.xml", INTER_SHEET),
    ...(gst44Sheet ? [part(GST44_PART, GST44_SHEET)] : []),
    part("xl/styles.xml", styles),
    part("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${SS.length + 1 + extraSs.length}" uniqueCount="${SS.length + 1 + extraSs.length}">${[...SS, "E.S.I.", ...extraSs].map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`),
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

/**
 * A synthetic Winman Loans & Deposits workbook: the same self-describing shape
 * as `makeWinmanFixture`, with the three clause-31 data sheets (Sec.269SS
 * Loans & Deposits, Sec.269T Repayments Others, Sec.269ST_others), the hidden
 * INTER handshake (AY 2026-2027, validation on) and one hidden machinery
 * sheet. Every name, PAN-shaped string and amount is invented.
 */
const LOANS_SS = [
  /* 0 */ "269SS/269T_LoansAc/RpinCash",
  /* 1 */ "Sec.269SS Loans & Deposits",
  /* 2 */ "8",
  /* 3 */ "4.07.70.30.*.00",
  /* 4 */ "NAME",
  /* 5 */ "PANORAADHAAR",
  /* 6 */ "AMOUNT",
  /* 7 */ "SQUAREDUP",
  /* 8 */ "MAXAMOUNT",
  /* 9 */ "RECEIPT",
  /* 10 */ "RECIEPTNONAC",
  /* 11 */ "ADDRESS",
  /* 12 */ "Loans and deposits received",
  /* 13 */ "269SS",
  /* 14 */ "-",
  /* 15 */ "Party Alpha",
  /* 16 */ "ABCDE1234F",
  /* 17 */ "12 Synthetic Street",
  /* 18 */ "Sec.269T Repayments Others",
  /* 19 */ "4.07.80.50.*.00",
  /* 20 */ "Repayments of loans and deposits",
  /* 21 */ "269T",
  /* 22 */ "34 Invented Road",
  /* 23 */ "Sec.269ST_others",
  /* 24 */ "4.07.90.10.*.00",
  /* 25 */ "TYPEOFTRANSACTION",
  /* 26 */ "DATE",
  /* 27 */ "NATUREOFTRANSACTION",
  /* 28 */ "Receipts in cash",
  /* 29 */ "269ST",
  /* 30 */ "Other receipts",
  /* 31 */ "CASH",
  /* 32 */ "01-Apr-2025",
  /* 33 */ "Loan received",
  /* 34 */ "$WiNsArAlXlImPoRt2$",
  /* 35 */ "9.6.1",
  /* 36 */ "1623",
  /* 37 */ "2026-2027",
  /* 38 */ "F",
  /* 39 */ "internal machinery - do not edit",
  /* 40 */ "junk cell",
  /* 41 */ "Party Beta",
  /* 42 */ "FGHIJ2345K",
  /* 43 */ "9",
];

const loansRow1 = (formId: number, sheetKey: number, firstDataRow: number, fieldPath: number) =>
  `<row r="1" hidden="1"><c r="A1" s="78" t="s"><v>${formId}</v></c><c r="B1" s="78" t="s"><v>${sheetKey}</v></c><c r="C1" s="82" t="s"><v>${firstDataRow}</v></c><c r="D1" s="82" t="s"><v>${fieldPath}</v></c></row>`;

const loansPrototype = (row: number, lastCol: string) => {
  const styles = ["88", "88", "89", "89", "90", "93", "90", "93"];
  const cols = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const n = cols.indexOf(lastCol) + 1;
  return `<row r="${row}" hidden="1">${cols.slice(0, n).map((c, i) => `<c r="${c}${row}" s="${styles[i]}" t="s"><v>14</v></c>`).join("")}</row>`;
};

const LOANS_269SS_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:H9"/><sheetData>
${loansRow1(0, 1, 2, 3)}
<row r="2" hidden="1"><c r="A2" s="78" t="s"><v>4</v></c><c r="B2" s="78" t="s"><v>5</v></c><c r="C2" s="82" t="s"><v>6</v></c><c r="D2" s="82" t="s"><v>7</v></c><c r="E2" s="82" t="s"><v>8</v></c><c r="F2" s="82" t="s"><v>9</v></c><c r="G2" s="82" t="s"><v>10</v></c><c r="H2" s="82" t="s"><v>11</v></c></row>
<row r="4"><c r="A4" s="87" t="s"><v>12</v></c></row>
<row r="5"><c r="A5" s="81" t="s"><v>13</v></c></row>
${loansPrototype(7, "H")}
<row r="8"><c r="A8" t="s"><v>15</v></c><c r="B8" t="s"><v>16</v></c><c r="C8"><v>12345.67</v></c><c r="H8" t="s"><v>17</v></c></row>
<row r="9"><c r="A9" t="s"><v>41</v></c><c r="B9" t="s"><v>42</v></c><c r="C9"><v>5432.10</v></c><c r="H9" t="s"><v>22</v></c></row>
</sheetData></worksheet>`;

const LOANS_269T_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G9"/><sheetData>
${loansRow1(0, 18, 2, 19)}
<row r="2" hidden="1"><c r="A2" s="78" t="s"><v>4</v></c><c r="B2" s="78" t="s"><v>5</v></c><c r="C2" s="82" t="s"><v>6</v></c><c r="G2" s="82" t="s"><v>11</v></c></row>
<row r="4"><c r="A4" s="87" t="s"><v>20</v></c></row>
<row r="5"><c r="A5" s="81" t="s"><v>21</v></c></row>
${loansPrototype(7, "G")}
<row r="8"><c r="A8" t="s"><v>41</v></c><c r="B8" t="s"><v>42</v></c><c r="C8"><v>5432.10</v></c><c r="G8" t="s"><v>22</v></c></row>
<row r="9"><c r="A9" t="s"><v>15</v></c><c r="B9" t="s"><v>16</v></c><c r="C9"><v>12345.67</v></c><c r="G9" t="s"><v>17</v></c></row>
</sheetData></worksheet>`;

const LOANS_269ST_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G10"/><sheetData>
${loansRow1(0, 23, 43, 24)}
<row r="2" hidden="1"><c r="A2" s="78" t="s"><v>4</v></c><c r="B2" s="78" t="s"><v>5</v></c><c r="C2" s="82" t="s"><v>6</v></c><c r="D2" s="82" t="s"><v>25</v></c><c r="E2" s="82" t="s"><v>26</v></c><c r="F2" s="82" t="s"><v>27</v></c><c r="G2" s="82" t="s"><v>11</v></c></row>
<row r="4"><c r="A4" s="87" t="s"><v>28</v></c></row>
<row r="5"><c r="A5" s="81" t="s"><v>29</v></c></row>
<row r="7"><c r="A7" s="87" t="s"><v>30</v></c></row>
${loansPrototype(8, "G")}
<row r="9"><c r="A9" t="s"><v>15</v></c><c r="B9" t="s"><v>16</v></c><c r="C9"><v>12345.67</v></c><c r="D9" t="s"><v>31</v></c><c r="E9" t="s"><v>32</v></c><c r="F9" t="s"><v>33</v></c><c r="G9" t="s"><v>17</v></c></row>
<row r="10"><c r="A10" t="s"><v>41</v></c><c r="B10" t="s"><v>42</v></c><c r="C10"><v>5432.10</v></c><c r="D10" t="s"><v>31</v></c><c r="E10" t="s"><v>32</v></c><c r="F10" t="s"><v>33</v></c><c r="G10" t="s"><v>22</v></c></row>
</sheetData></worksheet>`;

const LOANS_INTER_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G1"/><sheetData>
<row r="1"><c r="A1" t="s"><v>34</v></c><c r="B1" t="s"><v>35</v></c><c r="C1" t="s"><v>36</v></c><c r="D1" t="s"><v>37</v></c><c r="E1" t="s"><v>38</v></c><c r="G1"><v>1</v></c></row>
</sheetData></worksheet>`;

const LOANS_JUNK_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData>
<row r="1"><c r="A1" t="s"><v>39</v></c><c r="B1" t="s"><v>40</v></c></row>
</sheetData></worksheet>`;

export function makeLoansWinmanFixture(opts: { formId?: string } = {}): Buffer {
  // `formId` swaps the shared string at index 0 — the A1 form id every data
  // sheet references — WITHOUT shifting any other index, so a test can
  // corrupt the form id cheaply (a re-zip of patched sheet XML is neither).
  const ss = opts.formId ? [opts.formId, ...LOANS_SS.slice(1)] : LOANS_SS;
  const parts = [
    part("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`),
    part("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    // sheetId deliberately disagrees with the part number, as in makeWinmanFixture.
    part("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sec.269SS Loans &amp; Deposits" sheetId="2" state="hidden" r:id="rId1"/><sheet name="Sec.269T Repayments Others" sheetId="3" state="hidden" r:id="rId2"/><sheet name="Sec.269ST_others" sheetId="4" state="hidden" r:id="rId3"/><sheet name="INTER" sheetId="9" state="hidden" r:id="rId4"/><sheet name="WinmanSys" sheetId="10" state="hidden" r:id="rId5"/></sheets></workbook>`),
    part("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/></Relationships>`),
    part("xl/worksheets/sheet1.xml", LOANS_269SS_SHEET),
    part("xl/worksheets/sheet2.xml", LOANS_269T_SHEET),
    part("xl/worksheets/sheet3.xml", LOANS_269ST_SHEET),
    part("xl/worksheets/sheet4.xml", LOANS_INTER_SHEET),
    part("xl/worksheets/sheet5.xml", LOANS_JUNK_SHEET),
    part("xl/styles.xml", STYLES),
    part("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ss.length}" uniqueCount="${ss.length}">${ss.map((s) => `<si><t>${s.replace(/&/g, "&amp;")}</t></si>`).join("")}</sst>`),
  ];
  const bins: Array<readonly [string, Buffer, 0 | 8]> = [
    ["xl/media/image1.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]), 0],
    ["xl/vbaProject.bin", Buffer.from("MACRO\u0000\u0001BYTES", "binary"), 8],
    ["xl/vbaProjectSignature.bin", Buffer.from("SIG\u0000\u00ff", "binary"), 8],
  ];
  return zipOf([...parts.map(([n, b]) => [n, b, 8] as const), ...bins]);
}

const WINMAN_ZIP_DEFAULTS: WinmanZipOpts = { esiSheet: true, gst44Sheet: false, styles: STYLES, extraSs: [] };

export function makeWinmanFixture(opts: { esiSheet?: boolean } = {}): Buffer {
  return winmanZip({ ...WINMAN_ZIP_DEFAULTS, ...opts });
}

/**
 * The same workbook with a fourth worksheet: the clause-44 GST break-up sheet.
 * Everything else (INTER handshake, binary parts) is identical to
 * makeWinmanFixture; the qa styles add a no-twin prototype so the write path
 * must append an xf.
 */
export function makeWinmanGst44Fixture(): Buffer {
  return winmanZip({ esiSheet: true, gst44Sheet: true, styles: GST44_STYLES, extraSs: GST44_SS });
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
