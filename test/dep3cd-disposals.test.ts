import { describe, expect, it } from "vitest";
import { classifyMovements, buildDisposals } from "../src/dep3cd.js";
import { D3_VOUCHERS, D3_EXPECTED_DELETIONS, fixtureCtx } from "./fixtures/dep3cd-fixture.js";

describe("dep3cd disposals", () => {
  const ctx = fixtureCtx();
  const moves = classifyMovements(D3_VOUCHERS, ctx);
  const { deletions, findings } = buildDisposals(moves, D3_VOUCHERS, ctx);

  it("one row per sold asset at the consideration received", () => {
    expect(deletions.map(({ ledger, date, amount, basis }) => ({ ledger, date, amount, basis })))
      .toEqual(D3_EXPECTED_DELETIONS.map(({ ledger, date, amount, basis }) => ({ ledger, date, amount, basis })));
  });
  it("GST on the sale invoice is not consideration; the loss journal is ignored", () => {
    expect(deletions.find((d) => d.ledger === "Pump Set")!.amount).toBe(200000);
  });
  it("receipt basis uses the money line, not the asset credit", () => {
    const t = deletions.find((d) => d.ledger === "Old Tractor")!;
    expect(t.amount).toBe(300000);
    expect(t.bookCredit).toBe(250000);
  });
  it("defaults HALFADD No, DEPN No", () => {
    for (const d of deletions) expect([d.halfAdd, d.depn]).toEqual(["No", "No"]);
  });
  it("disposal ledger reconciles (no D3CD-005/006)", () => {
    expect(findings.filter((f) => /disposal_/.test(f.check))).toEqual([]);
  });
  it("a sale booked in the disposal ledger but never relieved from an asset is critical", () => {
    const noJournal = D3_VOUCHERS.filter((v) => v.voucherNumber !== "J-2");
    const r = buildDisposals(classifyMovements(noJournal, ctx), noJournal, ctx);
    expect(r.findings.some((f) => f.check === "d3cd_disposal_unmatched" && f.severity === "critical")).toBe(true);
  });
  it("one receipt across two assets is apportioned pro rata and flagged", () => {
    const two = [
      ...D3_VOUCHERS.filter((v) => v.voucherNumber !== "R-1"),
      {
        date: "20251215", voucherType: "Receipt", voucherNumber: "R-2", partyLedgerName: "", cancelled: false,
        entries: [
          { ledger: "Main Bank", amount: 300000 },
          { ledger: "Old Tractor", amount: -150000 },
          { ledger: "Pump Set", amount: -50000 },
          { ledger: "Profit on Sale of Fixed Asset", amount: -100000 },
        ],
      },
    ];
    const r = buildDisposals(classifyMovements(two, ctx), two, ctx);
    expect(r.deletions.find((d) => d.voucherNumber === "R-2" && d.ledger === "Old Tractor")!.amount).toBe(225000);
    expect(r.deletions.find((d) => d.voucherNumber === "R-2" && d.ledger === "Pump Set")!.amount).toBe(75000);
    expect(r.findings.some((f) => f.check === "d3cd_consideration_apportioned")).toBe(true);
  });
});