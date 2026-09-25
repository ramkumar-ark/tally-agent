import { describe, expect, it } from "vitest";
import { readXlsm } from "../src/xlsm.js";
import { readHandshake, readSchema } from "../src/winman3cd.js";
import { makeNotdsFixture, NOTDS_PARTS } from "./fixtures/winman-fixture.js";

// The §2.1 key layouts, verbatim from the design of record.
const RESIDENT_KEYS = [
  "DEDUCTEENAME", "DATEOFPAYMENT", "EXPENSEAMOUNT", "TDSDONE", "TDSDEPOSITED",
  "TDSSECTION", "NATUREOFPAYMENT", "ADDRESS", "CITY", "STATE", "PINZIP",
  "COUNTRY", "PANAADHAAR",
] as const;

const SALARY_KEYS = [
  "DEDUCTEENAME", "DATEOFPAYMENT", "AMOUNT",
  "ADDRESS", "CITY", "STATE", "PINZIP", "COUNTRY", "PANAADHAAR",
] as const;

describe("notds fixture schema", () => {
  const pkg = readXlsm(makeNotdsFixture());

  it("reads the INTER handshake", () => {
    const h = readHandshake(pkg);
    expect(h.marker).toBe("$WiNsArAlXlImPoRt2$");
    expect(h.assessmentYear).toBe("2026-2027");
    expect(h.validationOn).toBe(true);
  });

  it("40(a)(iii) starts at row 8 and has exactly the §2.1 sheet4 keys (no D–G)", () => {
    const s = readSchema(pkg, "40(a)(iii)");
    expect(s.formId).toBe("3cdNoTDS");
    expect(s.sheetKey).toBe("40(a)(iii)");
    expect(s.partName).toBe(NOTDS_PARTS.salary);
    expect(s.firstDataRow).toBe(8);
    expect(s.prototypeRow).toBe(7);
    expect(s.fieldPath).toBe("6.06.30.10.*.00");
    expect([...s.keys.entries()]).toEqual(SALARY_KEYS.map((key, i) => {
      const col = i < 3 ? i : i + 4;
      return [key, col];
    }));
  });

  it("Equalisation Levy has LEVY keys and no key at column F", () => {
    const s = readSchema(pkg, "40(a)(ib) - Equalisation Levy");
    expect(s.formId).toBe("3cdNoTDS");
    expect(s.partName).toBe(NOTDS_PARTS.levy);
    expect(s.firstDataRow).toBe(7);
    expect(s.fieldPath).toBe("6.06.14.07.*.00");
    expect(s.keys.get("LEVYDEDUCTED")).toBe(3);
    expect(s.keys.get("LEVYDEPOSITED")).toBe(4);
    expect(s.keys.get("NATUREOFPAYMENT")).toBe(6);
    expect(s.keys.get("TDSSECTION")).toBeUndefined();
    expect([...s.keys.keys()].filter((k) => k.startsWith("TDS"))).toEqual([]);
    expect([...s.keys.values()]).not.toContain(5);
    expect(s.keys.size).toBe(12);
  });

  it("resident sheet carries exactly the §2.1 sheet1 keys", () => {
    const s = readSchema(pkg, "40(a)(ia) to resident");
    expect(s.formId).toBe("3cdNoTDS");
    expect(s.partName).toBe(NOTDS_PARTS.resident);
    expect(s.firstDataRow).toBe(7);
    expect(s.fieldPath).toBe("6.06.10.10.*.00");
    expect([...s.keys.entries()]).toEqual(RESIDENT_KEYS.map((key, i) => [key, i]));
  });

  it("non-resident keys equal the resident keys", () => {
    const resident = readSchema(pkg, "40(a)(ia) to resident");
    const nr = readSchema(pkg, "40(a)(i) to non-resident");
    expect(nr.partName).toBe(NOTDS_PARTS.nonResident);
    expect(nr.firstDataRow).toBe(7);
    expect(nr.fieldPath).toBe("6.06.20.10.*.00");
    expect([...nr.keys.entries()]).toEqual([...resident.keys.entries()]);
  });

  it("prototype rows carry two quotePrefix styles with twins in styles.xml", () => {
    const s = readSchema(pkg, "40(a)(ia) to resident");
    expect(s.prototypeStyles.get(0)).toBe(88);
    expect(s.prototypeStyles.get(2)).toBe(89);
  });
});
