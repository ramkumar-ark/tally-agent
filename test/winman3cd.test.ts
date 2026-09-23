import { describe, expect, it } from "vitest";
import { partText, readXlsm, replacePart, writeXlsm } from "../src/xlsm.js";
import { readSchema, readHandshake, resolveStyleTwins, writeSheetRows } from "../src/winman3cd.js";
import { makeWinmanFixture, PF_PART } from "./fixtures/winman-fixture.js";

describe("winman schema", () => {
  const pkg = readXlsm(makeWinmanFixture());

  it("reads row 1 as form id / sheet key / first data row / field path", () => {
    const s = readSchema(pkg, "P.F.");
    expect(s.formId).toBe("EmployeePFESIfunds");
    expect(s.sheetKey).toBe("P.F.");
    expect(s.firstDataRow).toBe(7);
    expect(s.prototypeRow).toBe(6);
    expect(s.fieldPath).toBe("4.03.50.10.*.00");
    expect(s.partName).toBe("xl/worksheets/sheet1.xml");
  });

  it("keys columns off row 2, never the human header", () => {
    const s = readSchema(pkg, "P.F.");
    expect([...s.keys.entries()].sort()).toEqual([["AMOUNTCOLLECTED", 3], ["AMOUNTPAID", 2], ["DUEDATE", 0], ["PAIDON", 1]]);
  });

  it("takes the data styles from the prototype row", () => {
    const s = readSchema(pkg, "P.F.");
    expect(s.prototypeStyles.get(0)).toBe(88);
    expect(s.prototypeStyles.get(3)).toBe(89);
  });

  it("reads the INTER handshake", () => {
    const h = readHandshake(pkg);
    expect(h.marker).toBe("$WiNsArAlXlImPoRt2$");
    expect(h.assessmentYear).toBe("2026-2027");
    expect(h.validationOn).toBe(true);
  });

  it("refuses a workbook that is not a Winman 3CD export", () => {
    const notWinman = readXlsm(makeWinmanFixture());
    notWinman.entries = notWinman.entries.filter((e) => e.name !== "xl/worksheets/sheet3.xml");
    expect(() => readHandshake(notWinman)).toThrow(/not a Winman/i);
  });

  it("throws when C1 is not a positive integer", () => {
    const p = readXlsm(makeWinmanFixture());
    const xml = partText(p, "xl/worksheets/sheet1.xml").replace("<v>2</v>", "<v>0</v>");
    expect(() => readSchema(replacePart(p, "xl/worksheets/sheet1.xml", xml), "P.F.")).toThrow(/not a Winman/i);
  });

  it("throws when row 2 has no column keys", () => {
    const p = readXlsm(makeWinmanFixture());
    const xml = partText(p, "xl/worksheets/sheet1.xml").replace(/<row r="2"[\s\S]*?<\/row>/, '<row r="2" hidden="1"></row>');
    expect(() => readSchema(replacePart(p, "xl/worksheets/sheet1.xml", xml), "P.F.")).toThrow(/not a Winman/i);
  });
});

const rows = [
  { DUEDATE: { kind: "date", ymd: "20250515" }, PAIDON: { kind: "date", ymd: "20250514" },
    AMOUNTPAID: { kind: "number", value: 30575 }, AMOUNTCOLLECTED: { kind: "number", value: 30575 } },
  { DUEDATE: { kind: "date", ymd: "20250615" }, PAIDON: null,
    AMOUNTPAID: null, AMOUNTCOLLECTED: { kind: "number", value: 28195 } },
] as const;

describe("winman data rows", () => {
  const out = writeSheetRows(readXlsm(makeWinmanFixture()), "P.F.", rows as never);
  const xml = partText(out, PF_PART);

  it("starts at C1 and writes one row per record", () => {
    expect(xml).toContain('<row r="7"');
    expect(xml).toContain('<row r="8"');
    expect(xml).not.toContain('<row r="9"');
  });

  it("writes dates as Excel serials with the prototype style minus quotePrefix", () => {
    // 20250515 -> 45792 ; prototype s88 -> twin s80
    expect(xml).toContain('<c r="A7" s="80"><v>45792</v></c>');
    expect(xml).toContain('<c r="D7" s="84"><v>30575</v></c>');
  });

  it("omits the cell entirely for a blank value, as Winman does", () => {
    const r8 = xml.match(/<row r="8".*?<\/row>/s)![0];
    expect(r8).not.toContain('r="B8"');
    expect(r8).not.toContain('r="C8"');
    expect(r8).toContain('<c r="D8" s="84"><v>28195</v></c>');
  });

  it("leaves rows 1, 2, the headers and the prototype untouched", () => {
    expect(xml).toContain('<row r="1" hidden="1">');
    expect(xml).toContain('<row r="2" hidden="1">');
    expect(xml).toContain('<row r="6" hidden="1">');
    const s = readSchema(out, "P.F.");
    expect(s.firstDataRow).toBe(7);
    expect([...s.keys.keys()].sort()).toEqual(["AMOUNTCOLLECTED", "AMOUNTPAID", "DUEDATE", "PAIDON"]);
  });

  it("updates the dimension to the last written row", () => {
    expect(xml).toMatch(/<dimension ref="A1:[A-Z]+8"\/>/);
  });

  it("keeps the macro project and the stored JPEG byte-identical", () => {
    const before = readXlsm(makeWinmanFixture()).entries;
    const after = readXlsm(writeXlsm(out)).entries;
    for (const name of ["xl/vbaProject.bin", "xl/vbaProjectSignature.bin", "xl/media/image1.jpeg"]) {
      const a = before.find((e) => e.name === name)!, b = after.find((e) => e.name === name)!;
      expect(b.method).toBe(a.method);
      expect(b.data.equals(a.data)).toBe(true);
    }
  });

  // Review Focus #2
  it("writes no data rows for an empty record list and leaves the schema intact", () => {
    const empty = partText(writeSheetRows(readXlsm(makeWinmanFixture()), "P.F.", []), PF_PART);
    expect(empty).not.toContain('<row r="7"');
    expect(empty).toContain('<row r="6" hidden="1">');
    expect(empty).toMatch(/<dimension ref="A1:[A-Z]+6"\/>/);
  });

  it("appends a twin xf when the styles part has none", () => {
    // fixture xf 93 is quotePrefix with fill 4 and no twin -> a new xf must be appended
    const { twins, stylesXml } = resolveStyleTwins(partText(readXlsm(makeWinmanFixture()), "xl/styles.xml"), [93]);
    expect(twins.get(93)).toBe(94);
    expect(stylesXml).toContain('count="95"');
  });
});
