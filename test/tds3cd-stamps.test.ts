import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";

/**
 * The stamped fields on `analyzeTds`'s events record what the engine already
 * computes for its findings: the liable base after the threshold /
 * whole-year / 194Q-crossing logic, the applied rate and whether it came
 * from an s.197 certificate, and the per-deduction s.201(1A) interest
 * components the schedule machinery derives. Zero behavior change.
 */

const dutyLedger = "TDS Contractors";
const expenseLedger = "Site Repairs Contract";
const certParty = "Sample Builders LLP";
const plainParty = "Sample Consultants";

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [{ ledger: expenseLedger, section: "194C" }],
};

const ctx: TdsCtx & { operator: OperatorFile } = {
  tdsParties: [certParty, plainParty],
  resolveSection: () => ({ section: "194C", candidates: [] }),
  dutySectionOf: () => "194C",
  panKeyOf: (party) => `TaxId ${party}`,
  entityOf: () => null,
  certificateRateOf: (party) => (party === certParty ? 0.03 : null),
  transporterDeclared: () => false,
  deducteeFiledReturn: () => false,
  asOnDate: "20260331",
  period: { fromDate: "20250401", toDate: "20260331" },
  operator: OPERATOR,
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

// Each party: a 2,50,000 bill on 10-May-2025 (crosses 194C's aggregate
// threshold, whole-year liable), the duty credit deducted late on 28-Jun,
// deposited late on 15-Aug. Certificate party at 3% (7,500), plain at 2%
// (5,000). Interest (i) 1% x 2 months; interest (ii) 1.5% x 3 months.
const expenseRows: TdsLedgerRows[] = [
  {
    ledger: expenseLedger,
    rows: [
      row("20250510", "PU/C", 250000, certParty),
      row("20250510", "PU/P", 250000, plainParty),
    ],
  },
];
const partyRows: TdsLedgerRows[] = [];
const dutyRows: TdsLedgerRows[] = [
  {
    ledger: dutyLedger,
    rows: [
      row("20250628", "PU/C", -7500, certParty),
      row("20250815", "PU/C", 7500, certParty),
      row("20250628", "PU/P", -5000, plainParty),
      row("20250815", "PU/P", 5000, plainParty),
    ],
  },
];

const certOverride = (party: string): boolean => ctx.certificateRateOf(party, "194C", "20250510") !== null;

describe("analyzeTds stamps on events", () => {
  it("stamps liable, rateApplied and viaCertificate on each booking", () => {
    const result = analyzeTds(dutyRows, expenseRows, partyRows, ctx);
    expect(result.events.bookings).toHaveLength(2);
    for (const booking of result.events.bookings) {
      expect(booking.liable).toBeDefined();
      expect(typeof booking.rateApplied).toBe("number");
      expect(booking.viaCertificate).toBe(certOverride(booking.party));
    }
    const cert = result.events.bookings.find((b) => b.party === certParty)!;
    const plain = result.events.bookings.find((b) => b.party === plainParty)!;
    expect(cert.viaCertificate).toBe(true);
    expect(plain.viaCertificate).toBe(false);
    expect(cert.rateApplied).toBe(0.03);
    expect(plain.rateApplied).toBe(0.02);
    expect(cert.liable).toBe(250000);
  });

  it("stamps the per-deduction interest components and the sum reconciles with the totals", () => {
    const result = analyzeTds(dutyRows, expenseRows, partyRows, ctx);
    expect(result.events.deductions).toHaveLength(2);
    for (const ded of result.events.deductions) {
      expect(ded.interestI).toBeDefined();
      expect(ded.interestII).toBeDefined();
    }
    const stamped = result.events.deductions.reduce(
      (s, d) => s + (d.interestI ?? 0) + (d.interestII ?? 0),
      0,
    );
    // The worked example scaled by each party's tax: interest (i) 1% x 2
    // months of 5,000 / 7,500 = 100 / 150; interest (ii) 1.5% x 3 months
    // = 225 / 337.5.
    expect(result.totals.interestI).toBe(250);
    expect(result.totals.interestIi).toBe(562.5);
    expect(stamped).toBeCloseTo(result.totals.interestI + result.totals.interestIi, 2);
  });
});
