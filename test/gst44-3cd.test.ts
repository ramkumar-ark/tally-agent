import { describe, expect, it } from "vitest";
import { readXlsm } from "../src/xlsm.js";
import { readSchema } from "../src/winman3cd.js";
import { GST44_PART, makeWinmanGst44Fixture } from "./fixtures/winman-fixture.js";

describe("winman gst44 fixture", () => {
  it("carries the clause-44 schema the reader expects", () => {
    const pkg = readXlsm(makeWinmanGst44Fixture());
    const s = readSchema(pkg, "Break-up of GST expenditure");
    expect(s.formId).toBe("3CDGSTbreakup44");
    expect(s.firstDataRow).toBe(8);
    expect(s.fieldPath).toBe("");
    expect(s.partName).toBe(GST44_PART);
    expect([...s.keys.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0])).toEqual([
      "PARTICULARS", "TOTALEXPENDITURE", "TOWARDSSUPPLIES", "COMPOSITIONSUPPLIER", "OTHERS", "REGISTEREDUNDERGST",
    ]);
  });

  it("marks the prototype row hidden in row 7, like the real export", () => {
    const pkg = readXlsm(makeWinmanGst44Fixture());
    const s = readSchema(pkg, "Break-up of GST expenditure");
    expect(s.prototypeRow).toBe(7);
    expect(s.prototypeStyles.get(0)).toBe(87);
    expect(s.prototypeStyles.get(5)).toBe(88);
  });
});
