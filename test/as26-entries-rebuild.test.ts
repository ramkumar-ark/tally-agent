// Invented fixtures only. The 26AS live read (2026-09-29): the deduction side
// is rebuilt from the voucher composition the connector attaches behind
// `includeEntries`, and must reach the same per-party books figures the
// day-book path does — including the two journals the display counterparty
// alone gets wrong (a retention release, and a gross-up journal).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { parseAs26Export } from "../src/as26-file.js";
import { vouchersFromLedgerRows } from "../src/as26.js";
import { buildAs26Fixture } from "./as26-fixture.js";
import type { DayBookInput } from "../src/tds-daybook.js";
import type { Downstream, LedgerVoucherRow, VoucherEntry, VoucherRow } from "../src/downstream.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

// --- the invented company's masters -----------------------------------------
const GROUPS = [
  { name: "Current Assets", parent: "" },
  { name: "Loans & Advances", parent: "Current Assets" },
  { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Current Liabilities", parent: "" },
  { name: "Sales Accounts", parent: "" },
  { name: "Indirect Expenses", parent: "" },
];
const LEDGERS = [
  { name: "TDS Receivable", parent: "Loans & Advances" },
  { name: "Anand Buildmart Pvt Ltd", parent: "Sundry Debtors" },
  { name: "Retention Money Receivable", parent: "Sundry Debtors" },
  { name: "Retention Payable", parent: "Current Liabilities" },
  { name: "Works Contract Service", parent: "Sales Accounts" },
  { name: "Hire Charges", parent: "Indirect Expenses" },
];
/** A voucher as the day book (or the live `tally_get_vouchers` read) carries it. */
const voucher = (
  date: string, voucherType: string, voucherNumber: string, partyLedgerName: string,
  entries: VoucherEntry[],
): VoucherRow => ({ date, voucherType, voucherNumber, partyLedgerName, cancelled: false, entries });

/** The display rows the Ledger Vouchers report shows for the queried ledger
 * (one per entry of that ledger), with the composition the connector attached.
 * `displayCounterparty` is what the report shows as the other side — on two of
 * these vouchers that is exactly the wrong answer. */
const reportRows = (
  v: VoucherRow, displayCounterparty: string, opts: { attached?: boolean; side?: "debit" | "credit" } = {},
): LedgerVoucherRow[] => {
  const attached = opts.attached ?? true;
  return v.entries
    .filter((e) => e.ledger === TDS)
    .map((e) => ({
      date: v.date,
      voucherType: v.voucherType,
      voucherNumber: v.voucherNumber,
      reference: "",
      counterparty: displayCounterparty,
      amount: e.amount,
      matchStatus: "matched" as const,
      tax: null,
      ...(attached
        ? {
            entries: v.entries,
            voucherParty: v.partyLedgerName,
            entryMatchBasis: "guid",
          }
        : {}),
    }));
};

const TDS = "TDS Receivable";
const PARTY = "Anand Buildmart Pvt Ltd";
const RETENTION = "Retention Money Receivable";
const RETENTION_PAYABLE = "Retention Payable";
const INCOME = "Works Contract Service";

// 1. the ordinary two-line TDS journal: the display counterparty is right here
const ordinary = voucher("20250612", "Journal", "JV/1", PARTY, [
  { ledger: TDS, amount: 2300 },
  { ledger: PARTY, amount: -2300 },
]);
// 2. the retention release: a mirrored internal transfer beside the tax lines.
//    The plain display counterparty of the tax row is the warranty bucket.
const release = voucher("20250801", "Journal", "JV/2", RETENTION, [
  { ledger: RETENTION, amount: 450000 },
  { ledger: RETENTION_PAYABLE, amount: -450000 },
  { ledger: TDS, amount: 25000 },
  { ledger: PARTY, amount: -475000 },
]);
// 3. the gross-up journal: the tax row's largest opposite-sign line is income
const grossUp = voucher("20250901", "Journal", "JV/3", PARTY, [
  { ledger: TDS, amount: 4400 },
  { ledger: PARTY, amount: 220000 },
  { ledger: INCOME, amount: -224400 },
]);
// the sale the deductions hang off (check 003 / bill linkage)
const sale = voucher("20250605", "Sales", "CS/9", PARTY, [
  { ledger: PARTY, amount: 230000 },
  { ledger: INCOME, amount: -230000 },
]);

const ALL_VOUCHERS = [sale, ordinary, release, grossUp];
/** Every receivable-ledger display row, with the WRONG counterparty the
 *  display report would show where the composition is the honest answer. */
const ALL_ROWS = [
  ...reportRows(ordinary, PARTY),
  ...reportRows(release, RETENTION_PAYABLE),
  ...reportRows(grossUp, INCOME),
];

const dayBook: DayBookInput = {
  shape: "bundle",
  company: "Demo Traders Pvt Ltd",
  groups: GROUPS,
  ledgers: LEDGERS,
  vouchers: ALL_VOUCHERS,
  observedFrom: "20250605",
  observedTo: "20250901",
  rejected: 0,
  emptyMonths: [],
};

const masters = LEDGERS.map((l) => ({
  name: l.name, parent: l.parent, gstin: null, state: "", pan: null,
  isTdsApplicable: false, tdsDeducteeType: "", natureOfPayment: null,
}));

interface FakeOpts { rows?: LedgerVoucherRow[]; entriesAttached?: number | undefined }
interface Seen { ledger: string; from: string; to: string; includeEntries: unknown }
const fake = (opts: FakeOpts = {}, seen: Seen[] = []): [Downstream, Seen[]] => [{
  groups: async () => GROUPS,
  ledgersTax: async () => masters as never,
  vouchers: async () => ALL_VOUCHERS as never,
  ledgerVoucherRows: async (
    _c: unknown, ledger: string, from: string, to: string, o?: { includeEntries?: boolean },
  ) => {
    seen.push({ ledger, from, to, includeEntries: o?.includeEntries });
    const rows = (opts.rows ?? ALL_ROWS).filter((r) => r.date >= from && r.date <= to);
    return {
      rows: ledger === TDS ? rows : [],
      dropped: 0,
      // A build older than includeEntries answers without the field at all.
      ...(opts.entriesAttached === undefined ? {} : { entriesAttached: opts.entriesAttached }),
    };
  },
  callRaw: async () => { throw new Error("not used"); },
  listCompanies: async () => ["Demo Traders Pvt Ltd"],
  trialBalance: async () => { throw new Error("not used"); },
  ledgers: async () => LEDGERS as never,
  ledgerVouchers: async () => [] as never,
  close: async () => {},
} as never as Downstream, seen];

const mapFile = (): string => {
  const p = join(tempDir("as26-entries-map-"), "as26-map.json");
  writeFileSync(p, JSON.stringify({ mappings: [{ ledger: PARTY, as26Name: PARTY }] }));
  return p;
};
const file = parseAs26Export(buildAs26Fixture());
const run = (d: Downstream, dayBookIn?: DayBookInput) =>
  createSession(d, EMPTY_OVERRIDES, EMPTY_WRONG_GROUP)
    .as26Review("Demo Traders Pvt Ltd", "20250601", "20250930", file, mapFile(), dayBookIn);

/** Per-party books tax as the tool reports it (pseudonyms on both sides). */
const booksByParty = (res: { recon: Array<{ match: { as26Name: string }; booksTax: number }> }): Record<string, number> =>
  Object.fromEntries(res.recon.map((r) => [r.match.as26Name, r.booksTax]));

describe("vouchersFromLedgerRows (the live read's rebuild)", () => {
  const row = (o: Partial<LedgerVoucherRow>): LedgerVoucherRow => ({
    date: "20250801", voucherType: "Journal", voucherNumber: "JV/2", reference: "",
    counterparty: "display only", amount: 25000, matchStatus: "matched", tax: null, ...o,
  });

  it("rebuilds a day-book-shaped voucher from one attached row", () => {
    const out = vouchersFromLedgerRows(reportRows(release, RETENTION_PAYABLE));
    expect(out.unattached).toEqual([]);
    expect(out.vouchers).toHaveLength(1);
    expect(out.vouchers[0]).toEqual({
      date: "20250801", voucherType: "Journal", voucherNumber: "JV/2",
      partyLedgerName: RETENTION, cancelled: false,
      entries: release.entries,
    });
  });

  it("collapses the same voucher seen through two receivable ledgers", () => {
    const twice = [...reportRows(release, RETENTION_PAYABLE), ...reportRows(release, RETENTION_PAYABLE)];
    expect(vouchersFromLedgerRows(twice).vouchers).toHaveLength(1);
  });

  it("keeps two different vouchers that share a number apart", () => {
    const a = row({ entries: [{ ledger: TDS, amount: 100 }, { ledger: PARTY, amount: -100 }] });
    const b = row({ entries: [{ ledger: TDS, amount: 200 }, { ledger: PARTY, amount: -200 }] });
    const out = vouchersFromLedgerRows([a, b]);
    expect(out.vouchers).toHaveLength(2);
  });

  it("treats a re-ordered composition as the same voucher", () => {
    const a = row({ entries: [{ ledger: TDS, amount: 100 }, { ledger: PARTY, amount: -100 }] });
    const b = row({ entries: [{ ledger: PARTY, amount: -100 }, { ledger: TDS, amount: 100 }] });
    expect(vouchersFromLedgerRows([a, b]).vouchers).toHaveLength(1);
  });

  it("never rebuilds an unattached row, and reports it instead", () => {
    const attached = reportRows(ordinary, PARTY);
    const orphan = { ...row({ date: "20250915", voucherNumber: "JV/9", amount: 7700 }) };
    const out = vouchersFromLedgerRows([...attached, orphan]);
    expect(out.vouchers).toHaveLength(1);
    expect(out.unattached).toEqual([{ date: "20250915", amount: 7700 }]);
  });

  it("ignores an empty composition as unknown, not as a one-sided voucher", () => {
    const out = vouchersFromLedgerRows([row({ entries: [] })]);
    expect(out.vouchers).toEqual([]);
    expect(out.unattached).toHaveLength(1);
  });
});

describe("the 26AS live read, with the attached voucher composition", () => {
  it("asks for the composition on every receivable-ledger read", async () => {
    const [d, seen] = fake();
    await run(d);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.ledger).toBe(TDS);
      expect(s.includeEntries).toBe(true);
    }
  });

  it("reaches the same per-party books tax the day book does", async () => {
    const live = await run(fake()[0]);
    const book = await run(fake()[0], dayBook);
    expect(booksByParty(live)).toEqual(booksByParty(book));
    expect(live.totals.booksTax).toBe(book.totals.booksTax);
  });

  it("attributes the retention release and the gross-up journal to the deductor, not to the bucket the display column names", async () => {
    const live = await run(fake()[0]);
    const book = await run(fake()[0], dayBook);
    // One party, and its books tax is the whole of TDS Receivable's debits
    // (2,300 + 25,000 + 4,400): the mirrored retention⇄warranty pair, the
    // income line and the retention bucket are all excluded, on both paths.
    const books = booksByParty(live);
    expect(Object.values(books)).toEqual([31700]);
    expect(Object.values(books)).toEqual(Object.values(booksByParty(book)));
    expect(JSON.stringify(live)).not.toContain("Anand Buildmart");
    expect(JSON.stringify(live)).not.toContain(RETENTION);
  });

  it("counts a row the connector could not join, and never attributes it", async () => {
    const { entries: _e, voucherParty: _p, entryMatchBasis: _b, ...orphan } = {
      ...reportRows(grossUp, INCOME)[0],
      date: "20250915", voucherNumber: "JV/9", amount: 9000,
    };
    const withOrphan = await run(fake({ rows: [...ALL_ROWS, orphan] })[0]);
    const f = withOrphan.findings.find((x) => x.check === "live_rows_unattached");
    expect(f).toBeDefined();
    expect(f!.id).toBe("AS26-012-1");
    expect(f!.severity).toBe("review");
    expect(f!.detail).toContain("15-Sep-2025");
    expect(f!.detail).toContain("9,000.00");
    // The unattached row's tax is in nobody's books tax — and the other rows
    // are still read exactly as before, so the gap is stated, not hidden.
    expect(withOrphan.totals.booksTax).toBe(31700);
    expect(Object.values(booksByParty(withOrphan))).toEqual([31700]);
  });

  it("reads the sales side live exactly as it does from the bundle", async () => {
    const live = await run(fake()[0]);
    const book = await run(fake()[0], dayBook);
    expect(live.billRows.map((b) => [b.kind, b.tax])).toEqual(book.billRows.map((b) => [b.kind, b.tax]));
  });
});
