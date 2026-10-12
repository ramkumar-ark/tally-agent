import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";

/**
 * An unjoined ("orphan") year-end credit (2026-10-12). A deductee's 31-Mar duty
 * journal can sit more than the join window after the bills it pays. It joins
 * no booking, so the per-booking walk never spent it: the earlier bills read
 * "not deducted" and the return's challan for it raised no deposit row.
 * The credit is now pool material for the same deductee+section, and a credit
 * covered by a subsequent-year challan that no booking reported raises its own
 * late-deposit row.
 *
 * Synthetic names only; 194C at 2% on 2,00,000 bills (PAN 4th char C).
 */

const PARTY = "Orphan Credit Works";
const EXPENSE = "Orphan Credit Job Work";
const DUTY = "Orphan Credit TDS on Contractors";

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

const bill = (date: string, voucher: string, gross: number) => ({
  expense: row(date, voucher, gross, PARTY),
  party: row(date, voucher, -(gross * 0.98), EXPENSE),
  credit: row(date, voucher, -(gross * 0.02), PARTY),
});

type Alloc = NonNullable<TdsCtx["subsequentDeposits"]>[number];

const ctxWith = (subsequentDeposits: Alloc[]): TdsCtx & { operator: OperatorFile } => ({
  tdsParties: [PARTY],
  resolveSection: () => ({ section: "194C", candidates: [] }),
  dutySectionOf: () => "194C",
  panKeyOf: (party) => `TaxId ${party}`,
  entityOf: () => "C",
  certificateRateOf: () => null,
  transporterDeclared: () => false,
  deducteeFiledReturn: () => false,
  asOnDate: "20261010",
  period: { fromDate: "20250401", toDate: "20260331" },
  operator: OPERATOR,
  subsequentDeposits,
});

const run = (bills: ReturnType<typeof bill>[], extraCredit: LedgerVoucherRow[], allocs: Alloc[]) =>
  analyzeTds(
    [{ ledger: DUTY, rows: extraCredit }] as TdsLedgerRows[],
    [{ ledger: EXPENSE, rows: bills.map((b) => b.expense) }],
    [{ ledger: "party", rows: bills.map((b) => b.party) }],
    ctxWith(allocs),
  );

const count = (findings: { check: string }[], check: string): number =>
  findings.filter((f) => f.check === check).length;

describe("orphan year-end credit (2026-10-12)", () => {
  const bills = [bill("20250910", "PU/1", 200000), bill("20251020", "PU/2", 200000)];
  const credit = row("20260331", "J/9", -8000, PARTY, "Journal");
  const challan: Alloc = {
    party: PARTY,
    section: "194C",
    tax: 8000,
    dedDate: "20260331",
    depositDate: "20261008",
    interestPaid: 0,
    challanId: "25",
  };

  it("settles earlier unpaid bills backward instead of reporting them not deducted", () => {
    const { findings } = run(bills, [credit], []);
    expect(count(findings, "tds_not_deducted")).toBe(0);
    expect(count(findings, "tds_short_deducted")).toBe(0);
    expect(count(findings, "tds_late_deducted")).toBeGreaterThan(0);
  });

  it("raises the challan's late deposit with interest (ii) for the unjoined credit", () => {
    const { findings, events } = run(bills, [credit], [challan]);
    expect(events.deductions[0]!.subsequentDeposit).toBe("20261008");
    const late = findings.filter((f) => f.check === "tds_late_deposit");
    expect(late.length).toBe(1);
    expect(late[0]!.detail).toContain("interest (ii)");
    expect(count(findings, "tds_not_deposited")).toBe(0);
  });

  it("raises no late-deposit row when no challan covers the credit", () => {
    const { findings } = run(bills, [credit], []);
    expect(count(findings, "tds_late_deposit")).toBe(0);
  });
});
