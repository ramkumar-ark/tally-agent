import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow, VoucherRow } from "../src/downstream.js";
import { projectLedgerRows } from "../src/tds-daybook.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { TDS_CHECK_ORDINAL, tdsFindingId } from "../src/types.js";

/**
 * A fictional ledger universe, in no way copied from live books. The worked
 * example from the TDS brainstorm carries the exact figures: a
 * 2,50,000 bill at 2% = 5,000 tax, booked 10-May-2025, deducted 28-Jun-2025,
 * deposited 15-Aug-2025.
 * Interest (i) 1% x 2 months = 100; interest (ii) 1.5% x 3 months = 225.
 */

const dutyLedger = "TDS Contractors";
const expenseLedger = "Site Repairs Contract";
const partyA = "Sample Builders LLP";
const partyB = "Sample Consultants";
const partnerA = "Partner Alpha";

const row = (date: string, voucher: string, amount: number, counterparty: string): LedgerVoucherRow => ({
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

export const stdOperator: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [{ ledger: expenseLedger, section: "194C" }],
};

export function tdsCtx(
  operator: OperatorFile = stdOperator,
  over: Partial<TdsCtx> = {},
): TdsCtx & { period: { fromDate: string; toDate: string } } {
  return {
    tdsParties: [partyA, partyB, partnerA],
    resolveSection: (ledger) => {
      const set = [...new Set(operator.sections.filter((s) => s.ledger === ledger).map((s) => s.section))].sort();
      return set.length === 1 ? { section: set[0], candidates: [] } : { section: null, candidates: set.length > 1 ? set : [] };
    },
    dutySectionOf: (ledger) => {
      // Mirrors the session: exactly one mapped section, else null (never guessed).
      const set = [...new Set(operator.sections.filter((s) => s.ledger === ledger).map((s) => s.section))];
      if (set.length === 1) return set[0];
      if (set.length > 1) return null;
      return ledger === dutyLedger ? "194C" : null;
    },
    dutyCandidatesOf: (ledger) =>
      [...new Set(operator.sections.filter((s) => s.ledger === ledger).map((s) => s.section))].sort(),
    panKeyOf: (party) => `Pan of ${party}`, // a PAN is present by default, one per party
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

export type Run = ReturnType<typeof analyzeTds>;

const run = (
  ctx: ReturnType<typeof tdsCtx>,
  duty: TdsLedgerRows[] = [],
  expense: TdsLedgerRows[] = [],
  party: TdsLedgerRows[] = [],
): Run => analyzeTds(duty, expense, party, ctx);

const ofCheck = (out: Run, check: string) => out.findings.filter((f) => f.check === check);

describe("TDS event model", () => {
  it("recognizes a booking from a normal Dr Expense / Cr Party voucher (expense debit, party credit)", () => {
    const out = run(
      tdsCtx(),
      [],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }],
      [{ ledger: partyA, rows: [{ ...row("20250510", "P/12", -250000, expenseLedger), voucherType: "Purchase" }] }],
    );
    expect(out.events.bookings).toEqual([
      expect.objectContaining({ date: "20250510", party: partyA, gross: 250000, ledger: expenseLedger }),
    ]);
    expect(out.events.payments).toEqual([]);
  });

  it("recognizes a debit booking on an expense ledger to a TDS party", () => {
    const out = run(tdsCtx(), [], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(out.events.bookings).toEqual([
      expect.objectContaining({ date: "20250510", party: partyA, gross: 250000, ledger: expenseLedger }),
    ]);
  });

  it("recognizes a payment or advance as a debit row on the party ledger", () => {
    const out = run(tdsCtx(), [], [], [
      { ledger: partyA, rows: [{ ...row("20250505", "P/01", 20000, "Cash"), voucherType: "Payment" }] },
    ]);
    expect(out.events.payments).toEqual([
      expect.objectContaining({ date: "20250505", party: partyA, amount: 20000, voucherNumber: "P/01" }),
    ]);
  });

  it("recognizes a deduction: a duty-ledger credit with the deductee counterparty", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(out.events.deductions).toEqual([
      expect.objectContaining({ date: "20250628", party: partyA, tax: 5000, section: "194C" }),
    ]);
  });

  it("recognizes a deposit: a duty-ledger debit matched to the deduction by date and amount", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA), row("20250815", "P/12", 5000, "Bank Alpha")] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(out.events.deposits).toEqual([
      expect.objectContaining({ date: "20250815", tax: 5000, section: "194C" }),
    ]);
  });

  it("joins deductions by voucherNumber when both reports name it, else by month and counterparty (30 days)", () => {
    const ctx = tdsCtx();
    // Named voucher on both sides: joined despite the date gap.
    const joined = run(ctx, [
      { ledger: dutyLedger, rows: [row("20250731", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(joined.events.deductions).toEqual([
      expect.objectContaining({ joinedTo: "P/12", date: "20250731" }),
    ]);
    // Unnamed on one side: same month and counterparty, within 30 days.
    const fallback = run(ctx, [
      { ledger: dutyLedger, rows: [row("20250528", "ADV-9", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(fallback.events.deductions).toEqual([
      expect.objectContaining({ joinedTo: "P/12", date: "20250528" }),
    ]);
    // Counterparty mismatch never joins.
    const noGuess = run(ctx, [
      { ledger: dutyLedger, rows: [row("20250528", "ADV-9", -5000, partyB)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    // The duty credit itself exists unjoined; it is the JOIN that never happens.
    expect(noGuess.events.deductions.every((d) => !d.booking)).toBe(true);
  });

  it("merges sibling ledgers of one PAN (2026-09-26o item 2): a sibling's duty credit covers the booking", () => {
    const site = "Sample Builders LLP";
    const hq = "Sample Builders - HQ";
    const ctx = tdsCtx(stdOperator, {
      tdsParties: [site, hq],
      panKeyOf: (p) => (p.startsWith("Sample Builders") ? "Pan SB" : `Pan of ${p}`),
    });
    // Booking under the site ledger, the deduction journaled against the
    // head-office ledger: one PAN, so the join must still happen.
    const out = run(
      ctx,
      [{ ledger: dutyLedger, rows: [row("20250528", "ADV-9", -5000, hq)] }],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, site)] }],
    );
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(out.events.deductions.some((d) => d.booking)).toBe(true);
  });

  it("does not merge ledgers carrying distinct PANs (2026-09-26o item 2)", () => {
    const out = run(
      tdsCtx(),
      [{ ledger: dutyLedger, rows: [row("20250528", "ADV-9", -5000, partyB)] }],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }],
    );
    expect(out.events.deductions.every((d) => !d.booking)).toBe(true);
    expect(ofCheck(out, "tds_not_deducted").length).toBeGreaterThan(0);
  });
});

describe("TDS thresholds, rates and the 194Q crossing exception", () => {
  it("flags a booking past the single-payment threshold with no deduction as tds_not_deducted", () => {
    const out = run(
      tdsCtx(),
      [],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }],
    );
    const found = ofCheck(out, "tds_not_deducted");
    expect(found).toEqual([
      expect.objectContaining({
        id: tdsFindingId("tds_not_deducted", 1),
        severity: "critical",
        deductee: partyA,
        section: "194C",
        amount: 5000,
      }),
    ]);
    expect(found[0].detail).toContain("2,50,000.00");
  });

  it("keeps a small-booking, threshold-unmet party out of the findings", () => {
    const out = run(
      tdsCtx(),
      [],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 20000, partyA)] }],
    );
    expect(out.findings).toEqual([]);
  });

  it("applies whole-year liability on aggregate crossing: sub-threshold bookings both liable", () => {
    // Six 20,000 bookings = 1,20,000 aggregate, past the 1,00,000 aggregate;
    // each is below the 30,000 single threshold, but the whole year is liable.
    const out = run(
      tdsCtx(),
      [],
      [{ ledger: expenseLedger, rows: [1, 2, 3, 4, 5, 6].map((i) =>
        row(`2025051${i}`, `P/${i}`, 20000, partyA)) }],
    );
    const found = ofCheck(out, "tds_not_deducted");
    expect(found).toHaveLength(6);
    expect(found.reduce((a, f) => a + f.amount, 0)).toBe(2400); // 1,20,000 x 2%
  });

  it("194Q adds only the amount beyond the crossing", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Purchase - Domestic", section: "194Q" }],
    };
    const cfg = tdsCtx(operator, {
      dutySectionOf: () => null,
      asOnDate: "20260331",
    });
    const goods = 6000000; // crosses the 50,00,000 aggregate
    const out = run(
      cfg,
      [],
      [{ ledger: "Purchase - Domestic", rows: [row("20250510", "G/1", goods, partyA)] }],
    );
    const found = ofCheck(out, "tds_not_deducted");
    // 0.1% of only the 10,00,000 beyond the crossing = 1,000.
    expect(found.map((f) => f.amount)).toEqual([expect.closeTo(1000, 0)]);
  });

  it("194Q measures the excess against the running cumulative, not the year total", () => {
    // One seller: 30L, 25L, 10L. The 50L threshold is crossed by the second
    // booking (cumulative 55L), so only its 5L excess and the full 10L after
    // are liable — the first 30L is never liable.
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Purchase - Domestic", section: "194Q" }],
    };
    const cfg = tdsCtx(operator, { dutySectionOf: () => null, panKeyOf: () => "TaxId 999" });
    const out = run(
      cfg,
      [],
      [{
        ledger: "Purchase - Domestic",
        rows: [
          row("20250410", "G/1", 3000000, partyB),
          row("20250510", "G/2", 2500000, partyB),
          row("20250610", "G/3", 1000000, partyB),
        ],
      }],
    );
    const found = ofCheck(out, "tds_not_deducted");
    // 0.1% of 5,00,000 = 500 and of 10,00,000 = 1,000; the pre-crossing booking is not liable.
    expect(found.map((f) => f.amount)).toEqual([500, 1000]);
  });

  it("194Q stays silent when the year aggregate never crosses the threshold", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Purchase - Domestic", section: "194Q" }],
    };
    const cfg = tdsCtx(operator, { dutySectionOf: () => null });
    const out = run(
      cfg,
      [],
      [{
        ledger: "Purchase - Domestic",
        rows: [
          row("20250410", "G/1", 3000000, partyB),
          row("20250510", "G/2", 1500000, partyB), // 45L total, below 50L
        ],
      }],
    );
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
  });

  it("an express 194Q opt-out suppresses 194Q findings entirely", () => {
    // The buyer did not meet the previous-year turnover condition: the operator
    // sets 194Q Applicable = N, so an otherwise-liable 194Q booking produces
    // nothing — not a single-payer exemption, the whole section is out.
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Purchase - Domestic", section: "194Q" }],
      section194QApplicable: false,
    };
    const cfg = tdsCtx(operator, { dutySectionOf: () => null, panKeyOf: () => "TaxId 999" });
    const out = run(
      cfg,
      [],
      [{
        ledger: "Purchase - Domestic",
        rows: [
          row("20250410", "G/1", 3000000, partyB),
          row("20250510", "G/2", 3000000, partyB), // well past the 50L aggregate
        ],
      }],
    );
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(out.findings.some((f) => f.section === "194Q")).toBe(false);
  });

  it("a wholeYear section (194C) still makes every booking liable once the aggregate crosses", () => {
    // Six 20,000 bookings: aggregate 1,20,000 crosses the 1,00,000 threshold,
    // so the whole year is liable even though each is below the single limit.
    const out = run(
      tdsCtx(),
      [],
      [{ ledger: expenseLedger, rows: [1, 2, 3, 4, 5, 6].map((i) =>
        row(`2025051${i}`, `P/${i}`, 20000, partyB)) }],
    );
    const found = ofCheck(out, "tds_not_deducted");
    expect(found).toHaveLength(6);
    expect(found.reduce((a, f) => a + f.amount, 0)).toBe(2400);
  });

  it("rates: PAN 4th char P/H at 1% for 194C, entity C/F at 2%", () => {
    const pan = tdsCtx(stdOperator, {
      entityOf: (p) => (p === partyA ? "P" : "F"),
    });
    const rows = row("20250510", "P/12", 250000, partyA);
    const out = run(pan, [], [{ ledger: expenseLedger, rows: [rows] }]);
    expect(ofCheck(out, "tds_not_deducted")[0].amount).toBe(2500); // 1%
  });

  it("a no-PAN deductee books the s.206AA rate (higher of section rate or 20%)", () => {
    const pan = tdsCtx(stdOperator, {
      panKeyOf: () => null,
      entityOf: () => null,
    });
    const out = run(pan, [], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_not_deducted")[0];
    expect(found.amount).toBe(50000); // 20%
    expect(found.detail.toUpperCase()).toContain("206AA");
  });

  it("an s.197 certificate rate overrides the section rate", () => {
    const pan = tdsCtx(stdOperator, {
      certificateRateOf: () => 0.015, // the s.197 certificate rate
    });
    const out = run(pan, [], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_not_deducted")[0].amount).toBe(3750); // 1.5% (the operator rate)
  });
});

describe("TDS late-deduction findings and interest (i)/(ii)", () => {
  it("flags a deduction after the deductible date with the interest (i) schedule row", () => {
    // The worked example: booked 10-May (deductible), deducted 28-Jun (deduction).
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_late_deducted");
    expect(found).toEqual([
      expect.objectContaining({ amount: 5000, severity: "warning" }),
    ]);
    const schedule = found[0].schedule ?? [];
    expect(schedule).toEqual([
      expect.objectContaining({ kind: "i", amount: 100, from: "20250510", to: "20250628" }),
    ]);
  });

  it("the deductible date pulls earlier when an advance precedes the booking", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }], [
      { ledger: partyA, rows: [{ ...row("20250420", "P/03", 250000, "Bank Alpha"), voucherType: "Advance" }] },
    ]);
    const found = ofCheck(out, "tds_late_deducted");
    expect(found[0].schedule?.[0].from).toBe("20250420");
  });

  it("a deduction on time emits no tds_late_deducted", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_late_deducted")).toEqual([]);
  });

  it("computes late-deduction (i) interest by default (2026-09-26r inbox 067)", () => {
    const out = run(tdsCtx(undefined, { lateDeductionInterest: true }), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_late_deducted")).toHaveLength(1);
  });

  it("omits late-deduction (i) interest, its finding and its payable when disabled (2026-09-26r inbox 067)", () => {
    const out = run(tdsCtx(undefined, { lateDeductionInterest: false }), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_late_deducted")).toEqual([]);
    expect(out.totals.interestI).toBe(0);
  });

  it("leaves late-DEPOSIT (ii) interest untouched when late-deduction interest is disabled (2026-09-26r inbox 067)", () => {
    // Deducted on time (same day), deposited two months late: only (ii) applies.
    const out = run(tdsCtx(undefined, { lateDeductionInterest: false }), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -5000, partyA), row("20250810", "P/90", 5000, "Bank Alpha")] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_late_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_late_deposit")).toHaveLength(1);
    expect(out.totals.interestIi).toBeGreaterThan(0);
  });

  it("suppresses a party's sub-100 short deduction for the year (2026-09-26o item 3)", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -4998, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_short_deducted")).toEqual([]);
    expect(out.totals.shortDeducted).toBe(0);
  });

  it("reports a short deduction once the party's FY total reaches 100", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -4000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_short_deducted");
    expect(found).toEqual([expect.objectContaining({ amount: 1000, severity: "critical" })]);
    expect(out.totals.shortDeducted).toBe(1000);
  });

  it("measures the 100 floor across the party's whole year, not per row", () => {
    // Two rows of 30 each: 60 for the year, below the floor — both suppressed.
    const small = run(tdsCtx(), [
      {
        ledger: dutyLedger,
        rows: [row("20250510", "P/1", -4970, partyA), row("20250610", "P/2", -5970, partyA)],
      },
    ], [
      {
        ledger: expenseLedger,
        rows: [row("20250510", "P/1", 250000, partyA), row("20250610", "P/2", 300000, partyA)],
      },
    ]);
    expect(ofCheck(small, "tds_short_deducted")).toEqual([]);
    // Two rows of 60 each: 120 for the year, over the floor — both reported.
    const large = run(tdsCtx(), [
      {
        ledger: dutyLedger,
        rows: [row("20250510", "P/1", -4940, partyA), row("20250610", "P/2", -5940, partyA)],
      },
    ], [
      {
        ledger: expenseLedger,
        rows: [row("20250510", "P/1", 250000, partyA), row("20250610", "P/2", 300000, partyA)],
      },
    ]);
    expect(ofCheck(large, "tds_short_deducted").map((f) => f.amount)).toEqual([60, 60]);
    expect(large.totals.shortDeducted).toBe(120);
  });

  it("keeps a joined deduction within the one-rupee tolerance out of the findings", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -4999.5, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_short_deducted")).toEqual([]);
  });

  it("orders findings by date, then deductee, then section ", () => {
    const out = run(tdsCtx(), [],
      [{ ledger: expenseLedger, rows: [
        row("20250610", "PB/1", 250000, partyB),
        row("20250510", "P/12", 250000, partyA),
      ] }]);
    const ids = out.findings.filter((f) => f.check === "tds_not_deducted");
    expect(ids[0].deductee).toBe(partyA);
    expect(ids[1].deductee).toBe(partyB);
  });

  it("keeps every TDS check out of the TB ordinal space", () => {
    for (const check of Object.keys(TDS_CHECK_ORDINAL)) {
      expect(/^t(d|c)s_/.test(check)).toBe(true);
    }
  });
});


describe("TDS deposit checks", () => {
  it("flags a deduction with no deposit debit by asOnDate as tds_not_deposited", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_not_deposited");
    expect(found).toEqual([
      expect.objectContaining({ amount: 5000, severity: "critical", section: "194C" }),
    ]);
  });

  it("flags a deposit after the Rule 30 due date with the interest (ii) schedule row", () => {
    // Worked example: deducted 28-Jun, deposited 15-Aug: 1.5% x 3 = 225.
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA), row("20250815", "P/12", 5000, "Bank Alpha")] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_late_deposit");
    expect(found).toEqual([
      expect.objectContaining({ amount: 5000, severity: "warning" }),
    ]);
    expect(found[0].schedule).toEqual([
      expect.objectContaining({ kind: "ii", amount: 225, from: "20250628", to: "20250815" }),
    ]);
  });

  it("keeps a deposit on time (7th next month) out of the findings", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA), row("20250707", "P/12", 5000, "Bank Alpha")] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_late_deposit")).toEqual([]);
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
  });

  it("flags a book-vs-operator-challan month difference as tds_deposit_mismatch", () => {
    const op: OperatorFile = {
      ...stdOperator,
      challans: [{ section: "194C", forMonth: "2025-06", depositDate: "20250915" }],
    };
    const out = run(tdsCtx(op), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA), row("20250702", "P/12", 5000, "Bank Alpha")] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_deposit_mismatch").length).toBe(1);
  });
});

describe("TDS statement checks (234E, 271H)", () => {
  it("flags a statement filed late with the 234E fee schedule row", () => {
    const op: OperatorFile = {
      ...stdOperator,
      statements: [{ form: "26Q", quarter: "Q1", filedDate: "20250820", tdsAmount: 5000 }],
    };
    const out = run(tdsCtx(op), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_statement_late");
    expect(found).toHaveLength(1);
    // Q1 due 31-Jul; filed 20-Aug = 20 days; 200 x 20 = 4,000, under the 5,000 cap.
    expect(found[0].schedule).toEqual([
      expect.objectContaining({ kind: "fee", from: "20250731", to: "20250820" }),
    ]);
  });

  it("flags a past quarter with no statement row at all", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_statement_missing")).toHaveLength(1);
  });

  it("keeps an on-time statement out of the findings", () => {
    const op: OperatorFile = {
      ...stdOperator,
      statements: [{ form: "26Q", quarter: "Q2", filedDate: "20251015", tdsAmount: 5000 }],
    };
    const out = run(tdsCtx(op), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_statement_late")).toEqual([]);
    expect(ofCheck(out, "tds_statement_late")).toEqual([]);
  });
});

describe("TDS exposure findings and the s.201(1) proviso", () => {
  it("states the s.40(a)(ia) exposure at 30% of the expenditure not covered, review-only", () => {
    const out = run(tdsCtx(), [],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_exposure_40a_ia");
    expect(found).toEqual([
      expect.objectContaining({ amount: 75000, severity: "review", deductee: "" }), // 30% of the 2,50,000 expenditure
    ]);
  });

  it("states the not-deposited s.40(a)(ia) exposure at 30% of the expenditure, not of the tax", () => {
    const op: OperatorFile = { ...stdOperator };
    const out = run(op ? tdsCtx(op) : tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    // The tax was deducted but never deposited (no deposit rows): the
    // disallowance rides the expenditure, not the 5,000 tax.
    const found = ofCheck(out, "tds_exposure_40a_ia");
    expect(found).toContainEqual(
      expect.objectContaining({ amount: 75000, deductee: "" }),
    );
  });

  it("states the s.271C exposure equal to the tax not deducted, review-only", () => {
    const out = run(tdsCtx(), [],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_exposure_271c")[0].amount).toBe(5000);
  });

  it("the s.201(1) proviso shields interest (i) but keeps the late-deduction finding", () => {
    const op: OperatorFile = {
      ...stdOperator,
      parties: [{ ledger: partyA, tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: true }],
    };
    const ctx = tdsCtx(op, { deducteeFiledReturn: (p) => p === partyA });
    const out = run(ctx, [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const late = ofCheck(out, "tds_late_deducted");
    expect(late).toHaveLength(1);
    expect(late[0].schedule).toBeUndefined();
    expect(late[0].detail).toContain("proviso");
  });
});

describe("TDS master-gap findings", () => {
  it("flags a deductee without a PAN as a review-only master gap, once per party", () => {
    const ctx = tdsCtx(stdOperator, { panKeyOf: () => null, entityOf: () => null });
    const out = run(ctx, [], [{
      ledger: expenseLedger,
      rows: [row("20250510", "P/12", 250000, partyA), row("20250610", "P/13", 100000, partyA)],
    }]);
    const gaps = ofCheck(out, "tds_master_gap").filter((f) => f.deductee === partyA);
    expect(gaps).toEqual([expect.objectContaining({ severity: "review", section: "194C" })]);
    expect(out.findings.filter((f) => f.check === "tds_master_gap").length).toBe(1);
  });

  it("never flags a missing or Unknown deductee type (the PAN is the authority)", () => {
    // No PAN at all: the old engine raised both a no-PAN gap and a
    // deductee-type finding; only the no-PAN gap may remain (item 8).
    const ctx = tdsCtx(stdOperator, { panKeyOf: () => null, entityOf: () => null });
    const out = run(ctx, [], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(out.findings.filter((f) => f.detail.toLowerCase().includes("deductee type"))).toEqual([]);
  });

  it("flags a duty ledger whose section is not mapped", () => {
    const ctx = tdsCtx({
      ...stdOperator,
      sections: [{ ledger: expenseLedger, section: "194C" }],
    }, {
      dutySectionOf: (l) => (l === "TDS Salary Unknown" ? null : "194C"),
    });
    const out = run(ctx, [{ ledger: "TDS Salary Unknown", rows: [] }], []);
    const gaps = ofCheck(out, "tds_master_gap").filter((f) => f.detail.includes("TDS Salary Unknown"));
    expect(gaps).toEqual([expect.objectContaining({ severity: "review" })]);
  });

  it("names the cross month and the whole-year or 194Q-only rule as tds_threshold_crossed", () => {
    const out = run(tdsCtx(), [], [{
      ledger: expenseLedger,
      rows: [1, 2, 3, 4, 5, 6].map((i) => row(`2025051${i}`, `P/${i}`, 20000, partyA)),
    }]);
    const found = ofCheck(out, "tds_threshold_crossed");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("whole year");
    expect(found[0].severity).toBe("review");
  });
});

describe("section attribution from the expense ledger (revision 2)", () => {
  it("(a) exactly one mapped section wins", () => {
    const out = run(tdsCtx(), [],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(out.events.bookings[0]).toMatchObject({ section: "194C", candidates: [] });
  });

  it("(b) zero mappings: no liability, no interest, no section total, one tds_section_unknown", () => {
    const op: OperatorFile = { ...EMPTY_TDS_OPERATOR };
    const out = run(tdsCtx(op), [], [
      { ledger: "Unmapped Ledger", rows: [row("20250510", "P/12", 250000, partyA)] },
    ]);
    expect(out.events.bookings[0]).toMatchObject({ section: null, candidates: [] });
    const unknown = ofCheck(out, "tds_section_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].detail).toContain("no section in the operator file");
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_late_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_late_deposit")).toEqual([]);
    expect(out.totals.bySection).toEqual([]);
  });

  it("(c) two mappings: { null, candidates } and a check-11 variant naming both law keys", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Rent - Mixed", section: "194-I(a)" },
        { ledger: "Rent - Mixed", section: "194-I(b)" },
      ],
    };
    const out = run(tdsCtx(op), [], [
      { ledger: "Rent - Mixed", rows: [row("20250510", "P/12", 250000, partyA)] }],
    []);
    expect(out.events.bookings[0]).toMatchObject({ section: null, candidates: ["194-I(a)", "194-I(b)"] });
    const unknown = ofCheck(out, "tds_section_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].detail).toContain("more than one section (194-I(a), 194-I(b))");
    expect(unknown[0].detail).toContain("Split the ledger per section");
  });

  it("(d) the resolver sees no party: a party declaring nothing still resolves from the ledger", () => {
    // One-argument signature by type; simulate the party carrying no facts.
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: expenseLedger, section: "194C" }],
    };
    // Compile-level guarantee: ctx.resolveSection takes one argument.
    const out = run(tdsCtx(op), [], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(out.events.bookings[0].section).toBe("194C");
  });

  it("(e) payments carry no section and still feed the earlier-of timing rule", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }], [
      { ledger: partyA, rows: [{ ...row("20250420", "P/03", 250000, "Bank Alpha") }] },
    ]);
    const late = ofCheck(out, "tds_late_deducted");
    expect(late[0].schedule?.[0].from).toBe("20250420");
  });

  it("(f) a duty ledger with two mappings is skipped and parts the master-gap finding", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: dutyLedger, section: "194-I(a)" },
        { ledger: dutyLedger, section: "194-I(b)" },
      ],
    };
    const out = run(tdsCtx(op), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], []);
    expect(out.events.deductions).toEqual([]);
    const gaps = ofCheck(out, "tds_master_gap").filter((f) => f.deductee === dutyLedger);
    expect(gaps).toEqual([expect.objectContaining({ severity: "review", section: null })]);
  });

  it("(g) a party marked N produces no events and no findings where Y would", () => {
    const rows = [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }];
    const duty = [{ ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] }];
    // Session-level filters model tdsParties; at the engine the party is
    // simply absent from tdsParties when the operator says N.
    const withY = run(tdsCtx(), duty, rows);
    expect(withY.events.bookings).toHaveLength(1);
    expect(withY.events.deductions).toHaveLength(1);
    const ctxN = tdsCtx(stdOperator, { tdsParties: [partyB] });
    const withN = run(ctxN, duty, rows);
    expect(withN.events.bookings).toHaveLength(0);
    expect(withN.events.payments).toHaveLength(0);
    expect(withN.findings.filter((f) => f.deductee === partyA)).toHaveLength(0);
  });

  it("(i) 194C(6) suppresses on a 194C booking with no section on the party row", () => {
    const ctx = tdsCtx(stdOperator, { transporterDeclared: (p) => p === partyA });
    const out = run(ctx, [], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(out.totals.notDeducted).toBe(0);
    const found = ofCheck(out, "tds_not_deducted");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("review");
    expect(found[0].amount).toBe(0);
    expect(found[0].detail).toContain("194C(6)");
  });

  it("(j) one party booked to a 194C ledger and a 194-I(b) ledger yields two aggregates", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Site Repairs Contract", section: "194C" },
        { ledger: "Rent - Office", section: "194-I(b)" },
      ],
    };
    const out = run(tdsCtx(op), [], [
      { ledger: "Site Repairs Contract", rows: [row("20250510", "P/12", 250000, partyA)] },
      {
        ledger: "Rent - Office",
        rows: [row("20250610", "P/13", 100000, partyA), row("20250710", "P/14", 600000, partyA)],
      },
    ]);
    const bySection = out.totals.bySection;
    expect(bySection.find((t) => t.section === "194C")?.gross).toBe(250000);
    expect(bySection.find((t) => t.section === "194-I(b)")?.gross).toBe(700000);
    // And each booking is critical on its own section threshold: the contract
    // on the 194C aggregate, the rent on its own per-month threshold (the
    // year 7,00,000 exceeds the 50,000 x 12 cap so the monthly rule is live
    // — 2026-09-26k) — separate buckets, point 5 end to end.
    const notDeducted = ofCheck(out, "tds_not_deducted");
    expect(notDeducted.map((f) => f.section)).toEqual(["194C", "194-I(b)", "194-I(b)"]);
  });
});

describe("2026-09-26 addendum regressions", () => {
  const splitVoucher: VoucherRow = {
    date: "20250612",
    voucherType: "Journal",
    voucherNumber: "JV/0007",
    partyLedgerName: partyA,
    cancelled: false,
    entries: [
      { ledger: expenseLedger, amount: 90000 },
      { ledger: partyA, amount: -88000 },
      { ledger: dutyLedger, amount: -2000 },
    ],
  };

  it("joins a deduction carried on the same voucher (duty line attributed to the voucher's party)", () => {
    // Item 7: `Dr Expense / Cr Party (net) / Cr TDS` — the TDS credit's
    // counterparty used to resolve to the expense line, so the deduction
    // never joined its booking and every such voucher read as not deducted.
    const rows = projectLedgerRows([splitVoucher], [expenseLedger, partyA, dutyLedger], {
      isDutyLedger: (n) => n === dutyLedger,
      isPartyLedger: (n) => n === partyA,
    });
    const pick = (l: string) => rows.find((r) => r.ledger === l) ?? { ledger: l, rows: [] };
    const out = run(tdsCtx(), [pick(dutyLedger)], [pick(expenseLedger)], [pick(partyA)]);
    expect(out.events.deductions).toEqual([
      expect.objectContaining({ party: partyA, section: "194C", tax: 2000 }),
    ]);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
  });

  it("labels statement findings with the quarter, never the first party", () => {
    const op: OperatorFile = { ...stdOperator, statements: [] };
    const out = run(tdsCtx(op), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const missing = ofCheck(out, "tds_statement_missing");
    expect(missing.length).toBeGreaterThan(0);
    for (const f of missing) {
      expect(["statement Q1", "statement Q2", "statement Q3", "statement Q4"]).toContain(f.deductee);
      expect(f.deductee).not.toBe(partyA);
    }
  });

  it("leaves exposures without a deductee (fleet-level, not a party)", () => {
    const out = run(tdsCtx(), [], [
      { ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] },
    ]);
    for (const f of ofCheck(out, "tds_exposure_40a_ia")) expect(f.deductee).toBe("");
    for (const f of ofCheck(out, "tds_exposure_271c")) expect(f.deductee).toBe("");
  });

  it("raises no no-PAN gap for a party whose bookings never made TDS due", () => {
    // Item 4: 20,000 total stays below the 30,000 single and 1,00,000
    // aggregate 194C thresholds — no liability, no deduction, no finding.
    const ctx = tdsCtx(stdOperator, { panKeyOf: () => null, entityOf: () => null });
    const out = run(ctx, [], [
      { ledger: expenseLedger, rows: [row("20250510", "P/12", 20000, partyA)] },
    ]);
    expect(out.findings.filter((f) => f.check === "tds_master_gap")).toEqual([]);
  });

  it("emits one no-PAN gap per party+section, each with its own gross", () => {
    // Item 5: two sections under one PAN-less party used to collapse into a
    // single finding labelled with the earliest section.
    const feesLedger = "Professional Fees";
    const op: OperatorFile = {
      ...stdOperator,
      sections: [
        { ledger: expenseLedger, section: "194C" },
        { ledger: feesLedger, section: "194J" },
      ],
    };
    const ctx = tdsCtx(op, { panKeyOf: () => null, entityOf: () => null });
    const out = run(ctx, [], [
      { ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] },
      { ledger: feesLedger, rows: [row("20250610", "P/13", 94000, partyA)] },
    ]);
    const gaps = ofCheck(out, "tds_master_gap").filter((f) => f.deductee === partyA);
    expect(gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "194C", amount: 250000 }),
        expect.objectContaining({ section: "194J", amount: 94000 }),
      ]),
    );
    expect(gaps).toHaveLength(2);
  });

  it("adds a short deduction's shortfall to the s.271C exposure", () => {
    // Item 6: s.271C covers failure to deduct whole or part. 3,000 deducted
    // against a 5,000 liability leaves a 2,000 shortfall on its own.
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250628", "P/12", -3000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(ofCheck(out, "tds_exposure_271c")[0].amount).toBe(2000);
  });

  it("rates 194C at 1% for an individual deductee (PAN 4th char P)", () => {
    const ctx = tdsCtx(stdOperator, { entityOf: () => "P" });
    const out = run(ctx, [], [
      { ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] },
    ]);
    expect(ofCheck(out, "tds_not_deducted")[0].amount).toBe(2500);
  });

  it("rates 194C at the standard 2% for an AOP (PAN 4th char A beyond P/H/C/F)", () => {
    const ctx = tdsCtx(stdOperator, { entityOf: () => "A" });
    const out = run(ctx, [], [
      { ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] },
    ]);
    expect(ofCheck(out, "tds_not_deducted")[0].amount).toBe(5000);
  });
});

describe("2026-09-26c regressions", () => {
  // Fictional stand-ins for the live defect: a voucher carrying a 194C
  // expense line and a 194Q duty credit used to let the 194Q credit claim the
  // 194C booking, which then rejected it at the analysis `find` (section
  // pinned) — two TDS-001 findings, the credit gone from the deposit chain.
  it("a same-voucher duty credit of another section never claims the booking", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: expenseLedger, section: "194C" },
        { ledger: "Steel Purchases", section: "194Q" },
        { ledger: "TDS Purchase", section: "194Q" },
      ],
    };
    const duty = [
      {
        ledger: dutyLedger,
        rows: [row("20250410", "P/410", -3000, partyA)], // the April 194C booking's own credit
      },
      {
        ledger: "TDS Purchase",
        rows: [
          row("20250831", "JV/9001", -1183, partyA),
          row("20250415", "P/400", -6000, partyA), // the April 194Q booking's own credit
        ],
      },
    ];
    const expense = [
      { ledger: expenseLedger, rows: [row("20250831", "JV/9001", 5976, partyA)] },
      { ledger: "Steel Purchases", rows: [row("20250831", "JV/9001", 458160, partyA)] },
      // an earlier 194C booking crosses the 1L aggregate so the later one is liable
      { ledger: expenseLedger, rows: [row("20250410", "P/410", 150000, partyA)] },
      // an earlier 194Q booking crosses the 50L aggregate so the later one is liable
      { ledger: "Steel Purchases", rows: [row("20250415", "P/400", 6_000_000, partyA)] },
    ];
    const out = run(tdsCtx(op), duty, expense);
    const ded = out.events.deductions.find((d) => d.section === "194Q" && d.voucherNumber === "JV/9001");
    expect(ded).toBeDefined();
    expect(ded?.booking?.voucherNumber).toBe("JV/9001");
    expect(ded?.booking?.ledger).toBe("Steel Purchases");
    const nd = ofCheck(out, "tds_not_deducted");
    expect(nd.map((f) => f.section)).toEqual(["194C"]);
    // the credit is back in the deposit chain: no deposit debit exists for it
    const ndep = ofCheck(out, "tds_not_deposited");
    expect(ndep.some((f) => f.section === "194Q" && f.amount === 1183)).toBe(true);
  });

  it("(2a) an ambiguous duty ledger resolves from the same voucher's expense line (three-line shape)", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Rent", section: "194-I(a)" },
        { ledger: "TDS Rent", section: "194-I(b)" },
      ],
    };
    const duty = [
      {
        ledger: "TDS Rent",
        rows: [
          row("20250610", "JV/8001", -1200, partyA), // Dr Expense / Cr Party net / Cr Duty
          row("20250731", "JV/8002", 1200, ""),      // deposit debit, no expense evidence
        ],
      },
    ];
    const expense = [
      { ledger: "Machinery Rent", rows: [row("20250610", "JV/8001", 60000, partyA)] },
    ];
    const out = run(tdsCtx(op), duty, expense);
    expect(out.events.deductions).toHaveLength(1);
    expect(out.events.deductions[0].section).toBe("194-I(a)");
    expect(out.events.deductions[0].ledger).toBe("TDS Rent");
    // the deposit carries no section, only its ledger
    expect(out.events.deposits).toHaveLength(1);
    expect(out.events.deposits[0].section).toBeNull();
    expect(out.events.deposits[0].ledger).toBe("TDS Rent");
    // the ledger-level diagnostic still fires once for the ambiguous mapping
    expect(ofCheck(out, "tds_master_gap").some((f) => f.deductee === "TDS Rent")).toBe(true);
  });

  it("(2b) a two-line journal resolves from the linked same-date bill and joins it", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Rent", section: "194-I(a)" },
        { ledger: "TDS Rent", section: "194-I(b)" },
      ],
    };
    const duty = [
      {
        ledger: "TDS Rent",
        rows: [row("20250610", "J/1", -1200, partyA)], // Dr Party / Cr Duty journal
      },
    ];
    const expense = [
      // the bill, booked the same day: Dr Machinery Rent / Cr Party
      { ledger: "Machinery Rent", rows: [row("20250610", "B/1", 60000, partyA)] },
    ];
    const out = run(tdsCtx(op), duty, expense);
    expect(out.events.deductions).toHaveLength(1);
    expect(out.events.deductions[0].section).toBe("194-I(a)");
    // the month's total (60000) crosses 50000, so the booking is liable and
    // the journal credit joins it by month-window: no TDS-001
    expect(ofCheck(out, "tds_not_deducted")).toHaveLength(0);
    // and the journal deposit shape: a same-ledger section-less deposit satisfies the credit
    const dutyWithDeposit = [
      {
        ledger: "TDS Rent",
        rows: [row("20250610", "J/1", -1200, partyA), row("20250815", "J/2", 1200, "")],
      },
    ];
    const out2 = run(tdsCtx(op), dutyWithDeposit, expense);
    expect(ofCheck(out2, "tds_not_deposited")).toHaveLength(0);
  });

  it("(2c) two same-voucher expense lines of both sections leave the credit unresolved (never guessed)", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "Building Rent", section: "194-I(b)" },
        { ledger: "TDS Rent", section: "194-I(a)" },
        { ledger: "TDS Rent", section: "194-I(b)" },
      ],
    };
    const duty = [
      { ledger: "TDS Rent", rows: [row("20250610", "JV/8001", -1200, partyA)] },
    ];
    const expense = [
      { ledger: "Machinery Rent", rows: [row("20250610", "JV/8001", 30000, partyA)] },
      { ledger: "Building Rent", rows: [row("20250610", "JV/8001", 30000, partyA)] },
    ];
    const out = run(tdsCtx(op), duty, expense);
    expect(out.events.deductions).toHaveLength(0);
    expect(ofCheck(out, "tds_master_gap").some((f) => f.deductee === "TDS Rent")).toBe(true);
  });

  it("(2d) expense evidence outside the duty ledger's own candidates does not resolve", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Site Repairs Contract", section: "194C" },
        { ledger: "TDS Rent", section: "194-I(a)" },
        { ledger: "TDS Rent", section: "194-I(b)" },
      ],
    };
    const duty = [{ ledger: "TDS Rent", rows: [row("20250610", "JV/8001", -1200, partyA)] }];
    const expense = [{ ledger: expenseLedger, rows: [row("20250610", "JV/8001", 60000, partyA)] }];
    const out = run(tdsCtx(op), duty, expense);
    expect(out.events.deductions).toHaveLength(0);
  });

  it("(3) the 194-I aggregate threshold (600,000) makes the crossed year's whole bookings liable", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Machinery Rent", section: "194-I(a)" }],
    };
    const expense = [
      {
        ledger: "Machinery Rent",
        rows: [
          row("20250510", "P/21", 200000, partyA),
          row("20250605", "P/31", 200000, partyA),
          row("20250620", "P/32", 250000, partyA), // 650000 > 600000 crosses
        ],
      },
    ];
    const out = run(tdsCtx(op), [], expense);
    const nd = ofCheck(out, "tds_not_deducted");
    expect(nd.map((f) => f.section)).toEqual(["194-I(a)", "194-I(a)", "194-I(a)"]);
    expect(nd.map((f) => f.amount)).toEqual([4000, 4000, 5000]); // 2% x 200000, 2% x 200000, 2% x 250000
    const crossed = ofCheck(out, "tds_threshold_crossed");
    expect(crossed).toHaveLength(1);
    expect(crossed[0].detail).toContain("the whole year's amounts are liable");
  });
});

describe("2026-09-26d party-month coverage", () => {
  // Fictional stand-in for the live artifact: one journal credit covering a
  // whole party-month of 194-I(a) liability joined 1:1 to the first booking,
  // leaving its month-mates flagged TDS-001 although the party's month is
  // fully covered. The rule: resolved same-section credits ≥ the month's
  // whole liability ⇒ the month's remaining bookings are covered.
  it("a month's covered liability suppresses TDS-001 on its remaining bookings", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(a)" },
      ],
    };
    const expense = [
      {
        ledger: "Machinery Rent",
        rows: [
          row("20250510", "P/41", 400000, partyA), // month 750000 > perMonth 50000 → 8000
          row("20250520", "P/42", 350000, partyA), // → 7000
        ],
      },
    ];
    const duty = [
      {
        ledger: "TDS Machinery",
        rows: [row("20250525", "P/43", -15000, partyA)], // covers the month
      },
    ];
    const party = [
      {
        ledger: partyA,
        rows: [
          { ...row("20250510", "P/41", -400000, "Machinery Rent"), voucherType: "Purchase" },
          { ...row("20250520", "P/42", -350000, "Machinery Rent"), voucherType: "Purchase" },
        ],
      },
    ];
    const out = run(tdsCtx(op), duty, expense, party);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    // the deposit chain stays intact on the joined booking
    const dep = [
      { ledger: "TDS Machinery", rows: [row("20250610", "P/44", 15000, partyA)] },
    ];
    const out2 = run(tdsCtx(op), [...duty, ...dep], expense, party);
    expect(ofCheck(out2, "tds_not_deducted")).toEqual([]);
    expect(ofCheck(out2, "tds_not_deposited")).toEqual([]);
  });

  it("credits short of the month's liability leave the uncovered bookings flagged", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(a)" },
      ],
    };
    const expense = [
      {
        ledger: "Machinery Rent",
        rows: [
          row("20250510", "P/41", 400000, partyA),
          row("20250520", "P/42", 350000, partyA),
        ],
      },
    ];
    const duty = [
      { ledger: "TDS Machinery", rows: [row("20250525", "P/43", -8000, partyA)] },
    ];
    const party = [
      {
        ledger: partyA,
        rows: [
          { ...row("20250510", "P/41", -400000, "Machinery Rent"), voucherType: "Purchase" },
          { ...row("20250520", "P/42", -350000, "Machinery Rent"), voucherType: "Purchase" },
        ],
      },
    ];
    const out = run(tdsCtx(op), duty, expense, party);
    const nd = ofCheck(out, "tds_not_deducted");
    expect(nd).toHaveLength(1);
    expect(nd[0].amount).toBe(7000);
    expect(nd[0].section).toBe("194-I(a)");
  });

  it("unresolved (null-section) duty credits never cover a month", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Ambiguous", section: "194-I(a)" },
        { ledger: "TDS Ambiguous", section: "194-I(b)" },
      ],
    };
    const expense = [
      {
        ledger: "Machinery Rent",
        rows: [
          row("20250510", "P/41", 400000, partyA), // month 700000 > perMonth 50000
          row("20250520", "P/42", 300000, partyA), // → 8000 + 6000 liable
        ],
      },
    ];
    const duty = [
      // Dated beyond the nearest-bill cap from the May bills (2026-09-26f):
      // the credit stays unresolved — never covered, never joined.
      { ledger: "TDS Ambiguous", rows: [row("20250715", "JV/91", -8000, partyA)] },
    ];
    const party = [
      {
        ledger: partyA,
        rows: [
          { ...row("20250510", "P/41", -400000, "Machinery Rent"), voucherType: "Purchase" },
          { ...row("20250520", "P/42", -300000, "Machinery Rent"), voucherType: "Purchase" },
        ],
      },
    ];
    const out = run(tdsCtx(op), duty, expense, party);
    // the credit is unresolved → ledger-level TDS-012 and no coverage
    expect(ofCheck(out, "tds_not_deducted")).toHaveLength(2);
    expect(ofCheck(out, "tds_master_gap")).toHaveLength(1);
  });
});

describe("2026-09-26e/f deposit coverage + nearest bill", () => {
  // Two-line journal `Dr party / Cr duty` dated days AFTER its charge bill —
  // the shape the captain confirmed in Tally (26f). The resolver's same-date
  // path finds nothing; the strictly additive nearest-bill fallback links the
  // same month's bill whose expense ledger resolves inside the candidates.
  it("a different-date journal resolves via the nearest-bill fallback and joins", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(b)" },
      ],
    };
    const expense = [{ ledger: "Machinery Rent", rows: [row("20250529", "B/1", 60000, partyA)] }];
    const duty = [{ ledger: "TDS Machinery", rows: [row("20250531", "J/2", -1200, partyA)] }];
    const party = [{ ledger: partyA, rows: [{ ...row("20250529", "B/1", -60000, "Machinery Rent"), voucherType: "Purchase" }] }];
    const out = run(tdsCtx(op), duty, expense, party);
    expect(out.events.deductions).toHaveLength(1);
    expect(out.events.deductions[0].section).toBe("194-I(a)");
    expect(out.events.deductions[0].resolvedBy).toBe("nearest bill, 2 days");
    expect(out.events.deductions[0].linkedBill).toBe("20250529|B/1");
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    // the null-section lump deposit joins the same-ledger deduction (26c)
    const dep = [{ ledger: "TDS Machinery", rows: [row("20250610", "P/44", 1200, "Bank A/c")] }];
    const out2 = run(tdsCtx(op), [...duty, ...dep], expense, party);
    expect(ofCheck(out2, "tds_not_deposited")).toEqual([]);
  });

  it("a journal beyond the 15-day cap stays unresolved", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(b)" },
      ],
    };
    const expense = [{ ledger: "Machinery Rent", rows: [row("20250510", "B/1", 60000, partyA)] }];
    const duty = [{ ledger: "TDS Machinery", rows: [row("20250610", "J/2", -1200, partyA)] }];
    const party = [{ ledger: partyA, rows: [{ ...row("20250510", "B/1", -60000, "Machinery Rent"), voucherType: "Purchase" }] }];
    const out = run(tdsCtx(op), duty, expense, party);
    expect(out.events.deductions).toHaveLength(0);
    expect(ofCheck(out, "tds_master_gap")).toHaveLength(1);
  });

  it("a bill whose section sits outside the candidates never resolves the journal", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Site Repairs", section: "194C" },
        { ledger: "TDS Machinery", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(b)" },
      ],
    };
    const expense = [{ ledger: "Site Repairs", rows: [row("20250529", "B/1", 60000, partyA)] }];
    const duty = [{ ledger: "TDS Machinery", rows: [row("20250531", "J/2", -1200, partyA)] }];
    const party = [{ ledger: partyA, rows: [{ ...row("20250529", "B/1", -60000, "Site Repairs"), voucherType: "Purchase" }] }];
    const out = run(tdsCtx(op), duty, expense, party);
    expect(out.events.deductions).toHaveLength(0);
    expect(ofCheck(out, "tds_master_gap")).toHaveLength(1);
  });

  it("the same-date bill path still wins and is recorded as such", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(b)" },
      ],
    };
    const expense = [{ ledger: "Machinery Rent", rows: [row("20250529", "B/1", 60000, partyA)] }];
    const duty = [{ ledger: "TDS Machinery", rows: [row("20250529", "J/1", -1200, partyA)] }];
    const party = [{ ledger: partyA, rows: [{ ...row("20250529", "B/1", -60000, "Machinery Rent"), voucherType: "Purchase" }] }];
    const out = run(tdsCtx(op), duty, expense, party);
    expect(out.events.deductions).toHaveLength(1);
    expect(out.events.deductions[0].resolvedBy).toBe("same-date bill");
    expect(out.events.deductions[0].linkedBill).toBe("20250529|B/1");
  });

  // Month-level deposit coverage (2026-09-26e): lump challan debits on the
  // duty ledger (counterparty = the bank, never the deductee) cover every
  // deductee's uncovered deductions of that pool+month when the pool reaches
  // the month's need; the Rule 30 window runs to the end of the next month.
  const covOp: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: "Machinery Rent", section: "194-I(a)" },
      { ledger: "TDS Machinery", section: "194-I(a)" },
    ],
  };
  const covExpense = [
    {
      ledger: "Machinery Rent",
      rows: [row("20250510", "P/41", 400000, partyA), row("20250520", "P/42", 350000, partyA)],
    },
  ];
  const covParty = [
    {
      ledger: partyA,
      rows: [
        { ...row("20250510", "P/41", -400000, "Machinery Rent"), voucherType: "Purchase" },
        { ...row("20250520", "P/42", -350000, "Machinery Rent"), voucherType: "Purchase" },
      ],
    },
  ];
  const covDuty = [
    {
      ledger: "TDS Machinery",
      rows: [row("20250521", "P/43", -7500, partyA), row("20250525", "P/45", -7500, partyA)],
    },
  ];

  it("a lump deposit covering the month's deductions suppresses tds_not_deposited", () => {
    const dep = [{ ledger: "TDS Machinery", rows: [row("20250530", "P/47", 50000, "Bank A/c")] }];
    const out = run(tdsCtx(covOp), [...covDuty, ...dep], covExpense, covParty);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
    expect(out.events.deductions.every((d) => d.depositCovered)).toBe(true);
  });

  it("an uncovered remainder still fires tds_not_deposited", () => {
    const dep = [{ ledger: "TDS Machinery", rows: [row("20250530", "P/47", 10000, "Bank A/c")] }];
    const out = run(tdsCtx(covOp), [...covDuty, ...dep], covExpense, covParty);
    expect(ofCheck(out, "tds_not_deposited")).toHaveLength(2);
    expect(out.events.deductions.every((d) => !d.depositCovered)).toBe(true);
  });

  it("a deposit in the next month still covers the earlier month's window", () => {
    const dep = [{ ledger: "TDS Machinery", rows: [row("20250615", "P/47", 50000, "Bank A/c")] }];
    const out = run(tdsCtx(covOp), [...covDuty, ...dep], covExpense, covParty);
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
  });

  it("a deposit beyond the Rule 30 window never covers the month", () => {
    const dep = [{ ledger: "TDS Machinery", rows: [row("20250715", "P/47", 50000, "Bank A/c")] }];
    const out = run(tdsCtx(covOp), [...covDuty, ...dep], covExpense, covParty);
    expect(ofCheck(out, "tds_not_deposited")).toHaveLength(2);
  });
});

describe("2026-09-26e pool keys", () => {
  // A resolved credit from an ambiguous duty ledger pools by LEDGER: its
  // deposits are null-section rows on the same ledger and can never meet a
  // section-keyed pool (the 20260926c creditor regression).
  it("an ambiguous ledger's lump deposits cover its resolved credits", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Machinery Rent", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(a)" },
        { ledger: "TDS Machinery", section: "194-I(b)" },
      ],
    };
    const expense = [{ ledger: "Machinery Rent", rows: [row("20250529", "B/1", 950000, partyA)] }];
    const duty = [
      {
        ledger: "TDS Machinery",
        rows: [
          row("20250531", "J/2", -19000, partyA),
          { ...row("20250530", "P/47", 50000, "Bank A/c"), voucherType: "Payment" },
        ],
      },
    ];
    const party = [{ ledger: partyA, rows: [{ ...row("20250529", "B/1", -950000, "Machinery Rent"), voucherType: "Purchase" }] }];
    const out = run(tdsCtx(op), duty, expense, party);
    expect(out.events.deductions[0].depositCovered).toBe(true);
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
  });
});

describe("2026-09-26g join amount-tiebreak", () => {
  // The Apr–Sep creditor shape (§11.2): two same-date bills (9,50,000 and
  // 3,30,000 → liabilities 19,000 and 6,600 at 2%) and two same-date credits
  // (19,000 and 6,600). The nearest-date rule paired them amount-blind
  // (19,000→3,30,000, 6,600→9,50,000), reading every large bill short; the
  // amount-tiebreak pairs 19,000→9,50,000 and 6,600→3,30,000.
  const gOp: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [{ ledger: "Machinery Rent", section: "194-I(a)" }, { ledger: "TDS Machinery", section: "194-I(a)" }],
  };
  const gExpense = [
    {
      ledger: "Machinery Rent",
      rows: [row("20250430", "B/8", 950000, partyA), row("20250430", "B/9", 330000, partyA)],
    },
  ];
  const gDuty = [
    {
      ledger: "TDS Machinery",
      rows: [row("20250430", "J/1", -19000, partyA), row("20250430", "J/2", -6600, partyA)],
    },
  ];
  const gParty = [
    {
      ledger: partyA,
      rows: [
        { ...row("20250430", "B/8", -950000, "Machinery Rent"), voucherType: "Purchase" },
        { ...row("20250430", "B/9", -330000, "Machinery Rent"), voucherType: "Purchase" },
      ],
    },
  ];

  it("the amount-matching candidate wins the month-window join on same-date ties", () => {
    const out = run(tdsCtx(gOp), gDuty, gExpense, gParty);
    const j19 = out.events.deductions.find((d) => d.tax === 19000)!;
    const j66 = out.events.deductions.find((d) => d.tax === 6600)!;
    expect(j19.booking?.gross).toBe(950000);
    expect(j66.booking?.gross).toBe(330000);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_short_deducted")).toEqual([]);
  });

  it("a booking with no amount-matching candidate keeps the nearest-date rule", () => {
    // One bill (9,50,000 → 19,000 liability) but only a 6,600 credit nearby:
    // the nearest-date fallback joins it and the booking reads short.
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Machinery Rent", section: "194-I(a)" }, { ledger: "TDS Machinery", section: "194-I(a)" }],
    };
    const expense = [{ ledger: "Machinery Rent", rows: [row("20250430", "B/8", 950000, partyA)] }];
    const duty = [{ ledger: "TDS Machinery", rows: [row("20250430", "J/2", -6600, partyA)] }];
    const party = [{ ledger: partyA, rows: [{ ...row("20250430", "B/8", -950000, "Machinery Rent"), voucherType: "Purchase" }] }];
    const out = run(tdsCtx(op), duty, expense, party);
    expect(out.events.deductions[0].booking?.gross).toBe(950000);
    expect(ofCheck(out, "tds_short_deducted")).toHaveLength(1);
  });
});

describe("2026-09-26g by-voucher amount-tiebreak", () => {
  // The live shape: the 19,000 and 6,600 journals are SEPARATE vouchers that
  // each share their bill's date, so phase 1 pairs them amount-blind within
  // one voucher-number group... no — they pair through the month-window;
  // the regression pins the actual join path: credits J/1 (19,000) and J/2
  // (6,600), bills B/8 (9,50,000 → 19,000) and B/9 (3,30,000 → 6,600), all
  // same date. The amount-matching credit must win the pairing.
  it("same-day separate journals pair by amount, not by discovery order", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Machinery Rent", section: "194-I(a)" }, { ledger: "TDS Machinery", section: "194-I(a)" }],
    };
    const expense = [
      {
        ledger: "Machinery Rent",
        rows: [row("20250430", "B/8", 950000, partyA), row("20250430", "B/9", 330000, partyA)],
      },
    ];
    const duty = [
      {
        ledger: "TDS Machinery",
        rows: [row("20250430", "J/1", -19000, partyA), row("20250430", "J/2", -6600, partyA)],
      },
    ];
    const party = [
      {
        ledger: partyA,
        rows: [
          { ...row("20250430", "B/8", -950000, "Machinery Rent"), voucherType: "Purchase" },
          { ...row("20250430", "B/9", -330000, "Machinery Rent"), voucherType: "Purchase" },
        ],
      },
    ];
    const out = run(tdsCtx(op), duty, expense, party);
    const j19 = out.events.deductions.find((d) => d.tax === 19000)!;
    const j66 = out.events.deductions.find((d) => d.tax === 6600)!;
    expect(j19.booking?.gross).toBe(950000);
    expect(j66.booking?.gross).toBe(330000);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_short_deducted")).toEqual([]);
  });

  it("a liability-matching credit inside the booking's own voucher wins over the first-found credit", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Machinery Rent", section: "194-I(a)" }, { ledger: "TDS Machinery", section: "194-I(a)" }],
    };
    const expense = [{ ledger: "Machinery Rent", rows: [row("20250430", "B/8", 950000, partyA)] }];
    const duty = [
      {
        ledger: "TDS Machinery",
        rows: [row("20250430", "B/8", -6600, partyA), row("20250430", "J/1", -19000, partyA)],
      },
    ];
    const party = [{ ledger: partyA, rows: [{ ...row("20250430", "B/8", -950000, "Machinery Rent"), voucherType: "Purchase" }] }];
    const out = run(tdsCtx(op), duty, expense, party);
    expect(out.events.deductions.find((d) => d.tax === 19000)!.booking?.gross).toBe(950000);
    expect(ofCheck(out, "tds_short_deducted")).toEqual([]); // the 19,000 credit covers the whole liability
    // the 6,600 credit is not paired with any booking; with no deposit it is not a non-deposit either
    expect(out.events.deductions.find((d) => d.tax === 6600)!.booking).toBeUndefined();
  });
});

describe("2026-09-26m 194-I aggregate threshold + 194Q month matching", () => {
  const rentOp: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [{ ledger: "Machinery Rent", section: "194-I(a)" }],
  };

  it("rent for the year at or below 6,00,000 means no TDS liability for that party", () => {
    // Captain's instruction (Addendum 26m): FY aggregate threshold ₹6,00,000.
    // Below or at 6,00,000, nothing is liable and nothing crosses.
    const expense = [
      {
        ledger: "Machinery Rent",
        rows: [
          row("20250510", "P/21", 250000, partyA),
          row("20251003", "J/31", 350000, partyA), // exactly 6,00,000
        ],
      },
    ];
    const out = run(tdsCtx(rentOp), [], expense);
    expect(ofCheck(out, "tds_threshold_crossed")).toEqual([]);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
  });

  it("rent for the year above 6,00,000 makes the party liable on the whole year", () => {
    // Exceeding ₹6,00,000 makes whole year liable.
    const expense = [
      {
        ledger: "Machinery Rent",
        rows: [
          row("20250510", "P/21", 300000, partyA),
          row("20250620", "P/32", 350000, partyA), // 650,000 > 600,000
        ],
      },
    ];
    const out = run(tdsCtx(rentOp), [], expense);
    const nd = ofCheck(out, "tds_not_deducted");
    expect(nd.map((f) => f.amount)).toEqual([6000, 7000]); // 2% of 300,000 and 350,000
    const crossed = ofCheck(out, "tds_threshold_crossed");
    expect(crossed).toHaveLength(1);
    expect(crossed[0].detail).toContain("crossed the threshold in 20-Jun-2025");
    expect(crossed[0].detail).toContain("the whole year's amounts are liable");
  });

  const qOp: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: "GST Purchase", section: "194Q" },
      { ledger: "TDS Purchase 194Q", section: "194Q" },
    ],
  };
  // January: the first voucher crosses the 50 lakh annual threshold (liable
  // base 1,00,000 -> 100), the second is wholly beyond it (10,00,000 ->
  // 1,000). The month's liability is 1,100.
  const qExpense = [
    {
      ledger: "GST Purchase",
      rows: [row("20260105", "B/1", 5100000, partyA), row("20260115", "B/2", 1000000, partyA)],
    },
  ];

  it("194Q: one month-end credit equal to the month's liability covers every voucher of the month", () => {
    const duty = [{ ledger: "TDS Purchase 194Q", rows: [row("20260131", "J/9", -1100, partyA)] }];
    const out = run(tdsCtx(qOp), duty, qExpense);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_short_deducted")).toEqual([]);
  });

  it("194Q: a month with no duty credit raises ONE finding for the month, not one per voucher", () => {
    const out = run(tdsCtx(qOp), [], qExpense);
    const nd = ofCheck(out, "tds_not_deducted");
    expect(nd).toHaveLength(1);
    expect(nd[0].amount).toBe(1100);
    expect(nd[0].detail).toContain("purchases of 61,00,000.00 for Jan-2026");
    expect(out.totals.notDeducted).toBe(1100);
  });

  it("194Q: partial month credits raise one short finding for the shortfall", () => {
    const duty = [{ ledger: "TDS Purchase 194Q", rows: [row("20260131", "J/9", -600, partyA), row("20260210", "J/10", 600, partyA)] }];
    const out = run(tdsCtx(qOp), duty, qExpense);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    const sh = ofCheck(out, "tds_short_deducted");
    expect(sh).toHaveLength(1);
    expect(sh[0].amount).toBe(500);
    expect(sh[0].detail).toContain("fall short");
    // The month's deducted 600 is covered by the 600 deposit debit, so the
    // 21(b) short row reports it as deposited: the review raises no 194Q
    // not_deposited, and the deducted tax was paid (2026-09-26 009).
    expect(out.clause21b).toHaveLength(1);
    expect(out.clause21b[0]).toMatchObject({
      section: "194Q",
      reason: "short_deducted",
      tdsDone: 600,
      tdsDeposited: 600,
    });
  });
});

describe("debit-note netting (2026-09-26o items 4/5)", () => {
  const debitNote = (date: string, voucher: string, amount: number, counterparty: string): LedgerVoucherRow => ({
    ...row(date, voucher, -amount, counterparty),
    voucherType: "Debit Note",
  });

  it("collects an expense-ledger credit from a TDS party as a reduction, never a booking", () => {
    const out = run(tdsCtx(), [], [
      { ledger: expenseLedger, rows: [debitNote("20250601", "DN/1", 250000, partyA)] },
    ]);
    expect(out.events.bookings).toEqual([]);
    expect(out.events.reductions).toEqual([
      expect.objectContaining({ date: "20250601", party: partyA, amount: 250000, section: "194C" }),
    ]);
  });

  it("a debit note that fully cancels a booking removes it — no liability", () => {
    const out = run(tdsCtx(), [], [
      {
        ledger: expenseLedger,
        rows: [
          row("20250510", "P/12", 250000, partyA),
          debitNote("20250601", "DN/1", 250000, partyA),
        ],
      },
    ]);
    expect(out.events.bookings).toEqual([]);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(out.totals.notDeducted).toBe(0);
  });

  it("a partial debit note nets the base before the rate is applied", () => {
    const out = run(tdsCtx(), [], [
      {
        ledger: expenseLedger,
        rows: [
          row("20250510", "P/12", 250000, partyA),
          debitNote("20250601", "DN/1", 100000, partyA),
        ],
      },
    ]);
    expect(out.events.bookings).toHaveLength(1);
    expect(out.events.bookings[0].gross).toBe(150000);
    const nd = ofCheck(out, "tds_not_deducted");
    expect(nd).toHaveLength(1);
    expect(nd[0].amount).toBe(3000); // 2% of the net 1,50,000
  });

  const qOp: OperatorFile = { ...EMPTY_TDS_OPERATOR, sections: [{ ledger: "GST Purchase", section: "194Q" }] };

  it("a note cancels the most recent still-open bill (LIFO), not an older one", () => {
    const out = run(tdsCtx(qOp), [], [
      {
        ledger: "GST Purchase",
        rows: [
          row("20260105", "B/1", 5100000, partyA), // crosses the 50L threshold; 1,00,000 liable -> 100
          row("20260115", "B/2", 1000000, partyA), // wholly beyond -> 1,000
          debitNote("20260120", "DN/1", 1000000, partyA), // cancels B/2, the most recent
        ],
      },
    ]);
    expect(out.events.bookings.map((b) => b.voucherNumber)).toEqual(["B/1"]);
    expect(out.totals.notDeducted).toBe(100);
  });

  it("an advance credit before any bill carries forward to the next booking", () => {
    const out = run(tdsCtx(), [], [
      {
        ledger: expenseLedger,
        rows: [
          debitNote("20250401", "DN/0", 50000, partyA),
          row("20250510", "P/12", 250000, partyA),
        ],
      },
    ]);
    expect(out.events.bookings).toHaveLength(1);
    expect(out.events.bookings[0].gross).toBe(200000);
    expect(ofCheck(out, "tds_not_deducted")[0].amount).toBe(4000);
  });

  it("nets a note on a different expense ledger of the same deductee and section", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: expenseLedger, section: "194C" },
        { ledger: "Other Works Contract", section: "194C" },
      ],
    };
    const out = run(tdsCtx(op), [], [
      { ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] },
      { ledger: "Other Works Contract", rows: [debitNote("20250601", "DN/1", 250000, partyA)] },
    ]);
    expect(out.events.bookings).toEqual([]);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
  });

  it("never nets across a different deductee or a different section", () => {
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: expenseLedger, section: "194C" },
        { ledger: "Other Works Contract", section: "194J" },
      ],
    };
    const outSection = run(tdsCtx(op), [], [
      { ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] },
      { ledger: "Other Works Contract", rows: [debitNote("20250601", "DN/1", 250000, partyA)] },
    ]);
    expect(outSection.events.bookings).toHaveLength(1);
    expect(outSection.events.bookings[0].gross).toBe(250000);
    expect(ofCheck(outSection, "tds_not_deducted")[0].amount).toBe(5000);

    const outParty = run(tdsCtx(), [], [
      { ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] },
      { ledger: expenseLedger, rows: [debitNote("20250601", "DN/1", 250000, partyB)] },
    ]);
    expect(outParty.events.bookings).toHaveLength(1);
    expect(outParty.events.bookings[0].gross).toBe(250000);
    expect(ofCheck(outParty, "tds_not_deducted")[0].amount).toBe(5000);
  });
});

describe("2026-09-26o item 035: 194T via the partners' remuneration duty ledger", () => {
  const remunLedger = "Partners Remuneration A/c";
  const duty194T = "TDS on Partners Remuneration- 194T";
  const partnerAcctA = "Partner Alpha Current A/c";
  const partnerAcctB = "Partner Beta Current A/c";
  const op194T: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: remunLedger, section: "194T" },
      { ledger: duty194T, section: "194T", kind: "duty" },
    ],
  };
  // The partners' Capital/Current accounts are not declared TDS parties: only
  // the operator's 194T expense mapping marks the liability.
  const ctx194T = (over: Partial<TdsCtx> = {}) => tdsCtx(op194T, { tdsParties: [], ...over });

  it("forms the 194T booking from a non-party counterparty, with no rate findings", () => {
    const out = run(
      ctx194T(),
      [{ ledger: duty194T, rows: [row("20260331", "R/1", -4000000, partnerAcctA)] }],
      [{ ledger: remunLedger, rows: [row("20260331", "R/1", 40000000, partnerAcctA)] }],
      [],
    );
    expect(out.events.bookings.map((b) => [b.party, b.section])).toEqual([[partnerAcctA, "194T"]]);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_short_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_threshold_crossed")).toEqual([]);
    expect(ofCheck(out, "tds_master_gap")).toEqual([]);
  });

  it("joins the deposit and reports its lateness (interest (ii))", () => {
    const out = run(
      ctx194T(),
      [
        {
          ledger: duty194T,
          rows: [
            row("20260331", "R/1", -4000000, partnerAcctA),
            row("20260515", "D/1", 4000000, "Bank"),
          ],
        },
      ],
      [{ ledger: remunLedger, rows: [row("20260331", "R/1", 40000000, partnerAcctA)] }],
      [],
    );
    const late = ofCheck(out, "tds_late_deposit");
    expect(late).toHaveLength(1);
    expect(late[0].section).toBe("194T");
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
  });

  it("still considers a credit whose counterparty differs, at section level", () => {
    const out = run(
      ctx194T(),
      [{ ledger: duty194T, rows: [row("20260331", "R/2", -1000000, partnerAcctB)] }],
      [{ ledger: remunLedger, rows: [row("20260331", "R/2", 10000000, partnerAcctA)] }],
      [],
    );
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
    expect(ofCheck(out, "tds_short_deducted")).toEqual([]);
    const nd = ofCheck(out, "tds_not_deposited");
    expect(nd).toHaveLength(1);
    expect(nd[0].section).toBe("194T");
    expect(nd[0].deductee).toBe(partnerAcctB);
    // s.40(a)(ia) exposure is 30% of the section's expenditure, added once.
    const exp = ofCheck(out, "tds_exposure_40a_ia");
    expect(exp).toHaveLength(1);
    expect(exp[0].amount).toBe(3000000);
  });

  it("is silent when the month pool covers the credit", () => {
    const out = run(
      ctx194T(),
      [
        {
          ledger: duty194T,
          rows: [
            row("20260331", "R/2", -1000000, partnerAcctB),
            row("20260420", "D/2", 1000000, "Bank"),
          ],
        },
      ],
      [{ ledger: remunLedger, rows: [row("20260331", "R/2", 10000000, partnerAcctA)] }],
      [],
    );
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
    expect(ofCheck(out, "tds_late_deposit")).toEqual([]);
  });
});

describe("2026-09-26o items 038/039: a lump 194T credit splits per partner", () => {
  const remunLedger = "Partners Remuneration A/c";
  const duty194T = "TDS on Partners Remuneration- 194T";
  const partnerAcctA = "Partner Alpha Current A/c";
  const partnerAcctB = "Partner Beta Current A/c";
  const op194T: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: remunLedger, section: "194T" },
      { ledger: duty194T, section: "194T", kind: "duty" },
    ],
  };
  const ctx194T = (over: Partial<TdsCtx> = {}) => tdsCtx(op194T, { tdsParties: [], ...over });
  // A lump duty credit carries the voucher's same-sign draws (the day-book
  // projection stamps them; the live report never does).
  const splitCredit = (date: string, voucher: string, tax: number, draws: Array<[string, number]>): LedgerVoucherRow => ({
    ...row(date, voucher, -tax, draws[0][0]),
    draws: draws.map(([ledger, amount]) => ({ ledger, amount })),
  });

  it("splits one credit into a deduction per partner draw", () => {
    const out = run(
      ctx194T(),
      [
        {
          ledger: duty194T,
          rows: [splitCredit("20260331", "R/1", 3000000, [[partnerAcctA, 1500000], [partnerAcctB, 1500000]])],
        },
      ],
      [{ ledger: remunLedger, rows: [row("20260331", "R/1", 40000000, partnerAcctA)] }],
      [],
    );
    const deds = out.events.deductions.filter((d) => d.section === "194T");
    expect(deds.map((d) => [d.party, d.tax])).toEqual([
      [partnerAcctA, 1500000],
      [partnerAcctB, 1500000],
    ]);
  });

  it("allocates a rounded remainder to the last draw", () => {
    const out = run(
      ctx194T(),
      [
        {
          ledger: duty194T,
          rows: [splitCredit("20260331", "R/1", 1000000, [[partnerAcctA, 333333.33], [partnerAcctB, 666666.67]])],
        },
      ],
      [],
      [],
    );
    const deds = out.events.deductions.filter((d) => d.section === "194T");
    expect(deds.reduce((s, d) => s + d.tax, 0)).toBe(1000000);
    expect(deds[1].tax).toBe(666666.67);
  });

  it("covers split credits with same-section subsequent-challan allocations (section-level, no party names)", () => {
    const out = run(
      ctx194T({
        subsequentDeposits: [
          // Undeclared Winman names: the engine matches a timing-only section
          // by section + month + tax alone.
          { party: "Winman Alpha", section: "194T", tax: 1500000, dedDate: "20260331", depositDate: "20260430" },
          { party: "Winman Beta", section: "194T", tax: 1500000, dedDate: "20260331", depositDate: "20260430" },
        ],
      }),
      [
        {
          ledger: duty194T,
          rows: [splitCredit("20260331", "R/1", 3000000, [[partnerAcctA, 1500000], [partnerAcctB, 1500000]])],
        },
      ],
      [{ ledger: remunLedger, rows: [row("20260331", "R/1", 40000000, partnerAcctA)] }],
      [],
    );
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
  });

  it("leaves an uncovered second credit genuinely not deposited", () => {
    const out = run(
      ctx194T({
        subsequentDeposits: [
          { party: "Winman Alpha", section: "194T", tax: 1500000, dedDate: "20260331", depositDate: "20260430" },
          { party: "Winman Beta", section: "194T", tax: 1500000, dedDate: "20260331", depositDate: "20260430" },
        ],
      }),
      [
        {
          ledger: duty194T,
          rows: [
            splitCredit("20260331", "R/1", 3000000, [[partnerAcctA, 1500000], [partnerAcctB, 1500000]]),
            splitCredit("20260331", "R/2", 1000000, [[partnerAcctA, 500000], [partnerAcctB, 500000]]),
          ],
        },
      ],
      [{ ledger: remunLedger, rows: [row("20260331", "R/2", 10000000, partnerAcctA)] }],
      [],
    );
    const nd = ofCheck(out, "tds_not_deposited");
    expect(nd.map((f) => f.amount).sort((a, b) => a - b)).toEqual([500000, 500000]);
    expect(ofCheck(out, "tds_not_deducted")).toEqual([]);
  });

  it("scales the s.40(a)(ia) base to the tax actually not deposited (item 041)", () => {
    // 4cr remuneration, 40L tax, of which two 15L credits are challan-covered
    // and only the two 5L credits (10L) remain undeposited. The base is
    // 4cr x 10L/40L = 1cr, so the exposure is 30% of 1cr = 30,00,000.
    const out = run(
      ctx194T({
        subsequentDeposits: [
          { party: "Winman Alpha", section: "194T", tax: 1500000, dedDate: "20260331", depositDate: "20260430" },
          { party: "Winman Beta", section: "194T", tax: 1500000, dedDate: "20260331", depositDate: "20260430" },
        ],
      }),
      [
        {
          ledger: duty194T,
          rows: [
            splitCredit("20260331", "R/1", 3000000, [[partnerAcctA, 1500000], [partnerAcctB, 1500000]]),
            splitCredit("20260331", "R/2", 1000000, [[partnerAcctA, 500000], [partnerAcctB, 500000]]),
          ],
        },
      ],
      [{ ledger: remunLedger, rows: [row("20260331", "R/2", 40000000, partnerAcctA)] }],
      [],
    );
    const exp = ofCheck(out, "tds_exposure_40a_ia");
    expect(exp).toHaveLength(1);
    expect(exp[0].amount).toBe(3000000);
  });

  it("reports s.201(1A)(ii) interest on a late subsequent-challan deposit (item 059)", () => {
    // Two 5L credits deducted 31-Mar-2026, covered by a challan deposited
    // 26-Sep-2026 — seven months late. Each carries 1.5% x 7 x 5,00,000 =
    // 52,500 of interest (ii); the challan's own interest column says 90,000
    // paid (5L + 5L challan interest), surfaced in the finding detail.
    const out = run(
      ctx194T({
        subsequentDeposits: [
          { party: "Winman Alpha", section: "194T", tax: 500000, dedDate: "20260331", depositDate: "20260926", interestPaid: 90000, challanId: "C9" },
          { party: "Winman Beta", section: "194T", tax: 500000, dedDate: "20260331", depositDate: "20260926", interestPaid: 90000, challanId: "C9" },
        ],
      }),
      [
        {
          ledger: duty194T,
          rows: [splitCredit("20260331", "R/2", 1000000, [[partnerAcctA, 500000], [partnerAcctB, 500000]])],
        },
      ],
      [{ ledger: remunLedger, rows: [row("20260331", "R/2", 10000000, partnerAcctA)] }],
      [],
    );
    const late = ofCheck(out, "tds_late_deposit").filter((f) => f.section === "194T");
    expect(late).toHaveLength(2);
    expect(late.map((f) => f.amount).sort((a, b) => a - b)).toEqual([500000, 500000]);
    expect(late[0].schedule?.[0]).toMatchObject({ kind: "ii", amount: 52500, from: "20260331", to: "20260926" });
    expect(late.some((f) => f.detail.includes("52,500.00"))).toBe(true);
    expect(late.some((f) => f.detail.includes("interest paid 90,000.00"))).toBe(true);
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
  });

  it("raises no lateness interest when the subsequent challan is on time (item 059)", () => {
    const out = run(
      ctx194T({
        subsequentDeposits: [
          { party: "Winman Alpha", section: "194T", tax: 500000, dedDate: "20260331", depositDate: "20260430", interestPaid: 0, challanId: "C1" },
        ],
      }),
      [
        {
          ledger: duty194T,
          rows: [splitCredit("20260331", "R/2", 1000000, [[partnerAcctA, 500000], [partnerAcctB, 500000]])],
        },
      ],
      [{ ledger: remunLedger, rows: [row("20260331", "R/2", 10000000, partnerAcctA)] }],
      [],
    );
    expect(ofCheck(out, "tds_late_deposit").filter((f) => f.section === "194T")).toEqual([]);
  });
});

describe("2026-09-26q: book-year Winman challans drive lateness interest and paid interest", () => {
  // A deduction whose covering challan (the return's own filing evidence) is
  // deposited after its Rule 30 due date must carry s.201(1A)(ii) interest even
  // when the books' month pool already covered it — the captain reads interest
  // payable off the return (Q1 delivered 31-Jul, Q2 30-Oct, Q3 29-Jan), not off
  // the books' many small remittances.
  const duty = "TDS Contractors";
  const expense = "Site Repairs Contract";
  const party = "Sample Builders LLP";
  const op: OperatorFile = {
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: expense, section: "194C" },
      { ledger: duty, section: "194C", kind: "duty" },
    ],
  };
  const ctxQ = (over: Partial<TdsCtx> = {}) => tdsCtx(op, { tdsParties: [party], ...over });

  it("computes (ii) interest to a book-year challan deposit later than the Rule 30 due", () => {
    // Booked 10-May-2025 at 2% = 5,000 tax; due 7-Jun-2025; the return's
    // challan lands 31-Jul-2025 — two months late (Jun, Jul) = 1.5% x 2 x
    // 5,000 = 150. The books carry no 1:1 deposit, so before the fix the
    // deduction had no deposit date at all.
    const out = run(
      ctxQ({
        subsequentDeposits: [
          { party, section: "194C", tax: 5000, dedDate: "20250628", depositDate: "20250731", interestPaid: 5099, challanId: "5" },
        ],
      }),
      [{ ledger: duty, rows: [{ ...row("20250628", "B/1", -5000, party) }] }],
      [{ ledger: expense, rows: [row("20250628", "B/1", 250000, party)] }],
      [{ ledger: party, rows: [row("20250628", "B/1", 5000, party)] }],
    );
    const late = ofCheck(out, "tds_late_deposit");
    expect(late).toHaveLength(1);
    expect(late[0].section).toBe("194C");
    expect(late[0].schedule?.[0]).toMatchObject({ kind: "ii", from: "20250628", to: "20250731" });
    expect(late[0].schedule?.[0].amount).toBe(150);
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
  });

  it("prefers the return challan date over an in-window 1:1 book deposit (item 075)", () => {
    // Booked 10-May-2025 at 2% = 5,000; the books carry a 1:1 deposit on
    // 5-Jun-2025 (on time), but the return's challan for the same deduction
    // lands 31-Jul-2025. The captain's rule (075): the challan date is the
    // deposit date for s.201(1A)(ii) — month-or-part inclusive, so May→Jul = 3
    // months: 1.5% x 3 x 5,000 = 225 — even though the book remittance was
    // inside the Rule 30 window.
    const out = run(
      ctxQ({
        subsequentDeposits: [
          { party, section: "194C", tax: 5000, dedDate: "20250510", depositDate: "20250731", interestPaid: 5099, challanId: "5" },
        ],
      }),
      [
        {
          ledger: duty,
          rows: [
            { ...row("20250510", "B/1", -5000, party) },
            { ...row("20250605", "D/1", 5000, party) },
          ],
        },
      ],
      [{ ledger: expense, rows: [row("20250510", "B/1", 250000, party)] }],
      [{ ledger: party, rows: [row("20250510", "B/1", 5000, party)] }],
    );
    const late = ofCheck(out, "tds_late_deposit");
    expect(late).toHaveLength(1);
    expect(late[0].schedule?.[0]).toMatchObject({ kind: "ii", from: "20250510", to: "20250731" });
    expect(late[0].schedule?.[0].amount).toBe(225);
  });

  it("falls back to the book deposit date when no challan covers the deduction (item 075)", () => {
    // Same book deposit 5-Jun-2025 (on time), no return challan for the month:
    // the book date applies and no lateness interest fires.
    const out = run(
      ctxQ(),
      [
        {
          ledger: duty,
          rows: [
            { ...row("20250510", "B/1", -5000, party) },
            { ...row("20250605", "D/1", 5000, party) },
          ],
        },
      ],
      [{ ledger: expense, rows: [row("20250510", "B/1", 250000, party)] }],
      [{ ledger: party, rows: [row("20250510", "B/1", 5000, party)] }],
    );
    expect(ofCheck(out, "tds_late_deposit")).toEqual([]);
    expect(ofCheck(out, "tds_not_deposited")).toEqual([]);
  });

});
