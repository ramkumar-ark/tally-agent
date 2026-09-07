import { describe, expect, it } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";

describe("review", () => {
  it("returns findings for the fixture company", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review("Demo Traders Pvt Ltd", "20260331");
    expect(r.balanced).toBe(false);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.counts.critical).toBeGreaterThan(0);
  });

  it("masks the creditor but not its group", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const wrongSide = r.findings.find((f) => f.check === "wrong_side_balance");
    expect(wrongSide?.ledger).toMatch(/^Creditor \d+$/);
    expect(wrongSide?.group).toBe("Sundry Creditors");
  });

  it("never leaks the bank account number in any finding", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    expect(JSON.stringify(r)).not.toContain("50200012345678");
  });

  it("leaves a nominal ledger readable", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const suspense = r.findings.find((f) => f.check === "suspense_balance");
    expect(suspense?.ledger).toBe("suspense");
  });

  it("fetches the trial balance once per review", async () => {
    const d = fakeDownstream();
    const s = createSession(d, EMPTY_OVERRIDES);
    await s.review(undefined, "20260331");
    expect(d.calls.filter((c) => c.tool === "tally_trial_balance")).toHaveLength(1);
  });

  it("resolves a finding id back to the real ledger when drilling in", async () => {
    const d = fakeDownstream();
    const s = createSession(d, EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const wrongSide = r.findings.find((f) => f.check === "wrong_side_balance")!;
    await s.ledgerActivity(wrongSide.id, "20250401", "20260331");
    const call = d.calls.find((c) => c.tool === "tally_get_ledger_vouchers");
    expect(call?.args.ledgerName).toBe("acme traders");
  });

  it("rejects an unknown finding id", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    await s.review(undefined, "20260331");
    await expect(s.ledgerActivity("TB-999-1", "20250401", "20260331")).rejects.toThrow(
      /unknown finding/i,
    );
  });
});
