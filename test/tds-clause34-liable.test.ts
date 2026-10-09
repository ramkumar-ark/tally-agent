import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsBooking, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { tds3cdRows } from "../src/tds3cd.js";
import type { TcsAnalysis } from "../src/tcs.js";

/**
 * Clause 34's "sum liable to TDS" for 194C must never exceed the section's
 * total payments for a deductee (2026-10-09, DSV Infra FY 25-26,
 * data/ta-dsv-tds-liable-recon/report.md §7.1: 31,69,820 reported where
 * 31,19,820 is correct).
 *
 * The overstatement came from a cumulative-limit crossing booking carrying the
 * WHOLE year-to-date cumulative while an earlier pre-crossing booking already
 * carried its own gross as liable (194C's per-bill 30,000 rule): the earlier
 * payment was charged twice. `stampLiabilities` now nets the crossing's base
 * against the liable already charged to earlier bookings of the same
 * deductee + section, so a party's sum of liable equals — never exceeds — its
 * gross in that section.
 *
 * The figures are fictional, in no way copied from live books.
 */

const expenseLedger = "Site Repairs Contract";
const dutyLedger = "TDS Contractors";
const contractor = "Sample Contractors";
const otherParty = "Sample Builders LLP";
const company = "TestCo Private Limited";

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [{ ledger: expenseLedger, section: "194C" }],
};

const ctx: TdsCtx & { operator: OperatorFile } = {
  tdsParties: [contractor, otherParty],
  resolveSection: () => ({ section: "194C", candidates: [] }),
  dutySectionOf: (ledger) => (ledger === dutyLedger ? "194C" : null),
  dutyCandidatesOf: (ledger) => (ledger === dutyLedger ? ["194C"] : []),
  panKeyOf: (party) => `TaxId ${party}`,
  entityOf: () => null,
  certificateRateOf: () => null,
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
  // Signed for the queried ledger: positive = debit.
  amount,
  matchStatus: "matched",
  tax: null,
});

const emptyTcs = (): TcsAnalysis => ({ collections: [], deposits: [], totals: { byNature: [], notDeposited: 0 } });

const byDate = (bookings: TdsBooking[]): TdsBooking[] =>
  [...bookings].sort((a, b) => a.date.localeCompare(b.date));

const run = (rows: LedgerVoucherRow[]) =>
  analyzeTds([], [{ ledger: expenseLedger, rows }], [], ctx);

/** Σ liable / Σ gross per deductee + section, from the engine's own stamps. */
const sums = (bookings: TdsBooking[]): Map<string, { liable: number; gross: number }> => {
  const m = new Map<string, { liable: number; gross: number }>();
  for (const b of bookings) {
    const key = `${b.party}|${b.section ?? ""}`;
    const s = m.get(key) ?? { liable: 0, gross: 0 };
    s.liable = Math.round((s.liable + (b.liable ?? 0)) * 100) / 100;
    s.gross = Math.round((s.gross + b.gross) * 100) / 100;
    m.set(key, s);
  }
  return m;
};

describe("clause 34: a crossing booking never charges a payment twice", () => {
  // The DSV shape: 50,000 over the 194C per-bill 30,000 limit (liable on its
  // own account), 10,000 inside the annual aggregate (not liable), then
  // 58,990 crossing the 1,00,000 aggregate with 1,18,990 booked to date.
  const bookings = [
    row("20251030", "P/101", 50000, contractor),
    row("20251130", "P/102", 10000, contractor),
    row("20260131", "P/103", 58990, contractor),
  ];

  it("stamps per-booking liable 50,000 / 0 / 68,990 summing to the payments", () => {
    const out = run(bookings);
    const b = byDate(out.events.bookings);
    expect(b.map((x) => x.gross)).toEqual([50000, 10000, 58990]);
    expect(b.map((x) => x.liable)).toEqual([50000, 0, 68990]);
    expect(b.reduce((s, x) => s + (x.liable ?? 0), 0)).toBe(118990);
    expect(b.reduce((s, x) => s + x.gross, 0)).toBe(118990);
    // The crossing is identified by index and carries the un-netted year total
    // on `crossGross` so a finding can state the netting honestly.
    expect(b[2].crossGross).toBe(118990);
  });

  it("reports the same tax as the payments at 2% (no double-counted charge)", () => {
    const out = run(bookings);
    const liabs = out.liabilities.filter((l) => l.section === "194C");
    expect(liabs.map((l) => l.liability)).toEqual([1000, 1379.8]);
    expect(liabs.reduce((s, l) => s + l.liability, 0)).toBe(2379.8);
    // 194Q party-month coverage reads the same stamped liability: the crossing
    // month's need is the netted charge, not the whole cumulative's tax.
    const charged = out.findings.filter((f) => f.check === "tds_not_deducted");
    expect(charged.map((f) => f.amount)).toEqual([1000, 1379.8]);
  });

  it("states the netting in the crossing booking's finding detail", () => {
    const out = run(bookings);
    const crossing = out.findings.find((f) => f.check === "tds_not_deducted" && f.detail.includes("58,990.00"));
    expect(crossing?.detail).toContain("tax of 1,379.80 was payable on the 68,990.00 of the 1,18,990.00 booked to this date");
    expect(crossing?.detail).toContain("the rest already charged to an earlier booking within the annual limit");
  });

  it("puts 1,18,990 on the clause 34 row, not 1,68,990", () => {
    const out = run(bookings);
    const result = tds3cdRows({
      company,
      tan: null,
      tds: { events: out.events, totals: out.totals },
      tcs: emptyTcs(),
      operator: OPERATOR,
      asOnDate: "20260331",
    });
    const r = result.tds.find((x) => x.section === "194C");
    expect(r).toBeDefined();
    expect(r?.totalPayments).toBe(118990);
    expect(r?.sumLiable).toBe(118990);
    expect(r?.sumLiable).toBeLessThanOrEqual(r?.totalPayments as number);
    expect(r?.atRateLiable).toBe(118990);
    // atRateTds is tax the books actually deducted — none here (no duty
    // credits in this fixture), so the row shows the liability only.
    expect(r?.atRateTds).toBe(0);
  });

  it("never lets a deductee's sum of liable exceed its gross in a section", () => {
    const shapes: LedgerVoucherRow[][] = [
      // The DSV shape above (crossing with a pre-crossing single-limit bill).
      bookings,
      // Never crosses the aggregate: only the per-bill limit bites, so the
      // liable sum stays strictly below the payments.
      [row("20251030", "P/201", 40000, contractor), row("20251130", "P/202", 45000, contractor)],
      // Crosses with no earlier single-limit booking: the crossing carries the
      // whole cumulative, so liable sums to exactly the payments.
      [row("20251030", "P/301", 40000, contractor), row("20260131", "P/303", 70000, contractor)],
      // Two deductees in one section, one of them a post-crossing tail.
      [
        row("20251030", "P/401", 50000, contractor),
        row("20260131", "P/402", 58990, contractor),
        row("20251030", "P/403", 20000, otherParty),
        row("20251231", "P/404", 95000, otherParty),
      ],
    ];
    for (const rows of shapes) {
      const out = run(rows);
      for (const [, s] of sums(out.events.bookings)) {
        expect(s.liable).toBeLessThanOrEqual(s.gross);
      }
    }
  });
});
