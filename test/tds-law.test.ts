import { describe, expect, it } from "vitest";
import {
  calendarMonths,
  depositDue,
  interestOn,
  lawOf,
  lateFeePerDay,
  statementDue,
  TDS_SECTIONS,
  wholeYearOnCross,
} from "../src/tds-law.js";

describe("TDS law table (FY 25-26)", () => {
  it("carries 194C rates by PAN 4th char and thresholds", () => {
    const law = lawOf("194C")!;
    expect(law.rates.standard).toBe(0.02);
    expect(law.rates.pan4thChar).toEqual({ P: 0.01, H: 0.01, C: 0.02, F: 0.02 });
    expect(law.rates.noPan).toBe(0.2);
    expect(law.threshold).toEqual({ single: 30000, aggregate: 100000 });
    expect(law.confirm).toContain("C1");
  });
  it("carries 194J professional 10% / technical 2%, threshold 50000", () => {
    const law = lawOf("194J")!;
    expect(law.rates.pan4thChar).toEqual({ P: 0.1, H: 0.1, C: 0.02, F: 0.02 });
    expect(law.threshold).toEqual({ aggregate: 50000 });
  });
  it("carries 194-I(a) at 2% (plant and machinery), per-month threshold 50000", () => {
    const law = lawOf("194-I(a)")!;
    expect(law.rates.standard).toBe(0.02);
    expect(law.rates.noPan).toBe(0.2);
    expect(law.rates.pan4thChar).toBeUndefined();
    expect(law.threshold).toEqual({ perMonth: 50000 });
    expect(wholeYearOnCross("194-I(a)")).toBe(true);
  });
  it("carries 194-I(b) at 10% (land and building), per-month threshold 50000", () => {
    const law = lawOf("194-I(b)")!;
    expect(law.rates.standard).toBe(0.1);
    expect(law.rates.noPan).toBe(0.2);
    expect(law.rates.pan4thChar).toBeUndefined();
    expect(law.threshold).toEqual({ perMonth: 50000 });
    expect(wholeYearOnCross("194-I(b)")).toBe(true);
  });
  it("a bare 194-I is no law at all: the two sub-sections never fold", () => {
    expect(lawOf("194-I")).toBeNull();
  });
  it("carries 194A and 194H", () => {
    expect(lawOf("194A")!.rates.standard).toBe(0.1);
    expect(lawOf("194A")!.threshold).toEqual({ aggregate: 10000 });
    expect(lawOf("194H")!.rates.standard).toBe(0.02);
    expect(lawOf("194H")!.threshold).toEqual({ aggregate: 20000 });
  });
  it("carries 194Q at 0.1% (5% without PAN) and the no-cross exception", () => {
    const law = lawOf("194Q")!;
    expect(law.rates.standard).toBe(0.001);
    expect(law.rates.noPan).toBe(0.05);
    expect(law.threshold).toEqual({ aggregate: 5000000 });
    expect(wholeYearOnCross("194Q")).toBe(false);
  });
  it("carries 194T timing-only at 10%", () => {
    expect(lawOf("194T")!.rates.standard).toBe(0.1);
  });
  it("whole-year on cross for 194C/J/I-b/A/H and 194T", () => {
    for (const s of ["194C", "194J", "194-I(b)", "194A", "194H", "194T"]) {
      expect(wholeYearOnCross(s)).toBe(true);
    }
  });
  it("206AA is higher-of-20%", () => {
    expect(lawOf("206AA")!.rates.standard).toBe(0.2);
  });
  it("unknown sections are null", () => {
    expect(lawOf("194B")).toBeNull();
  });
  it("names every section the engine needs, with the 194-I split", () => {
    expect(TDS_SECTIONS.map((s) => s.section)).toEqual([
      "194C", "194J", "194-I(a)", "194-I(b)", "194A", "194H", "194Q", "194T", "206AA",
    ]);
  });
});

describe("calendarMonths (Rule 119A(b), part of a month counts)", () => {
  it("28-Jun to 15-Aug = 3", () => {
    expect(calendarMonths("20260628", "20260815")).toBe(3);
  });
  it("10-May to 28-Jun = 2", () => {
    expect(calendarMonths("20250510", "20250628")).toBe(2);
  });
  it("16-May to 31-May = 1 (part of a month is a full month)", () => {
    expect(calendarMonths("20250516", "20250531")).toBe(1);
  });
  it("same day = 0", () => {
    expect(calendarMonths("20250516", "20250516")).toBe(0);
  });
});

describe("depositDue (Rule 30)", () => {
  it("May deduction due 7 June", () => {
    expect(depositDue("20250528")).toBe("20250607");
  });
  it("March deduction due 30 April", () => {
    expect(depositDue("20260320")).toBe("20260430");
  });
});

describe("statementDue (Rule 31A, FY 25-26)", () => {
  it("Q1 due 31 July", () => {
    expect(statementDue("Q1", "FY 25-26")).toBe("20250731");
  });
  it("Q4 due 31 May", () => {
    expect(statementDue("Q4", "FY 25-26")).toBe("20260531");
  });
});

describe("interestOn (s.201(1A))", () => {
  it("review-page worked example: 1.5% x 3 months on 5000 = 225 exactly", () => {
    expect(interestOn(0.015, 3, 5000, true)).toBe(225);
  });
  it("floors to 100 when round100 is on", () => {
    expect(interestOn(0.03, 1, 1234, true)).toBe(100);
    expect(interestOn(0.03, 1, 1234, false)).toBeCloseTo(37.02, 2);
  });
});

describe("lateFeePerDay (s.234E)", () => {
  it("is 200 per day", () => {
    expect(lateFeePerDay(5000)).toBe(200);
  });
});
