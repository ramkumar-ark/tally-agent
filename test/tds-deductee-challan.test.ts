import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";

/**
 * Deductee-level challan match (2026-10-12). A return allocates a credit's tax
 * per deductee, and one deductee can own several return rows for one challan.
 * The whole-credit match cannot see that, so a credit is claimed by the sum of
 * its deductee's unclaimed rows (same section, deduction month), all-or-nothing,
 * from one challan, with the challan's interest read once.
 *
 * Synthetic names only: a 4,000 194C credit on a 2,00,000 bill (2%), PAN
 * 4th char C via entityOf so the 2% rate holds.
 */

const PARTY = "Deductee Sum Works";
const EXPENSE = "Deductee Sum Job Work";
const DUTY = "Deductee Sum TDS on Contractors";

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: EXPENSE, section: "194C" },
    { ledger: DUTY, section: "194C", kind: "duty" },
  ],
  parties: [{ ledger: PARTY, tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false }],
};

const row = (date: string, voucher: string, amount: number, counterparty: string): LedgerVoucherRow => ({
  date,
  voucherType: "Purchase",
  voucherNumber: voucher,
  reference: "",
  counterparty,
  amount,
  matchStatus: "matched",
  tax: null,
});

const MAR_BILL = {
  expense: row("20260320", "PU/2", 200000, PARTY),
  party: row("20260320", "PU/2", -196000, EXPENSE),
  credit: row("20260320", "PU/2", -4000, PARTY),
};

const ledgers = (): { duty: TdsLedgerRows[]; expense: TdsLedgerRows[]; party: TdsLedgerRows[] } => ({
  duty: [{ ledger: DUTY, rows: [MAR_BILL.credit] }],
  expense: [{ ledger: EXPENSE, rows: [MAR_BILL.expense] }],
  party: [{ ledger: "party", rows: [MAR_BILL.party] }],
});

type Alloc = NonNullable<TdsCtx["subsequentDeposits"]>[number];

const alloc = (tax: number, challanId = "C1", interestPaid = 0, depositDate = "20260430"): Alloc => ({
  party: PARTY,
  section: "194C",
  tax,
  dedDate: "20260320",
  depositDate,
  interestPaid,
  challanId,
});

const ctxWith = (subsequentDeposits: Alloc[]): TdsCtx & { operator: OperatorFile } => ({
  tdsParties: [PARTY],
  resolveSection: () => ({ section: "194C", candidates: [] }),
  dutySectionOf: () => "194C",
  panKeyOf: (party) => `TaxId ${party}`,
  entityOf: () => "C",
  certificateRateOf: () => null,
  transporterDeclared: () => false,
  deducteeFiledReturn: () => false,
  asOnDate: "20260331",
  period: { fromDate: "20250401", toDate: "20260331" },
  operator: OPERATOR,
  subsequentDeposits,
});

const count = (findings: { check: string }[], check: string): number =>
  findings.filter((f) => f.check === check).length;

describe("deductee-level challan match (2026-10-12)", () => {
  it("claims a credit by the sum of its deductee's rows for one challan", () => {
    const L = ledgers();
    const { events, findings } = analyzeTds(
      L.duty,
      L.expense,
      L.party,
      ctxWith([alloc(1500), alloc(2500)]),
    );
    const d = events.deductions[0]!;
    expect(d.subsequentDeposit).toBe("20260430");
    expect(count(findings, "tds_not_deposited")).toBe(0);
    expect(count(findings, "tds_exposure_40a_ia")).toBe(0);
  });

  it("fails closed when the deductee's rows do not add up to the credit", () => {
    const L = ledgers();
    const { events, findings } = analyzeTds(L.duty, L.expense, L.party, ctxWith([alloc(1500), alloc(2000)]));
    expect(events.deductions[0]!.subsequentDeposit).toBeUndefined();
    expect(count(findings, "tds_not_deposited")).toBe(1);
  });

  it("does not claim across challans: rows from two challans stay unmatched", () => {
    const L = ledgers();
    const { events, findings } = analyzeTds(
      L.duty,
      L.expense,
      L.party,
      ctxWith([alloc(1500, "C1"), alloc(2500, "C2")]),
    );
    expect(events.deductions[0]!.subsequentDeposit).toBeUndefined();
    expect(count(findings, "tds_not_deposited")).toBe(1);
  });

  it("reads the challan's interest once, not once per return row", () => {
    const L = ledgers();
    const { events } = analyzeTds(
      L.duty,
      L.expense,
      L.party,
      ctxWith([alloc(2000, "C1", 100), alloc(2000, "C1", 100)]),
    );
    expect(events.deductions[0]!.subsequentInterestPaid).toBe(100);
  });
});
