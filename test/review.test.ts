import { describe, expect, it } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";

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

  const MASTERS = JSON.stringify([
    { name: "Sample Builders LLP", parent: "Sundry Creditors", state: "Karnataka", IncomeTaxNumber: "ABCC1234A", IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
    { name: "Site Repairs Contract", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
    { name: "TDS Contractors", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  ]);

describe("tdsReview", () => {
  const mkSession = (
    ledgerVouchersByLedger: Record<string, unknown>,
    callsOut: Array<{ ledger: string; from: string; to: string }> = [],
  ) => {
    const s = createSession(
      Object.assign(fakeDownstream({ tally_get_ledgers: MASTERS }), {
        ledgerVoucherRows: async (_c: any, ledgerName: string, _f: string, _t: string) => {
          const body = ledgerVouchersByLedger[String(ledgerName).toLowerCase()] ?? { source: "ledger-vouchers-report", vouchers: [] };
          const row = (v: any) => ({
            date: String(v.date).replace(/[-/\.\s]/g, ""),
            voucherType: String(v.voucherType ?? ""),
            voucherNumber: String(v.voucherNumber ?? ""),
            reference: "",
            counterparty: String(v.counterLedgerName ?? v.partyLedgerName ?? "").trim(),
            amount:
              typeof v.amount === "number"
                ? v.amount
                : Number(String(v.amount ?? "0").replace(/,/g, "")),
            matchStatus: "matched" as const,
            tax: null,
          });
          const rows = body.vouchers
            .map(row)
            .filter((r: any) => r.date >= _f && r.date <= _t);
          return { rows, dropped: 0 } as never;
        },
      } as never),
      EMPTY_OVERRIDES,
      EMPTY_WRONG_GROUP,
    );
    return s;
  };

  const OPERATOR: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: "Site Repairs Contract", section: "194C" },
      { ledger: "TDS Contractors", section: "194C" },
    ],
    parties: [
      { ledger: "Sample Builders LLP", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
    ],
  };

  it("runs the engine over the month-chunked book and masks the deductee", async () => {
    const s = mkSession({
      "site repairs contract": {
        source: "ledger-vouchers-report",
        vouchers: [{ date: "2025-05-10", voucherType: "Purchase", voucherNumber: "P/12", amount: "-250000.00", partyLedgerName: "Sample Builders LLP" }],
      },
      "sample builders llp": { source: "ledger-vouchers-report", vouchers: [] },
      "tds contractors": { source: "ledger-vouchers-report", vouchers: [] },
    });
    const r = await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    const f = r.findings.find((x) => x.check === "tds_not_deducted");
    console.log("TDSREVIEW", JSON.stringify(r.findings), JSON.stringify(r.totals), r.ledgerCalls);
    expect(f).toBeDefined();
    expect(f!.deductee).toMatch(/^(Creditor|Ledger|Party|Debtor) \d+$/); // a pseudonym, never the real deductee
    expect(r.totals.notDeducted).toBe(5000);
    expect(r.ledgerCalls).toBeGreaterThan(0);
    // Drill-down works by finding id: the session resolves the real ledger.
    const rows = (await s.ledgerActivity(f!.id, "20250401", "20260331")) as any[];
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rejects a bad date shape", async () => {
    const s = mkSession({});
    await expect(
      s.tdsReview(undefined, "2025-04-01", "20260331", "20260331", OPERATOR, "json"),
    ).rejects.toThrow(/YYYYMMDD/);
  });

  it("merges the Winman challans into the operator file's (§8.4)", async () => {
    const s = mkSession({});
    const r = await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "template", {
      challans: [
        { section: "194C", forMonth: "2025-05", depositDate: "20250616" },
        { section: "194Q", forMonth: "2025-06", depositDate: "20250718" },
      ],
      deductees: [{ name: "Sample Builders (Unit 2)", pan: "ABCCS1234A" }],
      formType: "26Q",
      skipped: { noSection: 0, noJoin: 0 },
    });
    expect(r.winman).toEqual({ used: true, challans: 2, deductees: 1, panAdopted: 0 });
    expect(r.operatorSource).toBe("template");
  });

  it("dedupes a Winman challan that equals the operator file's", async () => {
    const s = mkSession({});
    const withChallan = {
      ...OPERATOR,
      challans: [{ section: "194C", forMonth: "2025-05", depositDate: "20250616" }],
    };
    const r = await s.tdsReview(undefined, "20250401", "20260331", "20260331", withChallan, "template", {
      challans: [{ section: "194C", forMonth: "2025-05", depositDate: "20250616" }],
      deductees: [],
      formType: null,
      skipped: { noSection: 0, noJoin: 0 },
    });
    expect(r.totals).toBeDefined();
  });

  it("hard-errors when operator and Winman disagree on a deposit date, naming section and month only", async () => {
    const s = mkSession({});
    const withChallan = {
      ...OPERATOR,
      challans: [{ section: "194C", forMonth: "2025-05", depositDate: "20250601" }],
    };
    await expect(
      s.tdsReview(undefined, "20250401", "20260331", "20260331", withChallan, "template", {
        challans: [{ section: "194C", forMonth: "2025-05", depositDate: "20250616" }],
        deductees: [],
        formType: null,
        skipped: { noSection: 0, noJoin: 0 },
      }),
    ).rejects.toThrow(/disagree on 194C 2025-05/);
  });

  it("adopts a Winman PAN through the declared join, as a TaxId pseudonym and never the PAN", async () => {
    const s = mkSession({});
    const result = await s.tdsReview(undefined, "20250401", "20260331", "20260331", {
      ...OPERATOR,
      parties: [
        { ledger: "Sample Builders LLP", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false, winmanName: "Sample Builders (Unit 2)" },
      ],
    }, "template", {
      challans: [],
      deductees: [{ name: "Sample Builders (Unit 2)", pan: "ABCCS1234A" }],
      formType: null,
      skipped: { noSection: 0, noJoin: 0 },
    });
    expect(result.winman.panAdopted).toBe(1);
    expect(JSON.stringify(result)).not.toContain("ABCCS1234A");
  });

  it("errors citing the Parties row when the template PAN disagrees with the Winman PAN", async () => {
    const s = mkSession({});
    await expect(
      s.tdsReview(undefined, "20250401", "20260331", "20260331", {
        ...OPERATOR,
        parties: [
          { ledger: "Sample Builders LLP", tdsApplicable: true, pan: "ABCDX9999X", panRow: 2, transporterDeclaration: false, deducteeFiledReturn: false, winmanName: "Sample Builders (Unit 2)" },
        ],
      }, "template", {
        challans: [],
        deductees: [{ name: "Sample Builders (Unit 2)", pan: "ABCCS1234A" }],
        formType: null,
        skipped: { noSection: 0, noJoin: 0 },
      }),
    ).rejects.toThrow(/template Parties row 2, column C \(PAN\)/);
  });
});

/**
 * Depreciation two-pass fixture. Two asset ledgers under Block 15%. "Quiet
 * Plant" moves by exactly its own depreciation charge, so the two-pass
 * residual nets to nil and pass 2 should skip it. "Busy Plant" does not, so
 * it must be fetched.
 */
function depFixture(calls: string[], ranges: Array<[string, string]> = []) {
  return createSession(
    Object.assign(fakeDownstream(), {
      groups: async () => [
        { name: "Fixed Assets", parent: " Primary" },
        { name: "Block 15%", parent: "Fixed Assets" },
        { name: "Indirect Expenses", parent: " Primary" },
      ],
      trialBalance: async (_c: unknown, asOn: string) => ({
        totalDebit: 0, totalCredit: 0,
        rows: asOn === "20250331"
          ? [
              { name: "Quiet Plant", parent: "Block 15%", balance: 100000 },
              { name: "Busy Plant", parent: "Block 15%", balance: 100000 },
              { name: "Depreciation A/c", parent: "Indirect Expenses", balance: 0 },
            ]
          : [
              { name: "Quiet Plant", parent: "Block 15%", balance: 85000 },
              { name: "Busy Plant", parent: "Block 15%", balance: 500000 },
              { name: "Depreciation A/c", parent: "Indirect Expenses", balance: 15000 },
            ],
      }),
      ledgerVoucherRows: async (_c: unknown, ledger: string, from: string, to: string) => {
        calls.push(ledger);
        ranges.push([from, to]);
        if (ledger !== "Depreciation A/c" || from > "20260303" || to < "20260303") {
          return { rows: [], dropped: 0 };
        }
        return {
          rows: [{
            date: "20260303", voucherType: "Jrnl", voucherNumber: "1", reference: "",
            counterparty: "Quiet Plant", amount: 15000, matchStatus: "matched", tax: null,
          }],
          dropped: 0,
        };
      },
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );
}

describe("depreciationReview two-pass fetch", () => {
  it("skips a voucher fetch for an asset ledger whose movement is the depreciation charge", async () => {
    const calls: string[] = [];
    await depFixture(calls).depreciationReview(undefined, "20250401", "20260331", null);
    expect(calls).toContain("Busy Plant");
    expect(calls).not.toContain("Quiet Plant");
  });

  it("fetches every asset ledger when TALLY_AGENT_DEP_FETCH_ALL is set", async () => {
    process.env.TALLY_AGENT_DEP_FETCH_ALL = "1";
    try {
      const calls: string[] = [];
      await depFixture(calls).depreciationReview(undefined, "20250401", "20260331", null);
      expect(calls).toContain("Quiet Plant");
    } finally {
      delete process.env.TALLY_AGENT_DEP_FETCH_ALL;
    }
  });

  it("month-chunks every fetch rather than asking for the whole year at once", async () => {
    const ranges: Array<[string, string]> = [];
    await depFixture([], ranges).depreciationReview(undefined, "20250401", "20260331", null);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(([f, t]) => f.slice(0, 6) === t.slice(0, 6))).toBe(true);
  });

  it("masks asset ledgers as Ledger N, never in clear", async () => {
    const result = await depFixture([]).depreciationReview(undefined, "20250401", "20260331", null);
    const text = JSON.stringify(result);
    expect(text).not.toContain("Busy Plant");
    expect(text).not.toContain("Quiet Plant");
    expect(text).toMatch(/Ledger \d+/);
  });
});
