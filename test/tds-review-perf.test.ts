import { describe, expect, it } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { readDayBook } from "../src/tds-daybook.js";

/**
 * Performance regression guard for the TDS review's party→master resolution.
 *
 * `analyzeTds` resolves a booking's party to its ledger master several times
 * per booking (`panKeyOf`, `entityOf`, `deducteeTypeOf`, `certificateRateOf`).
 * When those closures each did a linear `masters.find`, a real company
 * (≈6,800 bookings against ≈2,700 masters) blocked the event loop for 30+
 * minutes. The resolution is now a single Map lookup; with the old linear scan
 * this set does not finish inside its timeout (measured >180 s, killed), while
 * the Map lookup finishes in a few seconds.
 *
 * The shape is deliberate: many bookings against many masters (which drives
 * the per-booking scans) but only a few distinct parties, so the masking sweep
 * — quadratic in findings × vaulted names — stays cheap and the test measures
 * the resolution, not masking. Every name, PAN and figure here is invented.
 */

const DISTINCT_PARTIES = 200;
const BOOKINGS = 6_000;
const FILLER = 5_000;
const EXPENSE = "Site Repairs Contract";
const DUTY = "TDS Contractors";

const partyName = (i: number): string => `Party Ledger ${String(i).padStart(4, "0")}`;

const masters = [
  { name: DUTY, parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  { name: EXPENSE, parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  ...Array.from({ length: DISTINCT_PARTIES }, (_, i) => ({
    name: partyName(i),
    parent: "Sundry Creditors",
    IsTDSApplicable: "Yes",
    TDSDeducteeType: "Firm",
    IncomeTaxNumber: "ABCC1234A",
  })),
  // Inert masters: they exist only to make every linear scan expensive.
  ...Array.from({ length: FILLER }, (_, i) => ({
    name: `Filler Ledger ${String(i).padStart(4, "0")}`,
    parent: "Indirect Expenses",
  })),
];

const groups = [
  { name: "Indirect Expenses", parent: "" },
  { name: "Purchase Accounts", parent: "Indirect Expenses" },
  { name: "Sundry Creditors", parent: "Current Liabilities" },
  { name: "Duties & Taxes", parent: "Current Liabilities" },
];

const vouchers = Array.from({ length: BOOKINGS }, (_, i) => ({
  date: "20250510",
  voucherType: "Purchase",
  voucherNumber: `PU/${i}`,
  partyLedgerName: partyName(i % DISTINCT_PARTIES),
  entries: [
    { LEDGERNAME: EXPENSE, AMOUNT: -50000 },
    { LEDGERNAME: partyName(i % DISTINCT_PARTIES), AMOUNT: 50000 },
  ],
}));

const operator: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: EXPENSE, section: "194C" },
    { ledger: DUTY, section: "194C" },
  ],
};

const bundle = {
  tallyAgentExport: 1,
  fromDate: "20250401",
  toDate: "20260331",
  groups,
  ledgers: masters.map((m) => ({ name: m.name, parent: m.parent })),
  vouchers,
};

describe("TDS review performance", () => {
  it(
    "resolves a few thousand bookings against a few thousand masters well under the bound",
    async () => {
      const s = createSession(
        Object.assign(
          fakeDownstream({
            tally_get_ledgers: JSON.stringify(masters),
            tally_get_groups: JSON.stringify(groups),
          }),
          {
            ledgerVoucherRows: async () => {
              throw new Error("live books must not be read when a day book is given");
            },
          } as never,
        ),
        EMPTY_OVERRIDES,
        EMPTY_WRONG_GROUP,
      );
      const dayBook = readDayBook(JSON.stringify(bundle), {
        fromDate: "20250401",
        toDate: "20260331",
      });

      const started = Date.now();
      const result = await s.tdsReview(
        undefined,
        "20250401",
        "20260331",
        "20260331",
        operator,
        "json",
        undefined,
        dayBook,
      );
      const elapsed = Date.now() - started;

      // The work actually ran: every booking was seen and produced findings.
      expect(result.ledgerCalls).toBe(0);
      expect(result.books?.vouchers).toBe(BOOKINGS);
      expect(result.findings.length).toBeGreaterThan(BOOKINGS / 2);
      // Generous bound: the map-based resolution finishes in a few seconds,
      // while the old per-booking linear scan does not finish in 180 s here.
      expect(elapsed).toBeLessThan(30_000);
    },
    90_000,
  );
});
