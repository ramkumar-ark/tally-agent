import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { stdOperator, tdsCtx } from "./tds.test.js";

/**
 * Task 3: analyzeTds additionally returns per-booking liability facts
 * (additive; findings/totals untouched). Mirror of the tds.test.ts fixture
 * style — the same fictional ledger universe, never live books.
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
  amount,
  matchStatus: "matched",
  tax: null,
});

const run = (
  ctx: ReturnType<typeof tdsCtx>,
  duty: TdsLedgerRows[] = [],
  expense: TdsLedgerRows[] = [],
  party: TdsLedgerRows[] = [],
): ReturnType<typeof analyzeTds> => analyzeTds(duty, expense, party, ctx);

describe("TDS per-booking liabilities (additive engine output)", () => {
  it("(a) a fully-compliant booking appears in liabilities with its joined deduction", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -5000, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    expect(out.liabilities).toEqual([
      expect.objectContaining({
        section: "194C",
        liableBase: 250000,
        liability: 5000,
        rate: 0.02,
        deduction: expect.objectContaining({ tax: 5000, joinedTo: "P/12" }),
      }),
    ]);
    expect(out.liabilities[0].booking).toMatchObject({ voucherNumber: "P/12", party: partyA, gross: 250000 });
    // findings/totals still flow as before
    expect(out.findings.length).toBeGreaterThan(0);
  });

  it("(b) a short deduction's liability − deduction.tax is positive", () => {
    const out = run(tdsCtx(), [
      { ledger: dutyLedger, rows: [row("20250510", "P/12", -4998, partyA)] },
    ], [{ ledger: expenseLedger, rows: [row("20250510", "P/12", 250000, partyA)] }]);
    const [l] = out.liabilities;
    expect(l.liability).toBe(5000);
    expect(l.deduction).not.toBeNull();
    expect(l.liability - l.deduction!.tax).toBeGreaterThan(0);
  });

  it("(c) 194Q suppressed: no 194Q entry in liabilities though events.bookings carries the booking", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Purchase - Domestic", section: "194Q" }],
      section194QApplicable: false,
    };
    const cfg = tdsCtx(operator, { dutySectionOf: () => null, panKeyOf: () => "TaxId 999" });
    const out = run(cfg, [], [{
      ledger: "Purchase - Domestic",
      rows: [
        row("20250410", "G/1", 3000000, partyB),
        row("20250510", "G/2", 3000000, partyB),
      ],
    }]);
    expect(out.events.bookings).toHaveLength(2);
    expect(out.liabilities).toEqual([]);
  });

  it("(d) 194Q straddle: the first post-crossing booking's liableBase is the running-cumulative excess", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: "Purchase - Domestic", section: "194Q" }],
    };
    const cfg = tdsCtx(operator, { dutySectionOf: () => null, panKeyOf: () => "TaxId 999" });
    const out = run(cfg, [], [{
      ledger: "Purchase - Domestic",
      rows: [
        row("20250410", "G/1", 3000000, partyB),
        row("20250510", "G/2", 2500000, partyB),
        row("20250610", "G/3", 1000000, partyB),
      ],
    }]);
    // The pre-crossing booking is never liable (liableBase 0 → below tolerance).
    expect(out.liabilities.map((l) => l.booking.voucherNumber)).toEqual(["G/2", "G/3"]);
    const second = out.liabilities[0];
    // min(25,00,000, 55,00,000 − 50,00,000) = 5,00,000 — the running cumulative,
    // never the year total.
    expect(second.liableBase).toBe(500000);
    expect(second.liability).toBe(500);
    expect(second.rate).toBe(0.001);
    expect(second.deduction).toBeNull();
    // The full gross after the crossing.
    expect(out.liabilities[1].liableBase).toBe(1000000);
    expect(out.liabilities[1].liability).toBe(1000);
  });

  it("(e) liabilities length equals the count of section-known, non-suppressed bookings", () => {
    const op = { ...stdOperator };
    // Three 194C bookings past the aggregate (wholeYear ⇒ all liable), plus one
    // booking on an unmapped (section-null) ledger that must not enter liabilities.
    const out = run(tdsCtx(op), [], [
      { ledger: expenseLedger, rows: [
        row("20250510", "P/12", 250000, partyA),
        row("20250610", "P/13", 250000, partyA),
      ] },
      { ledger: "Unmapped Ledger", rows: [row("20250710", "P/14", 250000, partyA)] },
    ]);
    expect(out.events.bookings).toHaveLength(3);
    const count = out.events.bookings.filter((b) => b.section !== null).length;
    expect(count).toBe(2);
    expect(out.liabilities).toHaveLength(count);
    expect(out.liabilities.every((l) => l.deduction === null)).toBe(true);
  });
});
