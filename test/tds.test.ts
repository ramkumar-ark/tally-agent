import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
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
    panKeyOf: () => "TaxId 999", // a PAN is present by default
    entityOf: () => null,
    certificateRateOf: () => null,
    transporterDeclared: () => false,
    deducteeFiledReturn: () => false,
    asOnDate: "20260331",
    round100: true,
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

  it("flags a short deduction below the law figure, tolerance of one rupee", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -4998, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_short_deducted");
    expect(found).toEqual([
      expect.objectContaining({ amount: 2, severity: "critical" }),
    ]);
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
      expect(check.startsWith("tds_")).toBe(true);
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
  it("states the s.40(a)(ia) exposure at 30% of the tax not deducted, review-only", () => {
    const out = run(tdsCtx(), [],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const found = ofCheck(out, "tds_exposure_40a_ia");
    expect(found).toEqual([
      expect.objectContaining({ amount: 1500, severity: "review" }), // 30% of 5,000
    ]);
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

  it("flags a missing or Unknown deductee type", () => {
    const ctx = tdsCtx(stdOperator, {
      deducteeTypeOf: (p) => (p === partyA ? "Unknown" : ""),
    });
    const out = run(ctx, [], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const gaps = ofCheck(out, "tds_master_gap").filter((f) => f.deductee === partyA && f.detail.includes("deductee type"));
    expect(gaps).toEqual([expect.objectContaining({ severity: "review" })]);
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
      { ledger: "Rent - Office", rows: [row("20250610", "P/13", 100000, partyA)] },
    ]);
    const bySection = out.totals.bySection;
    expect(bySection.find((t) => t.section === "194C")?.gross).toBe(250000);
    expect(bySection.find((t) => t.section === "194-I(b)")?.gross).toBe(100000);
    // And the 194C booking is critical on its own section threshold (the rent
    // aggregate keeps its own per-month threshold, so its liability is not
    // driven by the contract aggregate — separate buckets, point 5 end to end).
    const notDeducted = ofCheck(out, "tds_not_deducted");
    expect(notDeducted.map((f) => f.section)).toEqual(["194C"]);
  });
});
