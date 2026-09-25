import { describe, expect, it } from "vitest";
import {
  NOTDS_FORM_ID,
  NR_SECTIONS,
  RESIDENT_SECTIONS,
  amountKeyOf,
  depositedKeyOf,
  doneKeyOf,
  isNrSectionSpelling,
  isResidentSectionSpelling,
  winmanSectionOf,
  type NotdsSheetKey,
} from "../src/notds.js";

/**
 * Pins the No TDS Disallowance presentation law verbatim: Winman's
 * TDSSECTION dropdown spellings (§2.2 of the design of record), the
 * law-key → Winman-spelling map, and the per-sheet row-2 key routing.
 */

describe("3cdNoTDS presentation law", () => {
  it("carries the form id", () => {
    expect(NOTDS_FORM_ID).toBe("3cdNoTDS");
  });

  it("has exactly 32 resident section spellings, in workbook order", () => {
    expect(RESIDENT_SECTIONS).toEqual([
      "192",
      "193",
      "194",
      "194-IA",
      "194-IB",
      "194-IC",
      "194-O",
      "194A",
      "194B",
      "194BA",
      "194BB",
      "194C",
      "194D",
      "194DA",
      "194EE",
      "194G",
      "194H",
      "194I (a)",
      "194I (b)",
      "194J",
      "194K",
      "194LA",
      "194LBA",
      "194LBB",
      "194LBC",
      "194M",
      "194N",
      "194P",
      "194Q",
      "194R",
      "194S",
      "194T",
    ]);
  });

  it("has exactly 16 non-resident section spellings, in workbook order", () => {
    expect(NR_SECTIONS).toEqual([
      "194BA",
      "194E",
      "194LB",
      "194LBA",
      "194LBA(3)",
      "194LBB",
      "194LBC",
      "194LC",
      "194N",
      "194Q",
      "194T",
      "195",
      "196A",
      "196B",
      "196C",
      "196D",
    ]);
  });

  it("maps the two law keys whose Winman spelling differs", () => {
    expect(winmanSectionOf("194-I(a)")).toBe("194I (a)");
    expect(winmanSectionOf("194-I(b)")).toBe("194I (b)");
  });

  it("passes every other law-table key through unchanged", () => {
    for (const key of ["192", "194C", "194J", "194A", "194H", "194Q", "194T", "194EE"]) {
      expect(winmanSectionOf(key)).toBe(key);
    }
  });

  it("rejects a bare 194-I", () => {
    expect(() => winmanSectionOf("194-I")).toThrow();
  });

  it("rejects any key outside the two lists", () => {
    expect(() => winmanSectionOf("194ZZ")).toThrow();
    expect(() => winmanSectionOf("")).toThrow();
  });

  it("accepts every resident spelling via isResidentSectionSpelling and nothing else", () => {
    for (const s of RESIDENT_SECTIONS) expect(isResidentSectionSpelling(s)).toBe(true);
    expect(isResidentSectionSpelling("194-I(a)")).toBe(false);
    expect(isResidentSectionSpelling("196D")).toBe(false);
  });

  it("accepts every NR spelling via isNrSectionSpelling and nothing else", () => {
    for (const s of NR_SECTIONS) expect(isNrSectionSpelling(s)).toBe(true);
    expect(isNrSectionSpelling("194C")).toBe(false);
  });

  it("routes the row-2 keys per sheet", () => {
    const resident = "40(a)(ia) to resident" as NotdsSheetKey;
    const nr = "40(a)(i) to non-resident" as NotdsSheetKey;
    const levy = "40(a)(ib) - Equalisation Levy" as NotdsSheetKey;
    const salary = "40(a)(iii)" as NotdsSheetKey;

    expect(doneKeyOf(resident)).toBe("TDSDONE");
    expect(doneKeyOf(nr)).toBe("TDSDONE");
    expect(doneKeyOf(levy)).toBe("LEVYDEDUCTED");
    expect(doneKeyOf(salary)).toBeUndefined();

    expect(depositedKeyOf(resident)).toBe("TDSDEPOSITED");
    expect(depositedKeyOf(nr)).toBe("TDSDEPOSITED");
    expect(depositedKeyOf(levy)).toBe("LEVYDEPOSITED");
    expect(depositedKeyOf(salary)).toBeUndefined();

    expect(amountKeyOf(resident)).toBe("EXPENSEAMOUNT");
    expect(amountKeyOf(nr)).toBe("EXPENSEAMOUNT");
    expect(amountKeyOf(levy)).toBe("EXPENSEAMOUNT");
    expect(amountKeyOf(salary)).toBe("AMOUNT");
  });
});
