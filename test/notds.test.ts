import { describe, expect, it } from "vitest";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { canonicalKey } from "../src/key.js";
import {
  NOTDS_FORM_ID,
  NR_SECTIONS,
  RESIDENT_SECTIONS,
  amountKeyOf,
  booksCandidates,
  depositedKeyOf,
  doneKeyOf,
  isNrSectionSpelling,
  isResidentSectionSpelling,
  winmanSectionOf,
  type NotdsSheetKey,
} from "../src/notds.js";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { stdOperator, tdsCtx } from "./tds.test.js";

/**
 * Pins the No TDS Disallowance presentation law verbatim: Winman's
 * TDSSECTION dropdown spellings (§2.2 of the design of record), the
 * law-key → Winman-spelling map, and the per-sheet row-2 key routing.
 */

describe("3cdNoTDS presentation law", () => {
  it("carries the form id", () => {
    expect(NOTDS_FORM_ID).toBe("3cdNoTDS");
  });

  it("has exactly 32 resident section spellings, in workbook order", () => {
    expect(RESIDENT_SECTIONS).toEqual([
      "192",
      "193",
      "194",
      "194-IA",
      "194-IB",
      "194-IC",
      "194-O",
      "194A",
      "194B",
      "194BA",
      "194BB",
      "194C",
      "194D",
      "194DA",
      "194EE",
      "194G",
      "194H",
      "194I (a)",
      "194I (b)",
      "194J",
      "194K",
      "194LA",
      "194LBA",
      "194LBB",
      "194LBC",
      "194M",
      "194N",
      "194P",
      "194Q",
      "194R",
      "194S",
      "194T",
    ]);
  });

  it("has exactly 16 non-resident section spellings, in workbook order", () => {
    expect(NR_SECTIONS).toEqual([
      "194BA",
      "194E",
      "194LB",
      "194LBA",
      "194LBA(3)",
      "194LBB",
      "194LBC",
      "194LC",
      "194N",
      "194Q",
      "194T",
      "195",
      "196A",
      "196B",
      "196C",
      "196D",
    ]);
  });

  it("maps the two law keys whose Winman spelling differs", () => {
    expect(winmanSectionOf("194-I(a)")).toBe("194I (a)");
    expect(winmanSectionOf("194-I(b)")).toBe("194I (b)");
  });

  it("passes every other law-table key through unchanged", () => {
    for (const key of ["192", "194C", "194J", "194A", "194H", "194Q", "194T", "194EE"]) {
      expect(winmanSectionOf(key)).toBe(key);
    }
  });

  it("rejects a bare 194-I", () => {
    expect(() => winmanSectionOf("194-I")).toThrow();
  });

  it("rejects any key outside the two lists", () => {
    expect(() => winmanSectionOf("194ZZ")).toThrow();
    expect(() => winmanSectionOf("")).toThrow();
  });

  it("accepts every resident spelling via isResidentSectionSpelling and nothing else", () => {
    for (const s of RESIDENT_SECTIONS) expect(isResidentSectionSpelling(s)).toBe(true);
    expect(isResidentSectionSpelling("194-I(a)")).toBe(false);
    expect(isResidentSectionSpelling("196D")).toBe(false);
  });

  it("accepts every NR spelling via isNrSectionSpelling and nothing else", () => {
    for (const s of NR_SECTIONS) expect(isNrSectionSpelling(s)).toBe(true);
    expect(isNrSectionSpelling("194C")).toBe(false);
  });

  it("routes the row-2 keys per sheet", () => {
    const resident = "40(a)(ia) to resident" as NotdsSheetKey;
    const nr = "40(a)(i) to non-resident" as NotdsSheetKey;
    const levy = "40(a)(ib) - Equalisation Levy" as NotdsSheetKey;
    const salary = "40(a)(iii)" as NotdsSheetKey;

    expect(doneKeyOf(resident)).toBe("TDSDONE");
    expect(doneKeyOf(nr)).toBe("TDSDONE");
    expect(doneKeyOf(levy)).toBe("LEVYDEDUCTED");
    expect(doneKeyOf(salary)).toBeUndefined();

    expect(depositedKeyOf(resident)).toBe("TDSDEPOSITED");
    expect(depositedKeyOf(nr)).toBe("TDSDEPOSITED");
    expect(depositedKeyOf(levy)).toBe("LEVYDEPOSITED");
    expect(depositedKeyOf(salary)).toBeUndefined();

    expect(amountKeyOf(resident)).toBe("EXPENSEAMOUNT");
    expect(amountKeyOf(nr)).toBe("EXPENSEAMOUNT");
    expect(amountKeyOf(levy)).toBe("EXPENSEAMOUNT");
    expect(amountKeyOf(salary)).toBe("AMOUNT");
  });
});

/**
 * booksCandidates — the clause 21(b) books projection. Rides the real engine
 * (analyzeTds) over the same fictional ledger universe as test/tds.test.ts so
 * the joins (deduction→booking, deposit→deduction) are the engine's own, never
 * re-staged by hand.
 */

const dutyLedger = "TDS Contractors";
const expenseLedger = "Site Repairs Contract";
const partyA = "Sample Builders LLP";
const partyB = "Sample Consultants";

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

const panOfA = (party: string): string | null => (party === partyA ? "TaxId 101" : null);

const project = (
  duty: TdsLedgerRows[],
  expense: TdsLedgerRows[],
  opts: {
    operator?: OperatorFile;
    over?: Partial<TdsCtx>;
    panOf?: (party: string) => string | null;
    panDerived?: (party: string) => boolean;
  } = {},
): { rows: ReturnType<typeof booksCandidates>; out: ReturnType<typeof analyzeTds> } => {
  const out = analyzeTds(duty, expense, [], tdsCtx(opts.operator, opts.over));
  return {
    out,
    rows: booksCandidates(out.clause21b, opts.panOf ?? panOfA, opts.panDerived ?? (() => false)),
  };
};

describe("booksCandidates (clause 21(b) candidate rows)", () => {
  it("excludes a compliant deducted-and-deposited booking (deposit inside the due window)", () => {
    const { out, rows } = project(
      [
        { ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA), row("20250705", "P/12", 5000, "Bank Alpha")] },
      ],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }],
    );
    // The engine did compute the liability with both joins made — the
    // exclusion is the predicate's doing, not empty engine output.
    expect(out.liabilities).toEqual([
      expect.objectContaining({ section: "194C", liability: 5000, deduction: expect.objectContaining({ tax: 5000 }) }),
    ]);
    expect(out.events.deposits[0].deduction).toBe(out.liabilities[0].deduction);
    expect(rows).toEqual([]);
  });

  it("includes a not-deducted booking with tdsDone 0", () => {
    const { rows } = project(
      [],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }],
    );
    expect(rows).toEqual([
      {
        key: `${canonicalKey(partyA)}|20250510|P/12|194C`,
        party: partyA,
        date: "20250510",
        voucherNumber: "P/12",
        gross: 250000,
        tdsDone: 0,
        tdsDeposited: 0,
        depositDate: null,
        section: "194C",
        liability: 5000,
        findingId: "TDS-001-1",
        pan: "TaxId 101",
        panFromGstin: false,
      },
    ]);
  });

  it("includes a short-deducted booking, and a within-tolerance deduction is not short", () => {
    const expense = [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }];
    const { rows } = project(
      [{ ledger: dutyLedger, rows: [row("20250628", "P/12", -4998, partyA)] }],
      expense,
    );
    expect(rows).toHaveLength(1);
    // The 2 shortfall tax is below the ₹100 reporting floor, so no short arm
    // fires; the 4998 credit is never deposited, so the row is the
    // not_deposited arm (unchanged by the 2026-09-26 undeducted-portion rule).
    expect(rows[0]).toMatchObject({ voucherNumber: "P/12", tdsDone: 4998, liability: 5000, tdsDeposited: 0, depositDate: null });
    // 4999 is within the 1.0 tolerance of the 5000 liability: not short, and
    // deposited on time ⇒ compliant ⇒ no candidate.
    const within = project(
      [{ ledger: dutyLedger, rows: [row("20250628", "P/12", -4999, partyA), row("20250705", "P/12", 4999, "Bank Alpha")] }],
      expense,
    );
    expect(within.rows).toEqual([]);
  });

  it("reports only the undeducted portion of the expense on a short-deducted row (captain, 2026-09-26)", () => {
    // 5,00,000 @ 2% ⇒ 10,000 liability; a 5,000 credit deposited on time is
    // short by 5,000 (≥ the ₹100 floor). The 21(b) sheet states only the
    // undeducted expense: 5,000 shortfall / 2% = 2,50,000, with TDS done and
    // deposited at 0 (no tax was deducted on that portion).
    const { rows } = project(
      [{ ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA), row("20250705", "P/12", 5000, "Bank Alpha")] }],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 500000, partyA)] }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gross: 250000, tdsDone: 0, tdsDeposited: 0, liability: 10000, section: "194C" });
  });

  it("includes a deducted-but-never-deposited booking with tdsDeposited 0", () => {
    const { rows } = project(
      [{ ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA)] }],
      [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tdsDone: 5000, tdsDeposited: 0, depositDate: null });
  });

  it("excludes a late-but-deposited booking: a late deposit is a s.201(1A) interest finding, not a clause 21(b) row (2026-09-26 005)", () => {
    const expense = [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }];
    // depositDue(20250628) = 20250707 (Rule 30): the 15-Aug deposit is late,
    // but the tax was deposited — the review raises tds_late_deposit (interest)
    // and no not_deducted/short/not_deposited finding, so the engine collects
    // no clause 21(b) row (the sheets reconcile to the review).
    const { rows } = project(
      [{ ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA), row("20250815", "P/12", 5000, "Bank Alpha")] }],
      expense,
    );
    expect(rows).toEqual([]);
    // The same books with the deposit one day inside the window are compliant too.
    const onTime = project(
      [{ ledger: dutyLedger, rows: [row("20250628", "P/12", -5000, partyA), row("20250707", "P/12", 5000, "Bank Alpha")] }],
      expense,
    );
    expect(onTime.rows).toEqual([]);
  });

  it("yields nothing from a 194Q-suppressed run (Focus #1)", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Purchase - Domestic", section: "194Q" }],
      section194QApplicable: false,
    };
    const { rows } = project(
      [],
      [{
        ledger: "Purchase - Domestic",
        rows: [
          row("20250410", "G/1", 3000000, partyB),
          row("20250510", "G/2", 3000000, partyB),
        ],
      }],
      { operator, over: { dutySectionOf: () => null, panKeyOf: () => "TaxId 999" } },
    );
    expect(rows).toEqual([]);
  });

  it("carries pan: null for a party with no PAN, and flags a GSTIN-derived PAN (Focus #5)", () => {
    const expense = [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }];
    const noPan = project([], expense, { panOf: () => null });
    expect(noPan.rows).toHaveLength(1);
    expect(noPan.rows[0].pan).toBeNull();
    expect(noPan.rows[0].panFromGstin).toBe(false);

    const derived = project([], expense, { panOf: () => "TaxId 101", panDerived: () => true });
    expect(derived.rows[0].pan).toBe("TaxId 101");
    expect(derived.rows[0].panFromGstin).toBe(true);
  });

  it("keys are stable and unique per booking", () => {
    const expense = [{
      ledger: expenseLedger,
      rows: [
        row("20250510", "P/12", 250000, partyA),
        row("20250610", "P/13", 250000, partyA),
        row("20250710", "P/14", 250000, partyB),
      ],
    }];
    const { out, rows } = project([], expense);
    expect(rows).toHaveLength(3);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      `${canonicalKey(partyA)}|20250510|P/12|194C`,
      `${canonicalKey(partyA)}|20250610|P/13|194C`,
      `${canonicalKey(partyB)}|20250710|P/14|194C`,
    ]);
    // Stable: the pure projection over the same rows returns the same keys.
    const again = booksCandidates(out.clause21b, panOfA, () => false);
    expect(again.map((r) => r.key)).toEqual(keys);
  });
});
