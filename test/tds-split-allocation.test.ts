import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";

/**
 * Split allocation of one duty credit across several bookings (2026-09-29),
 * and the multi-mapped duty ledger that reported TDS-012-1 as unmapped.
 *
 * A fictional ledger universe, invented names and round amounts: a
 * sub-contractor bills in 194C at 2%, so every liability below is exactly
 * 2% of its booking. Nothing here is copied from live books.
 */

const dutyLedger = "TDS Payable - 194C - (Sub-Contract) A/c";
const expenseLedger = "Sub Contract Expenses - 2% A/c";
const party = "Sample Masonry Works";
const other = "Sample Haulage Partners";

const row = (
  date: string,
  voucher: string,
  amount: number,
  counterparty: string,
): LedgerVoucherRow => ({
  date,
  voucherType: "Purchase",
  voucherNumber: voucher,
  reference: "",
  counterparty,
  // Signed for the queried ledger: positive = debit.
  amount,
  matchStatus: "matched",
  tax: null,
});

/** One 194C booking: a debit on the expense ledger against the party. */
const bill = (date: string, voucher: string, gross: number): TdsLedgerRows => ({
  ledger: expenseLedger,
  rows: [row(date, voucher, gross, party)],
});

/** One duty credit: a credit on the TDS payable ledger against the party. */
const credit = (date: string, voucher: string, tax: number, cp = party): TdsLedgerRows => ({
  ledger: dutyLedger,
  rows: [row(date, voucher, -tax, cp)],
});

/** The duty credit's settlement: a debit back on the TDS payable ledger. */
const deposit = (date: string, voucher: string, tax: number): TdsLedgerRows => ({
  ledger: dutyLedger,
  rows: [row(date, voucher, tax, "Sample Bank")],
});

const operator: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: expenseLedger, section: "194C" },
    { ledger: dutyLedger, section: "194C" },
  ],
};

function ctx(over: Partial<TdsCtx> = {}): TdsCtx & { operator: OperatorFile } {
  const sectionsOf = (ledger: string): string[] =>
    [...new Set(operator.sections.filter((s) => s.ledger === ledger).map((s) => s.section))].sort();
  return {
    tdsParties: [party, other],
    resolveSection: (ledger) => {
      const set = sectionsOf(ledger);
      return { section: set.length === 1 ? set[0] : null, candidates: set.length > 1 ? set : [] };
    },
    // Mirrors the session exactly: a single mapping, else null (never guessed).
    dutySectionOf: (ledger) => {
      const set = sectionsOf(ledger);
      return set.length === 1 ? set[0] : null;
    },
    dutyCandidatesOf: (ledger) => sectionsOf(ledger),
    panKeyOf: (p) => `Pan of ${p}`,
    entityOf: () => null,
    certificateRateOf: () => null,
    transporterDeclared: () => false,
    deducteeFiledReturn: () => false,
    asOnDate: "20260331",
    period: { fromDate: "20250401", toDate: "20260331" },
    operator,
    ...over,
  };
}

type Run = ReturnType<typeof analyzeTds>;
const run = (c: ReturnType<typeof ctx>, duty: TdsLedgerRows[], expense: TdsLedgerRows[]): Run =>
  analyzeTds(duty, expense, [], c);
const of = (out: Run, check: string) => out.findings.filter((f) => f.check === check);
const ids = (out: Run, check: string) => of(out, check).map((f) => f.id).sort();

describe("TDS split allocation (2026-09-29)", () => {
  it("covers two bookings with one journal whose tax is exactly the sum of their liabilities", () => {
    // 20,000,000 at 2% = 400,000 and 8,000,000 at 2% = 160,000; one journal of
    // 560,000 pays both. The two bills sit in different months on purpose: a
    // same-month pair is already rescued by the party-month coverage rule, so
    // only this shape exercises the allocation.
    const out = run(
      ctx(),
      [credit("20260215", "J/9", 560000)],
      [bill("20260130", "P/1", 20000000), bill("20260301", "P/2", 8000000)],
    );
    expect(of(out, "tds_not_deducted")).toEqual([]);
    const [d] = out.events.deductions;
    // The credit keeps its own tax — the deposit, return and pool streams read
    // the journal, not a fabricated per-bill credit.
    expect(d.tax).toBe(560000);
    expect(d.shares).toEqual([
      expect.objectContaining({ tax: 400000, booking: expect.objectContaining({ voucherNumber: "P/1" }) }),
      expect.objectContaining({ tax: 160000, booking: expect.objectContaining({ voucherNumber: "P/2" }) }),
    ]);
    expect(out.liabilities).toEqual([
      expect.objectContaining({ liability: 400000, deduction: d }),
      expect.objectContaining({ liability: 160000, deduction: d }),
    ]);
  });

  it("leaves a true one-to-one pairing untouched", () => {
    const out = run(
      ctx(),
      [credit("20260130", "P/1", 400000)],
      [bill("20260130", "P/1", 20000000)],
    );
    expect(of(out, "tds_not_deducted")).toEqual([]);
    const [d] = out.events.deductions;
    expect(d.shares).toBeUndefined();
    expect(d.booking).toMatchObject({ voucherNumber: "P/1" });
  });

  it("prefers the exact one-to-one pairing over a split that would also add up", () => {
    // 400,000 fits P/1 alone AND P/2 + P/3 (200,000 + 200,000). The ordinary
    // case wins; a split must never take a credit that belongs to one bill.
    const out = run(
      ctx(),
      [credit("20260215", "J/9", 400000)],
      [bill("20260130", "P/1", 20000000), bill("20260301", "P/2", 10000000), bill("20260302", "P/3", 10000000)],
    );
    const [d] = out.events.deductions;
    expect(d.shares).toBeUndefined();
    expect(d.booking).toMatchObject({ voucherNumber: "P/1" });
  });

  it("splits three bookings when one journal is the sum of all three", () => {
    const out = run(
      ctx(),
      [credit("20260215", "J/9", 600000)],
      [
        bill("20260130", "P/1", 10000000),
        bill("20260227", "P/2", 10000000),
        bill("20260310", "P/3", 10000000),
      ],
    );
    expect(of(out, "tds_not_deducted")).toEqual([]);
    expect(out.events.deductions[0].shares?.map((s) => s.booking.voucherNumber)).toEqual(["P/1", "P/2", "P/3"]);
  });

  it("does not split on a sum that misses the tolerance, and does not split a party across sections", () => {
    // 400,000 + 160,000 = 560,000 against a journal of 560,050 — outside
    // TDS_TOLERANCE, so no allocation is invented.
    const off = run(
      ctx(),
      [credit("20260215", "J/9", 560050)],
      [bill("20260130", "P/1", 20000000), bill("20260301", "P/2", 8000000)],
    );
    expect(off.events.deductions[0].shares).toBeUndefined();
    // The 194-I(a) booking can never be covered by a 194C credit.
    const other1 = analyzeTds(
      [credit("20260215", "J/9", 560000)],
      [
        bill("20260130", "P/1", 20000000),
        { ledger: "Hire Charges A/c", rows: [row("20260301", "P/2", 10000000, party)] },
      ],
      [],
      ctx({
        resolveSection: (ledger) =>
          ledger === expenseLedger
            ? { section: "194C", candidates: [] }
            : { section: "194-I(a)", candidates: [] },
      }),
    );
    expect(other1.events.deductions[0].shares).toBeUndefined();
  });

  it("keeps a shared credit's interest per booking, never twice on the journal", () => {
    // One journal pays two bills, both deducted a month after the bill:
    // s.201(1A) interest (i) is 1% per month on each bill's own share, so the
    // journal must not carry either bill's charge a second time.
    const out = run(
      ctx(),
      [credit("20260320", "J/9", 560000)],
      [bill("20260225", "P/1", 20000000), bill("20260228", "P/2", 8000000)],
    );
    const late = of(out, "tds_late_deducted");
    expect(late).toHaveLength(2);
    expect(late.map((f) => f.amount).sort((a, b) => a - b)).toEqual([160000, 400000]);
    expect(out.totals.interestI).toBe(11200);
    const [d] = out.events.deductions;
    expect(d.interestI).toBeUndefined();
    expect(d.shares?.map((s) => s.interestI).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([3200, 8000]);
  });

  it("names the competing credit in the finding when a booking is still left uncovered", () => {
    // 400,000 + 160,000 = 560,000, but the journal pays 560,050: the two
    // bills are uncovered and the finding must carry the evidence instead of
    // sending the operator after a payment the books already hold.
    const out = run(
      ctx(),
      [credit("20260215", "J/9", 560050)],
      [bill("20260130", "P/1", 20000000), bill("20260301", "P/2", 8000000)],
    );
    const findings = of(out, "tds_not_deducted");
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.detail).toContain("Evidence considered:");
      expect(f.detail).toContain("15-Feb-2026");
      // No name, no PAN — only dates and money.
      expect(f.detail).not.toContain(party);
      expect(f.detail).not.toContain("Pan of");
    }
  });
});

describe("TDS-012-1: a multi-mapped duty ledger is mapped (2026-09-29)", () => {
  const dual: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: expenseLedger, section: "194C" },
      { ledger: "TDS Payable - 194I - (Hire/Rent) A/c", section: "194-I(a)" },
      { ledger: "TDS Payable - 194I - (Hire/Rent) A/c", section: "194-I(b)" },
    ],
  };
  const hireDuty = "TDS Payable - 194I - (Hire/Rent) A/c";
  const dualCtx = (): TdsCtx & { operator: OperatorFile } => {
    const sectionsOf = (ledger: string): string[] =>
      [...new Set(dual.sections.filter((s) => s.ledger === ledger).map((s) => s.section))].sort();
    return {
      tdsParties: [party, other],
      resolveSection: (ledger) => {
        const set = sectionsOf(ledger);
        return { section: set.length === 1 ? set[0] : null, candidates: set.length > 1 ? set : [] };
      },
      dutySectionOf: (ledger) => {
        const set = sectionsOf(ledger);
        return set.length === 1 ? set[0] : null;
      },
      dutyCandidatesOf: (ledger) => sectionsOf(ledger),
      panKeyOf: (p) => `Pan of ${p}`,
      entityOf: () => null,
      certificateRateOf: () => null,
      transporterDeclared: () => false,
      deducteeFiledReturn: () => false,
      asOnDate: "20260331",
      period: { fromDate: "20250401", toDate: "20260331" },
      operator: dual,
    };
  };

  it("raises no unmapped finding for a duty ledger mapped to 194-I(a) and 194-I(b)", () => {
    const c = dualCtx();
    expect(c.dutySectionOf(hireDuty)).toBeNull();
    expect(c.dutyCandidatesOf(hireDuty)).toEqual(["194-I(a)", "194-I(b)"]);
    const out = analyzeTds(
      [{ ledger: hireDuty, rows: [row("20260215", "J/1", -30000, party)] }],
      [{ ledger: "Plant Hire A/c", rows: [row("20260110", "P/1", 2000000, party)] }],
      [],
      c,
    );
    const gaps = of(out, "tds_master_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].detail).toContain("is mapped to 2 sections (194-I(a), 194-I(b))");
    expect(gaps[0].detail).toContain("resolved per row");
    for (const f of out.findings) expect(f.detail).not.toContain("has no section mapping");
  });

  it("still reports a duty ledger with no mapping at all", () => {
    const c = ctx({ resolveSection: (l) => ({ section: l === expenseLedger ? "194C" : null, candidates: [] }) });
    const out = analyzeTds(
      [{ ledger: "TDS Payable - 194Q - (Professional) A/c", rows: [row("20260215", "J/1", -100, party)] }],
      [bill("20260110", "P/1", 20000000)],
      [],
      c,
    );
    const gaps = of(out, "tds_master_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].detail).toContain("has no section mapping");
  });

  it("reports the gap when the caller cannot disambiguate at all (no dutyCandidatesOf)", () => {
    // Without the candidate accessor the engine skips such rows whole, so the
    // ledger really is unmapped and the original wording is the honest one.
    const c = ctx();
    const blind: TdsCtx & { operator: OperatorFile } = { ...c, dutyCandidatesOf: undefined };
    const out = analyzeTds(
      [{ ledger: "TDS Payable - 194I - (Hire/Rent) A/c", rows: [row("20260215", "J/1", -30000, party)] }],
      [bill("20260110", "P/1", 20000000)],
      [],
      blind,
    );
    expect(of(out, "tds_master_gap").map((f) => f.detail)).toEqual([
      expect.stringContaining("has no section mapping"),
    ]);
  });
});

describe("TDS split allocation: ordinals and ids are untouched", () => {
  it("keeps the finding id space of every other check", () => {
    const out = run(
      ctx(),
      [credit("20260215", "J/9", 560000)],
      [bill("20260130", "P/1", 20000000), bill("20260301", "P/2", 8000000)],
    );
    expect(out.findings.every((f) => /^TDS-\d{3}-\d+$/.test(f.id))).toBe(true);
    expect(ids(out, "tds_not_deducted")).toEqual([]);
  });
});

/**
 * The same-calendar-month consolidation (2026-09-29, captain): one TDS journal
 * booked against several expense entries of one month is normal bookkeeping,
 * not a compliance gap, so every booking it pays counts as deducted.
 *
 * Same fictional 194C sub-contractor universe at 2%, so each booking's
 * liability is exactly 2% of its gross. Nothing here is copied from live books.
 */
describe("TDS same-month consolidation (2026-09-29)", () => {
  /** n bills of `gross` inside Feb-2026, so a month-end journal can pay them. */
  const month = (n: number, gross: number, from = 1): TdsLedgerRows[] =>
    Array.from({ length: n }, (_, i) =>
      bill(`202602${String(from + i).padStart(2, "0")}`, `P/${from + i}`, gross),
    );

  it("clears six same-month bookings with one journal — the whole month, any N", () => {
    // Six bills of 50,00,000 at 2% = 1,00,000 each; the 28-Feb journal of
    // 6,00,000 pays all six. The old 30-day/4-booking split could never reach
    // this shape, and the credit would have been handed to one bill.
    const out = run(ctx(), [credit("20260228", "J/9", 600000)], month(6, 5000000));
    const [d] = out.events.deductions;
    expect(d.shares?.map((s) => s.booking.voucherNumber)).toEqual([
      "P/1", "P/2", "P/3", "P/4", "P/5", "P/6",
    ]);
    expect(d.consolidated).toBe("month");
    // The credit keeps its own tax; the shares carry each bill's own liability.
    expect(d.tax).toBe(600000);
    expect(new Set(d.shares?.map((s) => s.tax))).toEqual(new Set([100000]));
    expect(out.consolidations).toEqual([
      {
        party,
        section: "194C",
        scope: "month",
        creditDate: "20260228",
        creditVoucherNumber: "J/9",
        tax: 600000,
        bookings: Array.from({ length: 6 }, (_, i) => ({
          date: `2026020${i + 1}`,
          voucherNumber: `P/${i + 1}`,
          tax: 100000,
        })),
      },
    ]);
    // Each bill is attributed exactly, so nothing is left to report.
    expect(out.liabilities).toHaveLength(6);
    expect(out.liabilities.every((l) => l.deduction === d && l.liability === 100000)).toBe(true);
    expect(of(out, "tds_not_deducted")).toEqual([]);
    expect(of(out, "tds_short_deducted")).toEqual([]);
    expect(of(out, "tds_late_deducted")).toEqual([]);
  });

  it("consolidates a PART of the month and still reports the bills the journal misses", () => {
    // Four Feb bills of 1,00,000 tax each and a journal of 2,00,000: the month
    // rule finds the two bills it pays, and the other two are a real gap. The
    // party-month coverage rule cannot rescue this (the month's credit is
    // below the month's liability), so the finding is genuine either way.
    const out = run(ctx(), [credit("20260228", "J/9", 200000)], month(4, 5000000));
    const [d] = out.events.deductions;
    expect(d.consolidated).toBe("month");
    expect(d.shares?.map((s) => s.booking.voucherNumber)).toEqual(["P/1", "P/2"]);
    expect(of(out, "tds_not_deducted")).toHaveLength(2);
    expect(out.consolidations).toHaveLength(1);
    expect(out.consolidations[0].bookings).toHaveLength(2);
  });

  it("never consolidates across two months — the captain's scope is one calendar month", () => {
    // The same six bills, three in January and three in February, with one
    // journal of 6,00,000 in March. The January bills are 49+ days before the
    // credit, outside even the 30-day window, and the month rule never spans
    // months: only the three February bills are within reach, and no subset of
    // them adds to 6,00,000, so nothing is consolidated. The unpaired February
    // bill the ordinary 1:1 walk can still pair stays paired, and the rest are
    // honestly reported.
    const out = run(
      ctx(),
      [credit("20260305", "J/9", 600000)],
      [
        bill("20260105", "P/1", 5000000), bill("20260110", "P/2", 5000000), bill("20260115", "P/3", 5000000),
        bill("20260210", "P/4", 5000000), bill("20260220", "P/5", 5000000), bill("20260225", "P/6", 5000000),
      ],
    );
    expect(out.events.deductions[0].shares).toBeUndefined();
    expect(out.consolidations).toEqual([]);
    const unpaired = of(out, "tds_not_deducted");
    expect(unpaired).toHaveLength(5);
    // All three January bookings are among them: the month rule never reached
    // across the month boundary, and the credit went to one February bill by
    // the ordinary walk rather than to any group of them.
    expect(unpaired.filter((f) => f.detail.includes("-Jan-2026"))).toHaveLength(3);
  });

  it("does not consolidate a same-month sum that misses the tolerance", () => {
    // Six bills of 1,00,000 tax each against a journal of 6,00,050: outside
    // TDS_TOLERANCE, so no allocation is invented — the credit stays unpaired.
    const out = run(ctx(), [credit("20260228", "J/9", 600050)], month(6, 5000000));
    expect(out.events.deductions[0].shares).toBeUndefined();
    expect(out.events.deductions[0].consolidated).toBeUndefined();
    expect(out.consolidations).toEqual([]);
  });

  it("states the search bound in plain words when a month's bills exceed it", () => {
    // 14 bills of 1,00,000 tax in one month and a journal of 13,00,000: the
    // whole month sums to 14,00,000 (a miss), the partial search looks at the
    // first 12, and no subset of those 12 adds to 13,00,000. The bound must be
    // reported, never silent.
    const out = run(ctx(), [credit("20260228", "J/9", 1300000)], month(14, 5000000, 1));
    expect(out.events.deductions[0].shares).toBeUndefined();
    const skip = of(out, "tds_consolidation_search_skipped");
    expect(skip).toHaveLength(1);
    expect(skip[0].id).toMatch(/^TDS-019-1$/);
    expect(skip[0].severity).toBe("review");
    expect(skip[0].detail).toContain("14 unpaired bookings of this party");
    expect(skip[0].detail).toContain("first 12 of them");
    // Names and PANs never ride a detail string.
    expect(skip[0].detail).not.toContain(party);
    expect(skip[0].detail).not.toContain("Pan of");
  });

  it("keeps the cross-month 30-day window split working exactly as before", () => {
    // The pre-existing scope: 30-Jan and 01-Mar bills paid by a 15-Feb
    // journal. A February-dated credit cannot consolidate a March bill, so
    // this must still resolve through the window, with scope "window".
    const out = run(
      ctx(),
      [credit("20260215", "J/9", 560000)],
      [bill("20260130", "P/1", 20000000), bill("20260301", "P/2", 8000000)],
    );
    const [d] = out.events.deductions;
    expect(d.shares).toHaveLength(2);
    expect(d.consolidated).toBe("window");
    expect(out.consolidations).toEqual([
      expect.objectContaining({ scope: "window", creditDate: "20260215", tax: 560000 }),
    ]);
    expect(of(out, "tds_not_deducted")).toEqual([]);
  });

  it("reports a consolidated credit's late deposit once, for the whole credit", () => {
    // Three January bills of 1,00,000 tax each, paid by one 31-Jan journal of
    // 3,00,000 and deposited on 25-Mar. The deposit is the JOURNAL's, so the
    // late deposit is one finding for 3,00,000 — repeating it per share read as
    // three findings and, on the real FY 25-26 books, as 734.
    const out = run(
      ctx(),
      [credit("20260131", "J/9", 300000), deposit("20260325", "R/1", 300000)],
      [bill("20260105", "P/1", 5000000), bill("20260110", "P/2", 5000000), bill("20260115", "P/3", 5000000)],
    );
    expect(out.events.deductions[0].consolidated).toBe("month");
    expect(of(out, "tds_not_deposited")).toEqual([]);
    const late = of(out, "tds_late_deposit");
    expect(late).toEqual([expect.objectContaining({ amount: 300000, severity: "warning" })]);
    expect(late[0].schedule).toEqual([
      expect.objectContaining({ kind: "ii", from: "20260131", to: "20260325" }),
    ]);
  });

  it("does not expose a consolidated credit's missing deposit", () => {
    // A credit that covers a whole month of bookings has ONE deposit for the
    // month, so its deposit state is the month pool's to resolve (2026-09-26e),
    // not a per-booking one. The captain's rule (2026-09-29) is explicit: a
    // consolidated booking carries no s.40(a)(ia) exposure. Spreading the base
    // over the month's bills read a whole month of purchases as not-deposited
    // expenditure on a real company (a 194Q liability is only its post-threshold
    // excess). The single-credit case keeps its own finding and base.
    const out = run(
      ctx(),
      [credit("20260131", "J/9", 300000)],
      [bill("20260105", "P/1", 5000000), bill("20260110", "P/2", 5000000), bill("20260115", "P/3", 5000000)],
    );
    expect(out.consolidations).toHaveLength(1);
    expect(of(out, "tds_not_deposited")).toEqual([]);
    expect(of(out, "tds_exposure_40a_ia")).toEqual([]);
    expect(out.clause21b.filter((r) => r.reason === "not_deposited")).toEqual([]);
    // The deduction is still visibly consolidated, so nothing is hidden.
    expect(of(out, "tds_not_deducted")).toEqual([]);
  });

  it("still prefers an exact one-to-one pairing inside the month", () => {
    // 1,00,000 fits P/1 alone AND P/2 + P/3. The ordinary case wins, so a
    // month-end journal never steals a bill that has its own credit.
    const out = run(
      ctx(),
      [credit("20260228", "J/9", 100000)],
      month(3, 5000000),
    );
    const [d] = out.events.deductions;
    expect(d.shares).toBeUndefined();
    expect(d.consolidated).toBeUndefined();
    expect(out.consolidations).toEqual([]);
  });
});
