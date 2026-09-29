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
