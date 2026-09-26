import { describe, expect, it } from "vitest";
import { analyzeDep3cd, resolveBlock } from "../src/dep3cd.js";
import { D3_VOUCHERS, D3_EXPECTED_ADDITIONS, fixtureCtx } from "./fixtures/dep3cd-fixture.js";

describe("dep3cd blocks", () => {
  it("unique rate infers; 10% and 40% are ambiguous", () => {
    const ctx = fixtureCtx();
    expect(resolveBlock("Site Van", "additions", ctx).block).toBe("5. Plant/ Machinery 15%:");
    expect(resolveBlock("Notebook PC", "additions", ctx)).toMatchObject({ block: null, candidates: ["3. Buildings 40%:", "7. Plant/ Machinery 40%:"] });
    expect(resolveBlock("Desk Set", "additions", ctx).candidates).toHaveLength(2);
  });
  it("group mapping beats inference; ledger override beats group", () => {
    const ctx = fixtureCtx({ operator: { adjustments: [],
      groupBlocks: new Map([["block 40%", "7. Plant/ Machinery 40%:"]]),
      ledgerBlocks: new Map([["desk set", "4. Furnitures/ fittings 10%:"]]) } });
    expect(resolveBlock("Notebook PC", "additions", ctx)).toMatchObject({ block: "7. Plant/ Machinery 40%:", source: "group" });
    expect(resolveBlock("Desk Set", "additions", ctx)).toMatchObject({ block: "4. Furnitures/ fittings 10%:", source: "ledger" });
  });
  it("45% is valid only for deletions", () => {
    const ctx = fixtureCtx({ operator: { adjustments: [], groupBlocks: new Map(), ledgerBlocks: new Map([["site van", "8. Plant/ Machinery 45%:"]]) } });
    expect(resolveBlock("Site Van", "additions", ctx).block).toBeNull();
    expect(resolveBlock("Site Van", "deletions", ctx).block).toBe("8. Plant/ Machinery 45%:");
  });
  it("analyzeDep3cd: expected rows, unmapped ledgers critical, ids stable", () => {
    const r = analyzeDep3cd(D3_VOUCHERS, fixtureCtx());
    expect(r.additions.map(({ ledger, block, purchaseDate, amount }) => ({ ledger, block, purchaseDate, amount })))
      .toEqual(D3_EXPECTED_ADDITIONS);
    const unmapped = r.findings.filter((f) => f.check === "d3cd_block_unmapped");
    expect(unmapped.map((f) => f.ledger).sort()).toEqual(["Desk Set", "Notebook PC"]);
    expect(unmapped.every((f) => f.severity === "critical" && /^D3CD-001-\d+$/.test(f.id))).toBe(true);
  });
});