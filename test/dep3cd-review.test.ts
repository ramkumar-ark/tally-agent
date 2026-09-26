import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { D3_GROUPS, D3_LEDGERS, D3_VOUCHERS, writeD3Bundle } from "./fixtures/dep3cd-fixture.js";

describe("Session.dep3cdReview", () => {
  it("masks ledgers, shows block text clear, caches raw rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d3-"));
    const session = createSession(fakeDownstream({}), EMPTY_OVERRIDES);
    const r = await session.dep3cdReview({ company: "Demo Co", fromDate: "20250401", toDate: "20260331", dayBookPath: writeD3Bundle(dir) });
    const text = JSON.stringify(r);
    for (const real of ["Mixer Unit", "Site Van", "Store Box", "Pump Set", "Old Tractor", "Buyer One"]) expect(text).not.toContain(real);
    expect(r.additions.some((a) => a.block === "5. Plant/ Machinery 15%:" && a.purchaseDate === "10-Apr-2025" && a.amount === 535000)).toBe(true);
    expect(r.totals.unwrittenAdditions).toBe(2);
    expect(r.blockSource).toBe("default");
    expect(text).not.toMatch(/\d{8}/);
    expect(session.dep3cdRows()!.additions.some((a) => a.ledger === "Site Van")).toBe(true);
  });
  it("a day book without masters yields D3CD-013 and no rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d3-"));
    const session = createSession(fakeDownstream({}), EMPTY_OVERRIDES);
    const r = await session.dep3cdReview({ fromDate: "20250401", toDate: "20260331", dayBookPath: writeD3Bundle(dir, { masters: false }) });
    expect(r.findings.map((f) => f.check)).toEqual(["d3cd_masters_absent"]);
    expect(r.additions).toEqual([]);
  });
});