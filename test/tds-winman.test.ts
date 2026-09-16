import { describe, expect, it } from "vitest";
import { buildWorkbook } from "../src/xlsx.js";
import { parseWinmanExport, winmanSectionKey } from "../src/tds-file.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { buildWinmanFixture } from "./fixtures/winman-test-fixture.js";

const TAN = "MUMA 04826 B"; // the fixture's planted (invented) TAN

function message(fn: () => unknown): string {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("winmanSectionKey — §8.2's no-guess normalisation", () => {
  it("maps the Deduction sheet's verbose split labels", () => {
    expect(winmanSectionKey("194I(a) - Plant / Machinery rent")).toBe("194-I(a)");
    expect(winmanSectionKey("194I(b) - Land / Building rent")).toBe("194-I(b)");
  });

  it("maps the rest straight onto the law table", () => {
    expect(winmanSectionKey("194J - Fees / Royalty (Others)")).toBe("194J");
    expect(winmanSectionKey("194C - Works Contract")).toBe("194C");
    expect(winmanSectionKey("194Q - Purchase of Goods")).toBe("194Q");
    expect(winmanSectionKey("194H - Commission / Brokerage")).toBe("194H");
    expect(winmanSectionKey("194A - Interest Other Than Securities")).toBe("194A");
  });

  it("never folds the Challan sheet's bare 194I", () => {
    expect(winmanSectionKey("194I - Rent")).toBeNull();
    expect(winmanSectionKey("194I")).toBeNull();
  });

  it("treats an unknown or blank label as no key", () => {
    expect(winmanSectionKey("MUMA04826B - whatever")).toBeNull();
    expect(winmanSectionKey("")).toBeNull();
    expect(winmanSectionKey(null)).toBeNull();
  });
});

describe("parseWinmanExport over the committed-layout fixture", () => {
  const facts = parseWinmanExport(buildWinmanFixture());

  it("derives one challan per (split section, month) from the Deduction allocation", () => {
    expect(facts.challans).toEqual([
      { section: "194-I(a)", forMonth: "2025-05", depositDate: "20250716" },
      { section: "194-I(a)", forMonth: "2025-06", depositDate: "20250716" },
      { section: "194-I(b)", forMonth: "2025-06", depositDate: "20250716" },
      { section: "194C", forMonth: "2025-12", depositDate: "20260118" },
      { section: "194J", forMonth: "2026-02", depositDate: "20260214" },
    ]);
  });

  it("picks up the deductee list with compacted PANs, blanks tolerated", () => {
    expect(facts.deductees).toEqual([
      { name: "Sample Concrete Works ( proprietorship)", pan: "AABBX1111C" },
      { name: "Sample Movers", pan: "CCBMX2222D" },
      { name: "Sample Iron Works", pan: null },
    ]);
  });

  it("reads the meta row's Form only", () => {
    expect(facts.formType).toBe("26Q");
  });

  it("counts — never guesses — the bare-194I and join-miss rows", () => {
    expect(facts.skipped).toEqual({ noSection: 2, noJoin: 1 });
  });

  it("never surfaces the Deductor TAN, even as a string fragment of the result", () => {
    expect(JSON.stringify(facts)).not.toContain("04826");
    expect(JSON.stringify(facts)).not.toContain(TAN);
  });

  it("skips the veryHidden List decoy by state, not by name", () => {
    // The hidden sheet owns no joined data; if the parse read it, the counts
    // above would be corrupted with the decoy rows. Assert the state came
    // through flagged, as the reader's own contract states.
    const sheets = readWorkbook(buildWinmanFixture());
    expect(sheets.find((s) => s.name === "List")?.state).toBe("veryHidden");
  });

  it("errors naming the sheets it found when a required sheet is missing", () => {
    const msg = message(() =>
      parseWinmanExport(buildWorkbook([{ name: "List", columns: [{ header: "n" }], rows: [[4]] }])),
    );
    expect(msg).toMatch(/template sheet missing: the Winman export must carry a Deductee sheet/);
    expect(msg).toContain("this file has: List");
  });
});
