import { describe, expect, it } from "vitest";
import { buildDep3cdTemplate, parseDep3cdTemplate, EMPTY_DEP3CD_OPERATOR } from "../src/dep3cd-file.js";
import { buildWorkbook } from "../src/xlsx.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { DEFAULT_BLOCK_LISTS } from "../src/dep3cd-law.js";

const input = {
  groups: [{ name: "Block 15%", rate: 15 }, { name: "Block 40%", rate: 40 }],
  ledgers: [{ name: "Site Van", group: "Block 15%" }, { name: "Notebook PC", group: "Block 40%" }],
  blockLists: DEFAULT_BLOCK_LISTS,
};

describe("dep3cd template", () => {
  it("pre-fills unique inferences only and lists candidates otherwise", () => {
    const sheets = readWorkbook(buildDep3cdTemplate(input));
    const g = sheets.find((s) => s.name === "Groups")!;
    const cell = (r: number, c: number) => g.rows.find((x) => x.row === r)?.cells.get(c)?.value ?? null;
    expect(cell(2, 2)).toBe("5. Plant/ Machinery 15%:");
    expect(cell(3, 2)).toBeNull();
    expect(cell(3, 3)).toBe("3. Buildings 40%: / 7. Plant/ Machinery 40%:");
    expect(sheets.find((s) => s.name === "Blocks")!.state).toBe("hidden");
  });
  it("the untouched template parses to the pre-filled group map and empty overrides", () => {
    const p = parseDep3cdTemplate(buildDep3cdTemplate(input));
    expect([...p.operator.groupBlocks]).toEqual([["block 15%", "5. Plant/ Machinery 15%:"]]);
    expect(p.operator.ledgerBlocks.size).toBe(0);
    expect(p.operator.adjustments).toEqual([]);
    expect(p.blockLists?.deletions).toHaveLength(10);
  });
  it("parses a filled Adjustments row and cites row/column, never the value, on error", () => {
    const wb = buildWorkbook([{ name: "Adjustments", columns: [
      { header: "Asset ledger" }, { header: "Date (dd-mm-yyyy)" }, { header: "Voucher No" }, { header: "Action" }, { header: "Amount" }],
      rows: [["Site Van", "10-04-2025", "G-1", "Exclude", ""], ["Secret Ledger Name", "01-05-2025", "X", "Frobnicate", ""]] }]);
    expect(() => parseDep3cdTemplate(wb)).toThrow(/Adjustments row 3, column D \(Action\)/);
    expect(() => parseDep3cdTemplate(wb)).not.toThrow(/Secret|Frobnicate/);
  });
  it("EMPTY_DEP3CD_OPERATOR is empty", () => {
    expect(EMPTY_DEP3CD_OPERATOR.adjustments).toEqual([]);
  });
});