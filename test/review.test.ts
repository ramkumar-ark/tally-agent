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

  it("reports a debtor's dormant balance on the Dr side (raw Tally master sign flipped)", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    // Fixture: Acme Traders (creditor group) carries a raw master debit balance
    // of "-41250.00" at both ends; the gateway must read it as +41250 = Dr.
    const dormant = r.findings.find((f) => f.check === "dormant_balance");
    expect(dormant).toBeDefined();
    expect(dormant?.side).toBe("Dr");
    expect(dormant?.amount).toBe(41250);
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

  it("masks nested voucher-row fields: tax ledger names and match candidates", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const wrongSide = r.findings.find((f) => f.check === "wrong_side_balance")!;
    const rows = (await s.ledgerActivity(wrongSide.id, "20250401", "20260331")) as any[];
    const tie = rows.find((row) => row.voucherNumber === "PUR/0031");
    expect(tie.partyLedgerName).toBe("Ledger 1");
    expect(tie.matchCandidates).toEqual(["PUR/0031", "PUR/[number]"]);
    expect(tie.taxBreakup.taxLedgers.map((t: any) => t.ledgerName)).toEqual(["Input CGST", "Input SGST"]);
    const json = JSON.stringify(rows);
    expect(json).not.toContain("918020045566771");
    expect(json).not.toContain("Zenith Logistics");
  });
});

describe("ledger scrutiny (M3)", () => {
  const SECRETS = ["Acme Traders", "acme traders", "Zenith Logistics", "918020045566771", "27AAAAA0000A1Z5"];

  async function scrutinyOfCreditor() {
    const d = fakeDownstream();
    const s = createSession(d, EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const wrongSide = r.findings.find((f) => f.check === "wrong_side_balance")!;
    const result = await s.ledgerScrutiny(wrongSide.id, "20250401", "20260331");
    return { d, s, result, wrongSide };
  }

  it("scrutinises the creditor behind a TB finding, fully masked", async () => {
    const { result } = await scrutinyOfCreditor();
    expect(result).toMatchObject({
      scrutinyId: "L1",
      findingId: "TB-004-1",
      ledger: "Creditor 1",
      group: "Sundry Creditors",
      role: "creditor",
      registeredForGst: true,
      opening: 41250,
      closing: 41250,
      totalDebit: 66250,
      totalCredit: 25000,
      netMovement: 41250,
      rowsScanned: 4,
      rowsDropped: 0,
    });
    expect(result.months).toHaveLength(12);
    expect(result.counts).toEqual({ critical: 0, warning: 3, review: 3 });
    expect(result.findings.map((f) => f.id)).toEqual([
      "LS-1-001-1",
      "LS-1-002-1",
      "LS-1-004-1",
      "LS-1-006-1",
      "LS-1-009-1",
      "LS-1-010-1",
    ]);
    expect(result.findings.find((f) => f.check === "ls_duplicate_reference")!.detail).toBe(
      "2 Purchase vouchers carry the same reference: PUR/0031 (16-Jan-2026, 12,500.00 Cr, Ledger 1); " +
        "PUR/[number] (20-Jan-2026, 12,500.00 Cr, Ledger 1) — the same bill may be booked twice",
    );
    expect(result.findings.find((f) => f.check === "ls_gst_rate_nonstandard")!.detail).toContain(
      "the party is registered as TaxId 1",
    );
    for (const f of result.findings) expect(f.detail).not.toMatch(/\d{6,}/);
    const json = JSON.stringify(result);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });

  it("reads opening and closing from date-bounded trial balances and fetches the ledger by its real name", async () => {
    const { d } = await scrutinyOfCreditor();
    const tbDates = d.calls.filter((c) => c.tool === "tally_trial_balance").map((c) => c.args.asOnDate);
    expect(tbDates).toEqual(["20260331", "20250331", "20260331"]);
    expect(d.calls.find((c) => c.tool === "tally_get_ledger_vouchers")?.args).toEqual({
      ledgerName: "acme traders",
      fromDate: "20250401",
      toDate: "20260331",
    });
    expect(d.calls.some((c) => c.tool === "tally_get_ledgers" && c.args.verbose === true)).toBe(true);
  });

  it("rejects malformed or inverted dates and unknown finding ids", async () => {
    const { s, wrongSide } = await scrutinyOfCreditor();
    for (const [from, to] of [
      ["2025-04-01", "20260331"],
      ["20260331", "20250401"],
    ]) {
      await expect(s.ledgerScrutiny(wrongSide.id, from, to)).rejects.toThrow(
        "fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate",
      );
    }
    await expect(s.ledgerScrutiny("TB-999-1", "20250401", "20260331")).rejects.toThrow(
      "unknown finding id: TB-999-1",
    );
  });

  it("keeps one scrutiny sequence per ledger and registers LS ids for drill-down", async () => {
    const { d, s, result } = await scrutinyOfCreditor();
    // Re-scrutiny by an LS id, over another period, reuses the ledger's sequence.
    const again = await s.ledgerScrutiny("LS-1-004-1", "20260101", "20260131");
    expect(again.scrutinyId).toBe("L1");
    expect(again.months.map((m) => m.month)).toEqual(["2026-01"]);
    // tb_ledger_activity accepts LS ids too.
    await s.ledgerActivity(result.findings[0].id, "20250401", "20260331");
    const ledgerCalls = d.calls.filter((c) => c.tool === "tally_get_ledger_vouchers");
    expect(ledgerCalls).toHaveLength(3);
    expect(ledgerCalls.every((c) => c.args.ledgerName === "acme traders")).toBe(true);
    // A different ledger gets the next sequence.
    const r = await s.review(undefined, "20260331");
    const rent = r.findings.find((f) => f.ledger === "rent")!;
    expect((await s.ledgerScrutiny(rent.id, "20250401", "20260331")).scrutinyId).toBe("L2");
  });
});

describe("ledger in wrong group", () => {
  it("reports the expense ledger under Capital Account by pseudonym, with no fragment of its name", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const f = r.findings.find((x) => x.check === "ledger_in_wrong_group" && x.group === "Capital Account")!;
    expect(f).toMatchObject({
      id: "TB-008-1",
      severity: "warning",
      ledger: "Capital 1",
      amount: 18000,
      side: "Dr",
      expected: "expense",
    });
    expect(f.detail).toBe(
      "Capital 1 reads as an expense ledger but is grouped under Capital Account, " +
        "with a Dr balance of 18,000.00 as of 31-Mar-2026; as placed, it is kept out of the profit and loss account. " +
        "Move it under Direct Expenses, Indirect Expenses or Purchase Accounts, " +
        "or under a Drawings sub-group of Capital Account if it is an owner's personal spending. " +
        "If the placement is deliberate, list it in wrongGroup.ignoreLedgers in config/overrides.json",
    );
    expect(JSON.stringify(r)).not.toMatch(/orchid|medical/i);
  });

  it("reports a party ledger under a purchase group in the clear, as every ledger there already is", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const f = r.findings.find((x) => x.check === "ledger_in_wrong_group" && x.group === "Domestic Purchases");
    expect(f).toMatchObject({ id: "TB-008-2", ledger: "nimbus enterprises", side: "Dr", expected: "asset" });
  });

  it("stays silent for personal spending under the Drawings sub-group", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const groups = r.findings.filter((x) => x.check === "ledger_in_wrong_group").map((x) => x.group);
    expect(groups).toEqual(["Capital Account", "Domestic Purchases"]);
  });

  it("drills into a wrong-group finding by id, reaching the real ledger", async () => {
    const d = fakeDownstream();
    const s = createSession(d, EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const f = r.findings.find((x) => x.check === "ledger_in_wrong_group" && x.group === "Capital Account")!;
    await s.ledgerActivity(f.id, "20250401", "20260331");
    expect(d.calls.find((c) => c.tool === "tally_get_ledger_vouchers")?.args.ledgerName).toBe(
      "orchid medical expenses",
    );
  });

  it("passes the operator's wrongGroup tuning through to the check", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES, {
      ignoreLedgers: ["Orchid Medical Expenses"],
      keywords: { neutral: ["enterprises"] },
    });
    const r = await s.review(undefined, "20260331");
    expect(r.findings.filter((x) => x.check === "ledger_in_wrong_group")).toEqual([]);
  });

  it("masks a party-named ledger in a clear group once the operator lists it in forceMaskLedgers", async () => {
    const s = createSession(fakeDownstream(), { ...EMPTY_OVERRIDES, forceMaskLedgers: ["Nimbus Enterprises"] });
    const r = await s.review(undefined, "20260331");
    const f = r.findings.find((x) => x.id === "TB-008-2")!;
    expect(f.ledger).toMatch(/^Ledger \d+$/);
    expect(JSON.stringify(r)).not.toMatch(/nimbus/i);
  });
});
