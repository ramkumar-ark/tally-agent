import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";

/**
 * Advances before backward settlement (2026-10-13). A party deducted at 1% on
 * bills that were inside the annual limit (the July bill owes nothing yet, so
 * its 202 sits in the bank as an advance). The August bill crosses the limit
 * and owes 929.29; the bank covers 202 of it. A 31-Mar journal credit of 163
 * belongs to the unpaid October bill (162.50). Spending the 163 backward on
 * the August bill FIRST left that bill over-covered and the October bill
 * reported not deducted.
 *
 * Synthetic names only; 194C, individual (PAN 4th char P) at 1%.
 */

const PARTY = "Advance First Works";
const EXPENSE = "Advance First Job Work";
const DUTY = "Advance First TDS on Contractors";

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: EXPENSE, section: "194C" },
    { ledger: DUTY, section: "194C", kind: "duty" },
  ],
  parties: [{ ledger: PARTY, tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false }],
};

const row = (date: string, voucher: string, amount: number, counterparty: string, voucherType = "Purchase"): LedgerVoucherRow => ({
  date,
  voucherType,
  voucherNumber: voucher,
  reference: "",
  counterparty,
  amount,
  matchStatus: "matched",
  tax: null,
});

const ctx: TdsCtx & { operator: OperatorFile } = {
  tdsParties: [PARTY],
  resolveSection: () => ({ section: "194C", candidates: [] }),
  dutySectionOf: () => "194C",
  panKeyOf: (party) => `TaxId ${party}`,
  entityOf: () => "P",
  certificateRateOf: () => null,
  transporterDeclared: () => false,
  deducteeFiledReturn: () => false,
  asOnDate: "20261010",
  period: { fromDate: "20250401", toDate: "20260331" },
  operator: OPERATOR,
};

// [date, voucher, gross, tax deducted on the bill's own voucher]
const BILLS: [string, string, number, number][] = [
  ["20250630", "PU/1", 30303, 303],
  ["20250731", "PU/2", 20202, 202],
  ["20250831", "PU/3", 72727, 727],
  ["20251031", "PU/4", 16250, 0],
];

describe("advance credits are spent before backward settlement", () => {
  const expenses = BILLS.map(([d, v, g]) => row(d, v, g, PARTY));
  const parties = BILLS.map(([d, v, g, t]) => row(d, v, -(g - t), EXPENSE));
  const duty = BILLS.filter(([, , , t]) => t > 0).map(([d, v, , t]) => row(d, v, -t, PARTY));
  duty.push(row("20260331", "J/9", -163, PARTY, "Journal"));

  const { findings } = analyzeTds(
    [{ ledger: DUTY, rows: duty }] as TdsLedgerRows[],
    [{ ledger: EXPENSE, rows: expenses }],
    [{ ledger: "party", rows: parties }],
    ctx,
  );

  it("does not report the October bill not deducted", () => {
    expect(findings.filter((f) => f.check === "tds_not_deducted")).toEqual([]);
  });

  it("does not report a short deduction on the party", () => {
    expect(findings.filter((f) => f.check === "tds_short_deducted")).toEqual([]);
  });
});
