import { describe, expect, it } from "vitest";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { scrutinize, type ScrutinyInput } from "../src/scrutiny.js";

const row = (o: Partial<LedgerVoucherRow> = {}): LedgerVoucherRow => ({
  date: "20260110",
  voucherType: "Payment",
  voucherNumber: "P/1",
  reference: "",
  counterparty: "HDFC Bank",
  amount: -1000,
  matchStatus: "matched",
  tax: null,
  ...o,
});

const input = (o: Partial<ScrutinyInput> = {}): ScrutinyInput => ({
  ledger: "Acme Traders",
  group: "Sundry Creditors",
  role: "creditor",
  gstin: null,
  ledgerSeq: 1,
  fromDate: "20260101",
  toDate: "20260331",
  opening: 0,
  closing: 0,
  rows: [],
  ...o,
});

const only = (i: ScrutinyInput, check: string) =>
  scrutinize(i).findings.filter((f) => f.check === check);

describe("scrutinize: period view and balance anomalies", () => {
  it("builds the period view with every month, zero months included, and finds nothing on a clean ledger", () => {
    const r = scrutinize(
      input({
        opening: -5000,
        closing: -5600,
        rows: [
          row({ date: "20260205", voucherType: "Receipt", voucherNumber: "R/1", amount: 400 }),
          row({ date: "20260110", amount: -1000 }),
        ],
      }),
    );
    expect(r.view).toMatchObject({
      opening: -5000,
      closing: -5600,
      totalDebit: 400,
      totalCredit: 1000,
      netMovement: -600,
      rowsScanned: 2,
    });
    expect(r.view.months).toEqual([
      { month: "2026-01", debit: 0, credit: 1000, net: -1000, entries: 1 },
      { month: "2026-02", debit: 400, credit: 0, net: 400, entries: 1 },
      { month: "2026-03", debit: 0, credit: 0, net: 0, entries: 0 },
    ]);
    expect(r.findings).toEqual([]);
  });

  it("flags an opening-to-closing mismatch beyond tolerance, in display formats", () => {
    const rows = [row({ amount: -1000 }), row({ date: "20260205", voucherNumber: "R/1", amount: 400 })];
    const [f] = only(input({ opening: -5000, closing: -5000, rows }), "ls_opening_closing_mismatch");
    expect(f).toMatchObject({ id: "LS-1-001-1", severity: "warning", amount: 600, side: null, expected: null });
    expect(f.detail).toContain("brought forward on 31-Dec-2025 (5,000.00 Cr)");
    expect(f.detail).toContain("reaches 5,600.00 Cr");
    expect(f.detail).toContain("a difference of 600.00");
    expect(f.detail).not.toMatch(/\d{6,}/);
    expect(only(input({ opening: -5000, closing: -5600.04, rows }), "ls_opening_closing_mismatch")).toEqual([]);
  });

  it("tracks the end-of-day running balance and flags days on the wrong side", () => {
    const [f] = only(
      input({
        closing: -3000,
        rows: [
          row({ date: "20260110", voucherType: "Journal", voucherNumber: "J/1", amount: 3000 }),
          row({ date: "20260110", voucherNumber: "P/2", amount: -1000 }),
          row({ date: "20260120", voucherNumber: "P/3", amount: -5000 }),
        ],
      }),
      "ls_wrong_side_during_period",
    );
    expect(f).toMatchObject({ id: "LS-1-002-1", severity: "warning", amount: 2000, side: "Dr", expected: "Cr" });
    expect(f.detail).toContain("1 of 2 posting days");
    expect(f.detail).toContain("first on 10-Jan-2026");
    expect(f.detail).toContain("peaking at 2,000.00");
  });

  it("nets same-day entries before judging the side, and never judges a bank ledger", () => {
    expect(
      only(
        input({
          group: "Cash-in-Hand",
          role: "cash",
          opening: 500,
          closing: 300,
          rows: [row({ date: "20260115", amount: -800 }), row({ date: "20260115", voucherNumber: "R/1", amount: 600 })],
        }),
        "ls_wrong_side_during_period",
      ),
    ).toEqual([]);
    expect(
      only(
        input({ group: "Bank Accounts", role: "bank", opening: 100, closing: -900, rows: [row({ amount: -1000 })] }),
        "ls_wrong_side_during_period",
      ),
    ).toEqual([]);
  });

  it("rates a cash ledger in credit as critical", () => {
    const [f] = only(
      input({ group: "Cash-in-Hand", role: "cash", opening: 100, closing: -200, rows: [row({ date: "20260115", amount: -300 })] }),
      "ls_wrong_side_during_period",
    );
    expect(f).toMatchObject({ severity: "critical", amount: 200, side: "Cr", expected: "Dr" });
  });
});

describe("scrutinize: voucher-level checks", () => {
  it("flags the same date, type, counterparty and amount booked twice", () => {
    const [f, ...rest] = only(
      input({
        rows: [
          row({ date: "20260115", voucherType: "Purchase", voucherNumber: "PUR/1", counterparty: "Zenith  Logistics", amount: -12500 }),
          row({ date: "20260115", voucherType: "purchase", voucherNumber: "PUR/2", counterparty: "zenith logistics", amount: -12500 }),
          row({ date: "20260115", voucherType: "Purchase", voucherNumber: "PUR/3", counterparty: "Zenith Logistics", amount: -12400 }),
        ],
      }),
      "ls_duplicate_entry",
    );
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      id: "LS-1-003-1",
      severity: "warning",
      amount: 12500,
      side: "Cr",
      counterparties: ["Zenith  Logistics"],
    });
    expect(f.detail).toContain("2 Purchase entries on 15-Jan-2026");
    expect(f.detail).toContain("(PUR/1, PUR/2)");
  });

  it("reports identical rows sharing a reference once, as a duplicate entry", () => {
    const same = { date: "20260115", voucherType: "Purchase", reference: "ZL/77", counterparty: "Zenith Logistics", amount: -12500 };
    const i = input({ rows: [row({ ...same, voucherNumber: "PUR/1" }), row({ ...same, voucherNumber: "PUR/2" })] });
    expect(only(i, "ls_duplicate_entry")).toHaveLength(1);
    expect(only(i, "ls_duplicate_reference")).toEqual([]);
  });

  it("flags one bill reference on two distinct vouchers of a type", () => {
    const [f] = only(
      input({
        rows: [
          row({ date: "20260116", voucherType: "Purchase", voucherNumber: "PUR/0031", reference: "ZL/77", counterparty: "Zenith Logistics", amount: -12500 }),
          row({ date: "20260120", voucherType: "Purchase", voucherNumber: "PUR/0044", reference: " zl/77 ", counterparty: "Zenith Logistics", amount: -12500 }),
        ],
      }),
      "ls_duplicate_reference",
    );
    expect(f).toMatchObject({ id: "LS-1-004-1", severity: "warning", amount: 25000, counterparties: ["Zenith Logistics"] });
    expect(f.detail).toContain("PUR/0031 (16-Jan-2026, 12,500.00 Cr, Zenith Logistics)");
    expect(f.detail).toContain("the same bill may be booked twice");
  });

  it("does not flag a re-listed voucher or a reference shared across voucher types", () => {
    expect(
      only(
        input({
          rows: [
            row({ date: "20260116", voucherType: "Purchase", voucherNumber: "PUR/0031", reference: "ZL/77", amount: -12500 }),
            row({ date: "20260117", voucherType: "Purchase", voucherNumber: "PUR/0031", reference: "ZL/77", amount: -12000 }),
            row({ date: "20260120", voucherType: "Payment", voucherNumber: "P/9", reference: "ZL/77", amount: 12500 }),
          ],
        }),
        "ls_duplicate_reference",
      ),
    ).toEqual([]);
  });

  it("flags an entry more than five times the median entry", () => {
    const small = [1, 2, 3, 4, 5].map((d) => row({ date: `2026010${d}`, voucherNumber: `P/${d}`, amount: -1000 }));
    const [f, ...rest] = only(
      input({ rows: [...small, row({ date: "20260109", voucherNumber: "P/9", amount: -9000 })] }),
      "ls_large_entry",
    );
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ id: "LS-1-005-1", severity: "review", amount: 9000, side: "Cr" });
    expect(f.detail).toContain("9.0 times the ledger's median entry of 1,000.00");
  });

  it("does not flag exactly five times the median, or anything below six rows", () => {
    const small = [1, 2, 3, 4, 5].map((d) => row({ date: `2026010${d}`, voucherNumber: `P/${d}`, amount: -1000 }));
    expect(
      only(input({ rows: [...small, row({ date: "20260109", voucherNumber: "P/9", amount: -5000 })] }), "ls_large_entry"),
    ).toEqual([]);
    expect(
      only(input({ rows: [...small.slice(0, 4), row({ date: "20260109", voucherNumber: "P/9", amount: -9000 })] }), "ls_large_entry"),
    ).toEqual([]);
  });

  it("flags round-figure journals of at least 10,000 only", () => {
    const found = only(
      input({
        rows: [
          row({ date: "20260131", voucherType: "Journal", voucherNumber: "JV/1", counterparty: "Rent", amount: 25000 }),
          row({ date: "20260131", voucherType: "JOURNAL", voucherNumber: "JV/2", counterparty: "Rent", amount: -40000 }),
          row({ date: "20260131", voucherType: "Journal", voucherNumber: "JV/3", counterparty: "Rent", amount: 25000.5 }),
          row({ date: "20260131", voucherType: "Journal", voucherNumber: "JV/4", counterparty: "Rent", amount: 9000 }),
          row({ date: "20260131", voucherType: "Payment", voucherNumber: "P/5", counterparty: "Rent", amount: -50000 }),
        ],
      }),
      "ls_round_sum_journal",
    );
    expect(found.map((f) => f.id)).toEqual(["LS-1-006-1", "LS-1-006-2"]);
    expect(found[0].detail).toContain("Journal JV/1 on 31-Jan-2026 against Rent posts a round 25,000.00 Dr");
    expect(found[1].side).toBe("Cr");
  });

  it("summarises rows the downstream could not join exactly, ignoring unknown status", () => {
    const [f] = only(
      input({
        rows: [
          row({ date: "20260110", voucherNumber: "P/1", amount: -100 }),
          row({ date: "20260111", voucherNumber: "P/2", amount: -200, matchStatus: "ambiguous" }),
          row({ date: "20260112", voucherNumber: "P/3", amount: 300, matchStatus: "unmatched" }),
          row({ date: "20260113", voucherNumber: "P/4", amount: -400, matchStatus: "unknown" }),
        ],
      }),
      "ls_unjoined_rows",
    );
    expect(f).toMatchObject({ id: "LS-1-009-1", severity: "review", amount: 500 });
    expect(f.detail).toContain("2 of 4 entries could not be joined exactly to their vouchers (1 ambiguous, 1 unmatched)");
  });
});

describe("scrutinize: period movement", () => {
  it("flags a month whose gross movement is more than three times the median active month", () => {
    const [f, ...rest] = only(
      input({
        rows: [
          row({ date: "20260110", amount: -1000 }),
          row({ date: "20260210", voucherNumber: "P/2", amount: -1000 }),
          row({ date: "20260310", voucherNumber: "P/3", amount: -6000 }),
          row({ date: "20260311", voucherType: "Receipt", voucherNumber: "R/3", amount: 4000 }),
        ],
      }),
      "ls_movement_spike",
    );
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ id: "LS-1-007-1", severity: "review", amount: 10000, side: null });
    expect(f.detail).toContain("in Mar-2026 across 2 entries, 10.0 times its median active month of 1,000.00");
  });

  it("needs three active months before judging a spike", () => {
    expect(
      only(
        input({ rows: [row({ date: "20260110", amount: -1000 }), row({ date: "20260310", voucherNumber: "P/3", amount: -9000 })] }),
        "ls_movement_spike",
      ),
    ).toEqual([]);
  });

  it("lists silent months inside an expense ledger's active span, ignoring the edges and other roles", () => {
    const rows = ["20260115", "20260215", "20260415", "20260615"].map((date, n) =>
      row({ date, voucherType: "Journal", voucherNumber: `JV/${n}`, counterparty: "Outstanding Expenses", amount: 1000 }),
    );
    const i = input({ ledger: "Rent", group: "Indirect Expenses", role: "expense", fromDate: "20260101", toDate: "20260731", closing: 4000, rows });
    const [f, ...rest] = only(i, "ls_activity_gap");
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ id: "LS-1-008-1", severity: "review", amount: 0 });
    expect(f.detail).toContain("has no entries in Mar-2026, May-2026 between its first and last active month");
    expect(only({ ...i, role: "creditor", group: "Sundry Creditors" }, "ls_activity_gap")).toEqual([]);
  });
});

describe("scrutinize: GST", () => {
  it("flags an exactly-joined tax breakup whose effective rate is no GST slab", () => {
    const tax = (effectiveRatePct: number | null, taxStatus = "matched") => ({ effectiveRatePct, taxStatus });
    const i = input({
      gstin: "27AAAAA0000A1Z5",
      rows: [
        row({ date: "20260110", voucherType: "Purchase", voucherNumber: "PUR/1", counterparty: "Freight Inward", amount: -11350, tax: tax(13.5) }),
        row({ date: "20260111", voucherType: "Purchase", voucherNumber: "PUR/2", counterparty: "Freight Inward", amount: -11810, tax: tax(18.1) }),
        row({ date: "20260112", voucherType: "Purchase", voucherNumber: "PUR/3", counterparty: "Freight Inward", amount: -11350, tax: tax(13.5, "ambiguous-shared") }),
        row({ date: "20260113", voucherType: "Purchase", voucherNumber: "PUR/4", counterparty: "Freight Inward", amount: -11000, tax: tax(null) }),
      ],
    });
    const found = only(i, "ls_gst_rate_nonstandard");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "LS-1-010-1", severity: "review", amount: 11350, side: "Cr" });
    expect(found[0].detail).toBe(
      "Purchase PUR/1 on 10-Jan-2026 against Freight Inward: tax is 13.50% of the taxable value, " +
        "which is not a standard GST rate; the party is registered as 27AAAAA0000A1Z5",
    );
    expect(only({ ...i, gstin: null }, "ls_gst_rate_nonstandard")[0].detail).not.toContain("registered");
  });

  it("flags a registered party's sales or purchase voucher with no GST lines", () => {
    const none = { effectiveRatePct: null, taxStatus: "no-tax-rows" };
    const i = input({
      gstin: "27AAAAA0000A1Z5",
      rows: [
        row({ date: "20260110", voucherType: "Purchase", voucherNumber: "PUR/1", amount: -5000, tax: none }),
        row({ date: "20260111", voucherType: "Sales", voucherNumber: "S/1", amount: 7000, tax: none }),
        row({ date: "20260112", voucherType: "Journal", voucherNumber: "JV/1", amount: 300, tax: none }),
        row({ date: "20260113", voucherType: "Purchase", voucherNumber: "PUR/2", amount: -800, tax: null }),
      ],
    });
    const found = only(i, "ls_gst_untaxed_supply");
    expect(found.map((f) => f.id)).toEqual(["LS-1-011-1", "LS-1-011-2"]);
    expect(found[0].detail).toBe(
      "Purchase PUR/1 on 10-Jan-2026 (5,000.00 Cr) carries no GST lines although Acme Traders is " +
        "registered as 27AAAAA0000A1Z5 — check for reverse charge, an exempt or nil-rated supply, " +
        "or a missed tax entry",
    );
    expect(only({ ...i, gstin: null }, "ls_gst_untaxed_supply")).toEqual([]);
  });
});

describe("scrutinize: ordering and identity", () => {
  it("orders findings by check ordinal and numbers them per check under the ledger sequence", () => {
    const r = scrutinize(
      input({
        ledger: "Rent",
        group: "Indirect Expenses",
        role: "expense",
        ledgerSeq: 3,
        rows: [
          row({ date: "20260120", voucherType: "Journal", voucherNumber: "JV/2", counterparty: "Outstanding Expenses", amount: 30000 }),
          row({ date: "20260110", voucherType: "Journal", voucherNumber: "JV/1", counterparty: "Outstanding Expenses", amount: 20000 }),
        ],
      }),
    );
    expect(r.findings.map((f) => f.id)).toEqual(["LS-3-001-1", "LS-3-006-1", "LS-3-006-2"]);
    // Rows are date-sorted before the checks run.
    expect(r.findings[1].detail).toContain("JV/1");
    expect(r.findings.every((f) => f.ledger === "Rent" && f.group === "Indirect Expenses")).toBe(true);
  });
});
