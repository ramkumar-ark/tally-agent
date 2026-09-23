import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { EMPTY_AS26_MAP, loadAs26Map, matchParties, type BooksFacts } from "../src/as26.js";
import { parseAs26Export } from "../src/as26-file.js";
import { buildAs26Fixture } from "./as26-fixture.js";
import { canonicalKey } from "../src/key.js";

const dirs: string[] = [];
const mapFile = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "as26-")); dirs.push(dir);
  const p = join(dir, "as26-map.json"); writeFileSync(p, text, "utf8"); return p;
};
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("loadAs26Map", () => {
  it("missing file degrades to empty with a warning", () => {
    const warns: string[] = [];
    expect(loadAs26Map("/nonexistent/as26-map.json", (w) => warns.push(w))).toEqual(EMPTY_AS26_MAP);
    expect(warns).toHaveLength(1);
  });
  it("malformed JSON throws", () => {
    expect(() => loadAs26Map(mapFile("{"))).toThrow(/as26-map/);
  });
  it("duplicate ledger or as26Name keys throw citing the entry index, never a value", () => {
    const dup = JSON.stringify({ mappings: [
      { ledger: "Alpha Traders", as26Name: "Alpha Traders" },
      { ledger: "Alpha Traders", as26Name: "Beta Traders" },
    ]});
    expect(() => loadAs26Map(mapFile(dup))).toThrow(/as26-map entry 2/);
  });
  it("blank fields throw citing the entry index", () => {
    const blank = JSON.stringify({ mappings: [{ ledger: "  ", as26Name: "X" }] });
    expect(() => loadAs26Map(mapFile(blank))).toThrow(/as26-map entry 1/);
  });
});

const ledgers = ["Nagar Palika Nagar Bhavan", "Anand Buildmart Pvt Ltd", "Kaveri Minerals Trading", "Orphan Debtors"];
const facts = (keys: string[]): BooksFacts => ({
  deductions: keys.map((k) => ({ ledgerKey: canonicalKey(k), kind: "tds" as const, date: "20250612", tax: 5000, voucherType: "Journal" })),
  sales: [],
});

describe("matchParties — mapping-only", () => {
  const file = parseAs26Export(buildAs26Fixture());
  it("operator map joins exactly; everything else surfaces as gaps", () => {
    const map = { mappings: [{ ledger: "Nagar Palika Nagar Bhavan", as26Name: "Nagar Palika Nagar Bhavan" }] };
    const { matches, gaps } = matchParties(file, facts(ledgers), map, ledgers);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ ledgerName: "Nagar Palika Nagar Bhavan", source: "operator", kind: "tds" });
    // unmapped deductors + unmapped ledgers with deductions
    const reasons = gaps.map((g) => g.reason);
    expect(reasons.filter((r) => r === "unmapped").length).toBeGreaterThanOrEqual(4);
  });
  it("stale/absent mappings become gaps, never throws", () => {
    const map = { mappings: [
      { ledger: "No Such Ledger", as26Name: "Nagar Palika Nagar Bhavan" },
      { ledger: "Orphan Debtors", as26Name: "No Such Deductor" },
    ]};
    const { matches, gaps } = matchParties(file, facts(ledgers), map, ledgers);
    expect(matches).toHaveLength(0);
    expect(gaps.map((g) => g.reason).sort()).toEqual(
      ["ledger-absent", "name-absent",
       "unmapped", "unmapped", "unmapped", // 3 unmapped deductors
       "unmapped", "unmapped", "unmapped", "unmapped"].sort()); // 4 ledgers with deductions, none matched
  });
  it("an unmapped deductor gap carries the 26AS tax at stake", () => {
    const { gaps } = matchParties(file, facts([]), { mappings: [] }, ledgers);
    const g = gaps.find((x) => x.name === "Nagar Palika Nagar Bhavan")!;
    expect(g.reason).toBe("unmapped");
    expect(g.tax).toBe(18000);
  });
});
