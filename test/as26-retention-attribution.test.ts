import { describe, expect, it } from "vitest";
import type { VoucherRow } from "../src/downstream.js";
import { counterpartyOf, projectLedgerRows } from "../src/tds-daybook.js";
import { deductionEvents, rekeyDeductionsToDeductor } from "../src/as26.js";
import { canonicalKey } from "../src/key.js";

// Retention-release journal (2026-09-29). A contractor's retention is
// released, the tax on it is deducted, and the company's own retention and
// warranty buckets are squared off against each other in the same voucher.
// The mirrored pair is the largest opposite-signed line of the tax row, so
// the plain counterparty rule named the warranty bucket and the deduction
// never reached the deductor. Invented names and amounts throughout.
const DEDUCTOR = "Zenith Civil Works";
const RIVAL = "Delta Builders Pvt Ltd";
const RETENTION = "Retention Money Receivable A/c";
const WARRANTY = "Warranty Liability A/c";
const CREDIT_LEDGER = "TDS (FY:26-27) A/c";
const INCOME = "Contract Income (Exempt)";

const release: VoucherRow = {
  date: "20250627",
  voucherType: "Journal",
  voucherNumber: "JV/0410",
  // Tally names the retention bucket as the voucher's party: it is itself a
  // Sundry Debtors ledger, so the party-line fallback cannot tell it apart
  // from the customer.
  partyLedgerName: RETENTION,
  cancelled: false,
  entries: [
    { ledger: RETENTION, amount: 500000 },
    { ledger: CREDIT_LEDGER, amount: 20000 },
    { ledger: "TDS - CGST", amount: 10000 },
    { ledger: "TDS - SGST", amount: 10000 },
    { ledger: WARRANTY, amount: -500000 },
    { ledger: DEDUCTOR, amount: -40000 },
  ],
};

/** The same journal with the mirror pair already excluded from view: the
 * largest opposite-signed line left is an income credit that is NOT a party
 * ledger, so the party-line fallback is what decides the attribution. */
const releaseNoMirror: VoucherRow = {
  ...release,
  entries: [
    { ledger: RETENTION, amount: 300000 },
    { ledger: CREDIT_LEDGER, amount: 20000 },
    { ledger: INCOME, amount: -290000 },
    { ledger: DEDUCTOR, amount: -32000 },
  ],
};

const parentOf = new Map([
  [canonicalKey(DEDUCTOR), "Sundry Debtors"],
  [canonicalKey(RIVAL), "Sundry Debtors"],
  [canonicalKey(RETENTION), "Sundry Debtors"],
  [canonicalKey(INCOME), "Indirect Incomes"],
  [canonicalKey(WARRANTY), "Current Liabilities"],
  [canonicalKey(CREDIT_LEDGER), "Current Assets"],
]);
const isPartyLedger = (n: string): boolean =>
  ["sundry debtors", "sundry creditors"].includes(
    (parentOf.get(canonicalKey(n)) ?? "").toLowerCase(),
  );

const rowsOf = (v: VoucherRow, hint = {}): ReturnType<typeof deductionEvents>["events"] => {
  const byLedger = new Map(
    projectLedgerRows([v], [CREDIT_LEDGER], hint).map((p) => [canonicalKey(p.ledger), p.rows] as const),
  );
  return deductionEvents(byLedger.get(canonicalKey(CREDIT_LEDGER)) ?? [], "tds").events;
};

const OPT_IN = { skipMirroredPairs: true };

describe("26AS retention-release attribution (2026-09-29)", () => {
  it("the mirrored transfer pair is the plain rule's wrong answer", () => {
    // Documented baseline: without the fix the tax row displays against the
    // warranty bucket, and the deduction is filed under it.
    const events = rowsOf(release);
    expect(events).toHaveLength(1);
    expect(events[0].ledgerKey).toBe(canonicalKey(WARRANTY));
    expect(events[0].tax).toBe(20000);
  });

  it("excludes the mirrored pair, so the tax row faces the deductor", () => {
    const events = rowsOf(release, OPT_IN);
    expect(events).toHaveLength(1);
    expect(events[0].ledgerKey).toBe(canonicalKey(DEDUCTOR));
    expect(events[0].tax).toBe(20000);
    expect(rekeyDeductionsToDeductor(events, [release], isPartyLedger)[0].ledgerKey)
      .toBe(canonicalKey(DEDUCTOR));
  });

  it("keeps the plain rule as the default — an asset transfer is a mirror pair too", () => {
    const transfer: VoucherRow = {
      date: "20250701", voucherType: "Journal", voucherNumber: "JV/0411",
      partyLedgerName: "", cancelled: false,
      entries: [
        { ledger: "Plant and Machinery A/c", amount: 120000 },
        { ledger: "Plant and Machinery (Old) A/c", amount: -120000 },
      ],
    };
    expect(counterpartyOf(transfer, 0)).toBe("Plant and Machinery (Old) A/c");
    expect(counterpartyOf(transfer, 0, OPT_IN)).toBe("");
  });

  it("a retention bucket standing in as the party line loses to a mapped deductor on the voucher", () => {
    const events = rowsOf(releaseNoMirror, OPT_IN);
    expect(events[0].ledgerKey).toBe(canonicalKey(INCOME));
    const mapped = new Set([canonicalKey(DEDUCTOR)]);
    const rekeyed = rekeyDeductionsToDeductor(
      events, [releaseNoMirror], isPartyLedger, (n) => mapped.has(canonicalKey(n)),
    );
    expect(rekeyed[0].ledgerKey).toBe(canonicalKey(DEDUCTOR));
    // Unmapped operator map: today's answer stands, and the event surfaces
    // against the retention bucket rather than being dropped.
    expect(rekeyDeductionsToDeductor(events, [releaseNoMirror], isPartyLedger)[0].ledgerKey)
      .toBe(canonicalKey(RETENTION));
  });

  it("two mapped deductors on one voucher is ambiguous, never a guess", () => {
    const two: VoucherRow = {
      ...releaseNoMirror,
      entries: [...releaseNoMirror.entries, { ledger: RIVAL, amount: -1 }],
    };
    const mapped = new Set([canonicalKey(DEDUCTOR), canonicalKey(RIVAL)]);
    const events = rowsOf(two, OPT_IN);
    expect(
      rekeyDeductionsToDeductor(events, [two], isPartyLedger, (n) => mapped.has(canonicalKey(n)))[0]
        .ledgerKey,
    ).toBe(canonicalKey(RETENTION));
  });

  it("a mapped party deductor already facing the row is untouched", () => {
    const mapped = new Set([canonicalKey(DEDUCTOR)]);
    const events = rowsOf(release, OPT_IN);
    expect(
      rekeyDeductionsToDeductor(events, [release], isPartyLedger, (n) => mapped.has(canonicalKey(n)))[0]
        .ledgerKey,
    ).toBe(canonicalKey(DEDUCTOR));
  });
});
