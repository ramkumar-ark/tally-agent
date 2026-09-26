import { describe, expect, it } from "vitest";
import { partText, readXlsm, writeXlsm } from "../src/xlsm.js";
import { readSchema, readHandshake, writeSheetRows, type WinmanRow, type WinmanSchema } from "../src/winman3cd.js";
import { makeTdsTcsFixture } from "./fixtures/winman-fixture.js";

const SHEETS = ["TDS", "TCS", "Return details", "Interest on TDS", "Interest on TCS"] as const;

const EXPECTED: Record<(typeof SHEETS)[number], { part: string; fieldPath: string; keys: Array<[string, number]> }> = {
  TDS: {
    part: "xl/worksheets/sheet1.xml",
    fieldPath: "6.00.15.*.00.00",
    keys: [
      ["DEDUCTOR", 0], ["TAN", 1], ["TDS", 2], ["NATUREOFPAYMENT", 3], ["TOTALPAYMENTS", 4],
      ["TDSSUMLIABLE", 5], ["TDSATRATESUMLIABLE", 6], ["TDSATRATETDS", 7],
      ["TDSATMINRATESUMLIABLE", 8], ["TDSATMINRATETDS", 9], ["TDSDEDUCTED", 10],
    ],
  },
  TCS: {
    part: "xl/worksheets/sheet2.xml",
    fieldPath: "6.00.35.*.00.00",
    keys: [
      ["COLLECTOR", 0], ["TAN", 1], ["NATUREOFRECEIPT", 3], ["TOTALRECIEPT", 4],
      ["TCSSUMLIABLE", 5], ["TCSATRATESUMLIABLE", 6], ["TCSATRATETDS", 7],
      ["TCSATMINRATESUMLIABLE", 8], ["TCSATMINRATETDS", 9], ["TCSCOLLECTED", 10],
    ],
  },
  "Return details": {
    part: "xl/worksheets/sheet3.xml",
    fieldPath: "6.00.62.07.*.00",
    keys: [
      ["DEDUCTOR", 0], ["TAN", 1], ["FORMNO", 2], ["QUARTER", 3], ["DUEDATE", 4],
      ["DATEOFFILING", 5], ["RETURNISINACCURATE", 6], ["RETURNACCURATE", 7],
    ],
  },
  "Interest on TDS": {
    part: "xl/worksheets/sheet4.xml",
    fieldPath: "6.00.75.*.00.00",
    keys: [
      ["DEDUCTOR", 0], ["TAN", 1], ["FORMNO", 2], ["QUARTER", 3],
      ["INTERESTPAYABLE", 4], ["INTERESTPAID", 5], ["DATEOFPAYMENT", 6],
    ],
  },
  "Interest on TCS": {
    part: "xl/worksheets/sheet5.xml",
    fieldPath: "6.00.95.*.00.00",
    keys: [
      ["COLLECTOR", 0], ["TAN", 1], ["FORMNO", 2], ["QUARTER", 3],
      ["INTERESTPAYABLE", 4], ["INTERESTPAID", 5], ["DATEOFPAYMENT", 6],
    ],
  },
};

function rowFor(schema: WinmanSchema): WinmanRow {
  const row: WinmanRow = {};
  for (const [key] of schema.keys) {
    if (key.endsWith("DATE")) row[key] = { kind: "date", ymd: "20250731" };
    else if (/^(TOTAL|TDSAT|TDSATMIN|TDSDEDUCTED|TCSAT|TCSCOLLECTED|INTEREST)/.test(key)) row[key] = { kind: "number", value: 1010 };
    else row[key] = { kind: "text", value: "Sample only" };
  }
  return row;
}

describe("tds/tcs fixture schema", () => {
  const pkg = readXlsm(makeTdsTcsFixture().buf);

  it("reads the INTER handshake", () => {
    const h = readHandshake(pkg);
    expect(h.marker).toBe("$WiNsArAlXlImPoRt2$");
    expect(h.version).toBe("9.6.1");
    expect(h.build).toBe("1623");
    expect(h.assessmentYear).toBe("2026-2027");
    expect(h.validationOn).toBe(true);
  });

  for (const name of SHEETS) {
    const want = EXPECTED[name as (typeof SHEETS)[number]];

    it(`describes ${name}`, () => {
      const s = readSchema(pkg, name);
      expect(s.formId).toBe("3cdTDS");
      expect(s.sheetKey).toBe(name);
      expect(s.firstDataRow).toBe(7);
      expect(s.prototypeRow).toBe(6);
      expect(s.fieldPath).toBe(want.fieldPath);
      expect(s.partName).toBe(want.part);
      expect([...s.keys.entries()].sort((a, b) => a[1] - b[1])).toEqual(want.keys);
    });

    it(`round-trips rows on ${name}`, () => {
      const before = readXlsm(makeTdsTcsFixture().buf);
      const proto = partText(before, want.part).match(/<row r="6".*?<\/row>/s)![0];
      const out = writeSheetRows(before, name, [rowFor(readSchema(before, name))]);
      const xml = partText(out, want.part);
      expect(xml).toContain('<row r="7"');
      expect(xml).not.toContain('<row r="8"');
      expect(xml).toMatch(/<dimension ref="A1:[A-Z]+7"\/>/);
      expect(partText(out, want.part).match(/<row r="6".*?<\/row>/s)![0]).toBe(proto);

      const after = readSchema(out, name);
      expect(after.formId).toBe("3cdTDS");
      expect(after.firstDataRow).toBe(7);
      expect([...after.keys.entries()].sort((a, b) => a[1] - b[1])).toEqual(want.keys);
      for (const [key, col] of after.keys) {
        const letter = String.fromCharCode(65 + col);
        const ref = `${letter}7`;
        const s = after.prototypeStyles.get(col) === 88 ? "80" : "84";
        const cell = key.endsWith("DATE")
          ? `<c r="${ref}" s="${s}"><v>45869</v></c>`
          : /^(TOTAL|TDSAT|TDSATMIN|TDSDEDUCTED|TCSAT|TCSCOLLECTED|INTEREST)/.test(key)
            ? `<c r="${ref}" s="${s}"><v>1010</v></c>`
            : null;
        if (cell === null) {
          expect(xml).toMatch(new RegExp(`<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">Sample only</t></is></c>`));
        } else {
          expect(xml).toContain(cell);
        }
      }
    });
  }

  it("omits the TCS sheet when tcsSheet is false and keeps the other four", () => {
    const pkg4 = readXlsm(makeTdsTcsFixture({ tcsSheet: false }).buf);
    expect(() => readSchema(pkg4, "TCS")).toThrow(/no sheet named/i);
    for (const name of ["TDS", "Return details", "Interest on TDS", "Interest on TCS"]) {
      const s = readSchema(pkg4, name);
      expect(s.formId).toBe("3cdTDS");
      expect(s.firstDataRow).toBe(7);
    }
  });

  it("keeps the macro project and the stored JPEG byte-identical", () => {
    const fixture = makeTdsTcsFixture().buf;
    const before = readXlsm(fixture).entries;
    const after = readXlsm(writeXlsm(writeSheetRows(readXlsm(fixture), "TDS", [rowFor(readSchema(readXlsm(fixture), "TDS"))]))).entries;
    for (const name of ["xl/vbaProject.bin", "xl/vbaProjectSignature.bin", "xl/media/image1.jpeg"]) {
      const a = before.find((e) => e.name === name)!, b = after.find((e) => e.name === name)!;
      expect(b.method).toBe(a.method);
      expect(b.data.equals(a.data)).toBe(true);
    }
  });
});
