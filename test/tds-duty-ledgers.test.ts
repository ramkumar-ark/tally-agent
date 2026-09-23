import { describe, expect, it } from "vitest";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { canonicalKey } from "../src/key.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";

/**
 * Regression: a company whose Tally masters carry **no TDS flags** has an
 * empty master-derived duty set. The operator
 * template's `TDS Duty` rows are the only duty signal, so the engine's duty
 * side must be the union of the two. Before the fix the duty side passed to
 * `analyzeTds` was master-only, so every booking read as undeducted.
 */

const PARTY = "Sample Builders LLP";
const EXPENSE = "Site Repairs Contract";
const DUTY = "TDS Contractors";

// No IsTDSApplicable / TDSDeducteeType on any master: zero TDS flags.
const NO_FLAG_MASTERS = JSON.stringify([
  { name: PARTY, parent: "Sundry Creditors" },
  { name: EXPENSE, parent: "Purchase Accounts" },
  { name: DUTY, parent: "Duties & Taxes" },
]);

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: EXPENSE, section: "194C" },
    { ledger: DUTY, section: "194C", kind: "duty" },
  ],
  parties: [
    { ledger: PARTY, tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
  ],
};

const row = (over: Partial<LedgerVoucherRow>): LedgerVoucherRow => ({
  date: "20250510",
  voucherType: "Purchase",
  voucherNumber: "PU/1",
  reference: "",
  counterparty: PARTY,
  amount: 200000,
  matchStatus: "unknown",
  tax: null,
  ...over,
});

// Booking 1 (PU/1, 10-May) carries a matching duty credit; booking 2 (PU/2,
// 10-Jun) does not. Both cross s.194C's aggregate threshold.
const BOOKING_WITH_DUTY = row({ voucherNumber: "PU/1", amount: 200000 });
const BOOKING_WITHOUT_DUTY = row({ voucherNumber: "PU/2", date: "20250610", amount: 200000 });

const EXPENSE_ROWS = [BOOKING_WITH_DUTY, BOOKING_WITHOUT_DUTY];
const PARTY_ROWS = [
  row({ voucherNumber: "PU/1", amount: -196000, counterparty: EXPENSE }),
  row({ voucherNumber: "PU/2", date: "20250610", amount: -200000, counterparty: EXPENSE }),
];
const DUTY_ROWS = [row({ voucherNumber: "PU/1", amount: -4000, counterparty: PARTY })];

const runReview = async (masters: string) => {
  const byLedger = new Map<string, LedgerVoucherRow[]>([
    [canonicalKey(EXPENSE), EXPENSE_ROWS],
    [canonicalKey(PARTY), PARTY_ROWS],
    [canonicalKey(DUTY), DUTY_ROWS],
  ]);
  const s = createSession(
    Object.assign(fakeDownstream({ tally_get_ledgers: masters }), {
      ledgerVoucherRows: async (_c: unknown, ledger: string, f: string, t: string) => ({
        rows: (byLedger.get(canonicalKey(ledger)) ?? []).filter((r) => r.date >= f && r.date <= t),
        dropped: 0,
      }),
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );
  return s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
};

describe("tdsReview duty side from the operator template", () => {
  it("matches the template's duty credit when the masters carry no TDS flags", async () => {
    const result = await runReview(NO_FLAG_MASTERS);
    const notDeducted = result.findings.filter((f) => f.check === "tds_not_deducted");
    // Only the booking with no duty credit is undeducted; the matched one is not.
    expect(notDeducted).toHaveLength(1);
    expect(notDeducted[0].detail).toContain("10-Jun-2025");
    expect(notDeducted[0].detail).not.toContain("10-May-2025");
  });

  it("keeps master-flagged duty ledgers working when flags exist", async () => {
    const flagged = JSON.stringify([
      { name: PARTY, parent: "Sundry Creditors", IsTDSApplicable: "Yes" },
      { name: EXPENSE, parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
      { name: DUTY, parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
    ]);
    const result = await runReview(flagged);
    const notDeducted = result.findings.filter((f) => f.check === "tds_not_deducted");
    expect(notDeducted).toHaveLength(1);
    expect(notDeducted[0].detail).toContain("10-Jun-2025");
  });
});
