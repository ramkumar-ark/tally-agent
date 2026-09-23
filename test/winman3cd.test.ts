import { describe, expect, it } from "vitest";
import { partText, readXlsm, replacePart } from "../src/xlsm.js";
import { readSchema, readHandshake } from "../src/winman3cd.js";
import { makeWinmanFixture } from "./fixtures/winman-fixture.js";

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
