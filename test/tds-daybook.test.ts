import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { VoucherRow } from "../src/downstream.js";
import { counterpartyOf, projectLedgerRows } from "../src/tds-daybook.js";

const purchase: VoucherRow = {
  date: "20250510",
  voucherType: "Purchase",
  voucherNumber: "PU/0012",
  partyLedgerName: "Acme Contracting",
  cancelled: false,
  entries: [
    { ledger: "Site Expenses", amount: 25000 },
    { ledger: "Acme Contracting", amount: -25000 },
  ],
};

const split: VoucherRow = {
  date: "20250612",
  voucherType: "Journal",
  voucherNumber: "JV/0007",
  partyLedgerName: "Acme Contracting",
  cancelled: false,
  entries: [
    { ledger: "Site Expenses", amount: 90000 },
    { ledger: "Acme Contracting", amount: -88000 },
    { ledger: "TDS on Contracts", amount: -2000 },
  ],
};

describe("counterpartyOf", () => {
  it("faces a two-line voucher's other side", () => {
    expect(counterpartyOf(purchase, 0)).toBe("Acme Contracting");
    expect(counterpartyOf(purchase, 1)).toBe("Site Expenses");
  });

  it("picks the largest opposite-signed line on a split voucher", () => {
    expect(counterpartyOf(split, 0)).toBe("Acme Contracting");
  });

  it("makes a duty line face the expense line", () => {
    expect(counterpartyOf(split, 2)).toBe("Site Expenses");
  });

  it("falls back to the voucher's party ledger when no opposite side exists", () => {
    const single: VoucherRow = {
      ...purchase,
      entries: [{ ledger: "Site Expenses", amount: 25000 }],
    };
    expect(counterpartyOf(single, 0)).toBe("Acme Contracting");
  });
});

describe("projectLedgerRows", () => {
  it("emits one row per requested ledger line, signed for that ledger", () => {
    const out = projectLedgerRows([purchase, split], [
      "Site Expenses",
      "Acme Contracting",
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].ledger).toBe("Site Expenses");
    expect(out[0].rows.map((r) => r.amount)).toEqual([25000, 90000]);
    expect(out[1].ledger).toBe("Acme Contracting");
    expect(out[1].rows.map((r) => r.amount)).toEqual([-25000, -88000]);
  });

  it("matches ledgers case-insensitively but reports the requested spelling", () => {
    const out = projectLedgerRows([purchase], ["site expenses"]);
    expect(out).toHaveLength(1);
    expect(out[0].ledger).toBe("site expenses");
    expect(out[0].rows).toHaveLength(1);
  });

  it("returns an empty rows list for a ledger the vouchers never touch", () => {
    const out = projectLedgerRows([purchase], ["Unused Ledger"]);
    expect(out).toEqual([{ ledger: "Unused Ledger", rows: [] }]);
  });

  it("skips cancelled vouchers", () => {
    const out = projectLedgerRows([{ ...purchase, cancelled: true }], [
      "Site Expenses",
    ]);
    expect(out[0].rows).toEqual([]);
  });

  it("whitelists exactly the day-book row shape", () => {
    const out = projectLedgerRows([purchase], ["Site Expenses"]);
    expect(out[0].rows[0]).toEqual({
      date: "20250510",
      voucherType: "Purchase",
      voucherNumber: "PU/0012",
      reference: "",
      counterparty: "Acme Contracting",
      amount: 25000,
      matchStatus: "unknown",
      tax: null,
    });
  });

  it("coerces numeric dates and voucher numbers to strings", () => {
    const numeric: VoucherRow = {
      ...purchase,
      date: 20250510 as unknown as string,
      voucherNumber: 12 as unknown as string,
    };
    const out = projectLedgerRows([numeric], ["Site Expenses"]);
    expect(out[0].rows[0].date).toBe("20250510");
    expect(out[0].rows[0].voucherNumber).toBe("12");
  });
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDayBookText, readDayBook } from "../src/tds-daybook.js";

const raw = (date: number, num: string) => ({
  date: String(date),
  voucherType: "Purchase",
  voucherNumber: num,
  partyLedgerName: "Acme Contracting",
  entries: [
    { LEDGERNAME: "Site Expenses", AMOUNT: -25000 },
    { LEDGERNAME: "Acme Contracting", AMOUNT: 25000 },
  ],
});

const year = [raw(20250510, "PU/1"), raw(20250612, "PU/2"), raw(20260115, "PU/3")];
const opts = { fromDate: "20250401", toDate: "20260331" };

describe("readDayBook", () => {
  it("accepts a bare array and reports its shape", () => {
    const out = readDayBook(JSON.stringify(year), opts);
    expect(out.shape).toBe("array");
    expect(out.vouchers).toHaveLength(3);
    expect(out.company).toBeNull();
  });

  it("accepts a { vouchers } envelope", () => {
    const out = readDayBook(JSON.stringify({ vouchers: year }), opts);
    expect(out.shape).toBe("envelope");
    expect(out.vouchers).toHaveLength(3);
  });

  it("accepts a bundle and carries its masters through", () => {
    const bundle = {
      tallyAgentExport: 1,
      company: "Example Infra",
      fromDate: "20250401",
      toDate: "20260331",
      groups: [{ name: "Indirect Expenses", parent: "" }],
      ledgers: [{ name: "Site Expenses", parent: "Indirect Expenses" }],
      vouchers: year,
    };
    const out = readDayBook(JSON.stringify(bundle), { ...opts, company: "example infra" });
    expect(out.shape).toBe("bundle");
    // Additive identity fields null out for an old-shape ledger row (2026-09-26).
    expect(out.ledgers).toEqual([
      { name: "Site Expenses", parent: "Indirect Expenses", pan: null, gstin: null, address: null, openingBalance: null },
    ]);
  });

  it("refuses a truncated file without mentioning its contents", () => {
    const truncated = JSON.stringify(year).slice(0, 120);
    expect(() => readDayBook(truncated, opts)).toThrow(/not valid JSON.*truncated/i);
  });

  it("refuses a file that is not an array, an envelope or a bundle", () => {
    expect(() => readDayBook(JSON.stringify({ rows: year }), opts)).toThrow(/day-book file/i);
  });

  it("refuses a bundle naming a different company, without echoing either name", () => {
    const bundle = { tallyAgentExport: 1, company: "Other Entity", vouchers: year };
    try {
      readDayBook(JSON.stringify(bundle), { ...opts, company: "Example Infra" });
      throw new Error("expected a refusal");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toMatch(/different company/i);
      expect(m).not.toMatch(/Other Entity|Example Infra/);
    }
  });

  it("refuses a bundle whose declared period does not cover the review", () => {
    const bundle = { tallyAgentExport: 1, fromDate: "20250401", toDate: "20250930", vouchers: year };
    expect(() => readDayBook(JSON.stringify(bundle), opts)).toThrow(/does not cover/i);
  });

  it("refuses a bundle holding vouchers outside its own declared period", () => {
    const bundle = { tallyAgentExport: 1, fromDate: "20250401", toDate: "20260331", vouchers: [raw(20240510, "PU/9")] };
    expect(() => readDayBook(JSON.stringify(bundle), opts)).toThrow(/misdescribes itself/i);
  });

  it("refuses a file with no voucher in any month of the review period", () => {
    const wrongYear = [raw(20240510, "PU/1")];
    expect(() => readDayBook(JSON.stringify(wrongYear), opts)).toThrow(/no voucher in any month/i);
  });

  it("reports interior empty months rather than refusing", () => {
    const out = readDayBook(JSON.stringify(year), opts);
    expect(out.emptyMonths).toContain("2025-07");
    expect(out.emptyMonths).not.toContain("2025-05");
  });

  it("counts rows it could not turn into a voucher", () => {
    const out = readDayBook(JSON.stringify([...year, { nonsense: true }]), opts);
    expect(out.rejected).toBe(1);
    expect(out.vouchers).toHaveLength(3);
  });

  it("records the observed span", () => {
    const out = readDayBook(JSON.stringify(year), opts);
    expect(out.observedFrom).toBe("20250510");
    expect(out.observedTo).toBe("20260115");
  });
});

describe("loadDayBookText", () => {
  it("refuses a file over the ceiling and says what to do instead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daybook-"));
    const path = join(dir, "big.json");
    await writeFile(path, "x".repeat(2048), "utf8");
    await expect(loadDayBookText(path, 1024)).rejects.toThrow(/too large.*quarter/i);
  });

  it("reads a file inside the ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daybook-"));
    const path = join(dir, "ok.json");
    await writeFile(path, "[]", "utf8");
    await expect(loadDayBookText(path, 1024)).resolves.toBe("[]");
  });
});

import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";

const REVIEW_MASTERS = JSON.stringify([
  { name: "Sample Builders LLP", parent: "Sundry Creditors", state: "Karnataka", IncomeTaxNumber: "ABCC1234A", IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
  { name: "Site Repairs Contract", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  { name: "TDS Contractors", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
]);

// Same three-ledger operator file the live-path review tests use.
const REVIEW_OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: "Site Repairs Contract", section: "194C" },
    { ledger: "TDS Contractors", section: "194C" },
  ],
  parties: [
    { ledger: "Sample Builders LLP", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
  ],
};

// A 194C booking on the expense side (positive = debit after the gateway flip).
const revRaw = (date: number, gross: number) => ({
  date: String(date),
  voucherType: "Purchase",
  voucherNumber: `PU/${date}`,
  partyLedgerName: "Sample Builders LLP",
  entries: [
    { LEDGERNAME: "Site Repairs Contract", AMOUNT: -gross },
    { LEDGERNAME: "Sample Builders LLP", AMOUNT: gross },
  ],
});

const revYear = [revRaw(20250510, 25000), revRaw(20250612, 25000), revRaw(20260115, 25000)];

/**
 * Day-book review harness: a session whose Ledger-Vouchers fetch would fail
 * the test if ever called (the day book must replace it entirely).
 */
const runTdsReviewWithDayBook = async (
  vouchers: unknown[],
  o: { fromDate: string; toDate: string },
) => {
  const calls: string[] = [];
  const s = createSession(
    Object.assign(fakeDownstream({ tally_get_ledgers: REVIEW_MASTERS }), {
      ledgerVoucherRows: async (_c: unknown, ledger: string) => {
        calls.push(ledger);
        return { rows: [], dropped: 0 } as never;
      },
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );
  const dayBook = readDayBook(JSON.stringify(vouchers), o);
  const result = await s.tdsReview(
    undefined, o.fromDate, o.toDate, o.toDate, REVIEW_OPERATOR, "json", undefined, dayBook,
  );
  return { result, calls };
};

describe("tdsReview with a day book", () => {  it("makes no ledger-voucher call and reports zero", async () => {
    const { result, calls } = await runTdsReviewWithDayBook(revYear, { fromDate: "20250401", toDate: "20260331" });
    expect(result.ledgerCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  it("ignores vouchers outside the review period", async () => {
    const { result } = await runTdsReviewWithDayBook(revYear, { fromDate: "20250401", toDate: "20250531" });
    expect(result.findings.every((f) => f.check !== "tds_daybook_rows_rejected")).toBe(true);
    // the June and January vouchers must not reach the engine
    expect(result.totals.bySection.reduce((a, t) => a + t.gross, 0)).toBe(25000);
  });

  it("raises a critical finding for each empty month, naming the month", async () => {
    const { result } = await runTdsReviewWithDayBook(revYear, { fromDate: "20250401", toDate: "20260331" });
    const gaps = result.findings.filter((f) => f.check === "tds_daybook_month_empty");
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((f) => f.severity === "critical")).toBe(true);
    expect(gaps.some((f) => f.detail.includes("Jul-2025"))).toBe(true);
  });

  it("raises a critical finding when rows were rejected", async () => {
    const { result } = await runTdsReviewWithDayBook([...revYear, { nonsense: true }], { fromDate: "20250401", toDate: "20260331" });
    const f = result.findings.find((x) => x.check === "tds_daybook_rows_rejected");
    expect(f?.severity).toBe("critical");
  });

  it("raises a review finding when the file could not be checked against company or period", async () => {
    const { result } = await runTdsReviewWithDayBook(revYear, { fromDate: "20250401", toDate: "20260331" });
    expect(result.findings.some((f) => f.check === "tds_daybook_unverified")).toBe(true);
  });

  it("leaves no ledger name in a day-book finding", async () => {
    const { result } = await runTdsReviewWithDayBook(revYear, { fromDate: "20250401", toDate: "20260331" });
    for (const f of result.findings.filter((x) => x.check.startsWith("tds_daybook_"))) {
      expect(f.deductee).toBe("(day-book file)");
      expect(f.detail).not.toMatch(/Acme|Site Repairs|Sample Builders/);
    }
  });
});

/**
 * Live-path harness: Ledger-Vouchers rows are fetched from a fake downstream
 * (positive = debit after the gateway flip), as at review time with no day book.
 */
const runTdsReviewLive = async (o: { fromDate: string; toDate: string }) => {
  const s = createSession(
    Object.assign(fakeDownstream({ tally_get_ledgers: REVIEW_MASTERS }), {
      ledgerVoucherRows: async (_c: unknown, _ledger: string) => ({
        rows: [{
          date: "20250510", voucherType: "Purchase", voucherNumber: "PU/1",
          reference: "", counterparty: "Sample Builders LLP",
          amount: 25000, matchStatus: "unknown", tax: null,
        }],
        dropped: 0,
      } as never),
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );
  const result = await s.tdsReview(
    undefined, o.fromDate, o.toDate, o.toDate, REVIEW_OPERATOR, "json", undefined,
  );
  return { result };
};

describe("books provenance", () => {
  it("says live when no day book is given", async () => {
    const { result } = await runTdsReviewLive({ fromDate: "20250401", toDate: "20250531" });
    expect(result.booksSource).toBe("live");
    expect(result.books).toBeUndefined();
  });

  it("says daybook-file and reports counts and observed span", async () => {
    const { result } = await runTdsReviewWithDayBook(revYear, { fromDate: "20250401", toDate: "20260331" });
    expect(result.booksSource).toBe("daybook-file");
    expect(result.books).toMatchObject({
      vouchers: 3,
      rejected: 0,
      fromObserved: "20250510",
      toObserved: "20260115",
      mastersSource: "live",
    });
  });

  it("never carries a digest or a byte count in the result", async () => {
    const { result } = await runTdsReviewWithDayBook(revYear, { fromDate: "20250401", toDate: "20260331" });
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{32}/);
    expect(Object.keys(result.books ?? {})).not.toContain("bytes");
  });
});

/**
 * Real operator export layout (structure verified against a genuine
 * tallymessage export; all names, figures and numbers below are invented).
 * Six facts the reader must handle: tallymessage envelope, string amounts,
 * raw Tally sign (negative = debit, flipped once in parseVoucherRows),
 * item-invoice lines reaching into allinventoryentries accounting
 * allocations, custom voucher types passed through as named, and UTF-16 LE
 * BOM encoding.
 */
describe("readDayBook: real operator export layout", () => {
  const rawEntry = (ledgername: string, amount: number | string) => ({
    ledgername,
    amount: String(amount),
    ispartyledger: false,
  });

  /** An accounting-entries voucher: every line in allledgerentries. */
  const ledgerRaw = (over: Record<string, unknown>) => ({
    date: "20250620",
    vouchertypename: "Journal",
    vouchernumber: "JV-0001",
    partyledgername: "Ravi Steel Traders",
    allledgerentries: [
      { ...rawEntry("Steel Fabrication Charges", -23500), ispartyledger: false },
      { ...rawEntry("Ravi Steel Traders", 23500), ispartyledger: true },
    ],
    ledgerentries: [],
    allinventoryentries: [],
    ...over,
  });

  /** An item-invoice voucher: expense lines live in the item allocations. */
  const itemRaw = (over: Record<string, unknown>) => ({
    date: "20250705",
    vouchertypename: "Purchase",
    vouchernumber: "P/L-0102",
    partyledgername: "Ravi Steel Traders",
    allledgerentries: [],
    ledgerentries: [
      { ...rawEntry("Ravi Steel Traders", 29500), ispartyledger: true },
      { ...rawEntry("CGST", 1300), ispartyledger: false },
      { ...rawEntry("SGST", 1300), ispartyledger: false },
    ],
    allinventoryentries: [
      {
        stockitemname: "TMT Bars",
        accountingallocations: [
          { ...rawEntry("Steel Fabrication Charges", -23500), ispartyledger: false },
        ],
      },
      {
        stockitemname: "Rounds",
        accountingallocations: [{ ...rawEntry("Freight Inward", -1700), ispartyledger: false }],
      },
    ],
    ...over,
  });

  it("reads the tallymessage envelope shape", () => {
    const db = readDayBook(JSON.stringify({ tallymessage: [ledgerRaw({})] }), {
      fromDate: "20250401",
      toDate: "20260331",
    });
    expect(db.shape).toBe("tallymessage");
    expect(db.vouchers.length).toBe(1);
    expect(db.rejected).toBe(0);
  });

  it("counts rows it cannot make into vouchers as rejected", () => {
    const db = readDayBook(
      JSON.stringify({ tallymessage: [ledgerRaw({}), { junk: "row" }] }),
      { fromDate: "20250401", toDate: "20260331" },
    );
    expect(db.vouchers.length).toBe(1);
    expect(db.rejected).toBe(1);
  });

  it("reads string amounts on raw Tally sign (negative = debit, shown positive = debit downstream)", async () => {
    const db = readDayBook(JSON.stringify({ tallymessage: [ledgerRaw({})] }), {
      fromDate: "20250401",
      toDate: "20260331",
    });
    const booking = db.vouchers[0].entries.find(
      (e) => e.ledger === "Steel Fabrication Charges",
    );
    expect(booking?.amount).toBe(23500);
    const out = projectLedgerRows(db.vouchers, ["Steel Fabrication Charges"]);
    expect(out[0].rows[0]).toMatchObject({
      counterparty: "Ravi Steel Traders",
      amount: 23500,
      matchStatus: "unknown",
    });
  });

  it("collects expense lines from inventory accounting allocations on an item-invoice voucher", async () => {
    const db = readDayBook(
      JSON.stringify({ tallymessage: [ledgerRaw({}), itemRaw({})] }),
      { fromDate: "20250401", toDate: "20260331" },
    );
    const out = projectLedgerRows(db.vouchers, ["Steel Fabrication Charges"]);
    // both voucher shapes land a booking row on the expense ledger
    expect(out[0].rows.map((r) => r.amount)).toEqual([23500, 23500]);
    // and the party + tax lines from ledgerentries still project
    const party = projectLedgerRows(db.vouchers, ["Ravi Steel Traders"]);
    expect(party[0].rows.map((r) => r.amount)).toEqual([-23500, -29500]);
  });

  it("passes custom voucher types through as named", () => {
    const db = readDayBook(
      JSON.stringify({
        tallymessage: [ledgerRaw({ vouchertypename: "RENTAL INVOICE", vouchernumber: "R-77" })],
      }),
      { fromDate: "20250401", toDate: "20260331" },
    );
    expect(db.vouchers[0].voucherType).toBe("RENTAL INVOICE");
    expect(db.vouchers[0].voucherNumber).toBe("R-77");
  });

  it("deletes cancelled and deleted vouchers like the live day book does", () => {
    const db = readDayBook(
      JSON.stringify({
        tallymessage: [ledgerRaw({}), ledgerRaw({ iscancelled: true }), ledgerRaw({ isdeleted: true })],
      }),
      { fromDate: "20250401", toDate: "20260331" },
    );
    const out = projectLedgerRows(db.vouchers, ["Steel Fabrication Charges"]);
    expect(out[0].rows.length).toBe(1);
  });
});

const invoiceRaw = () => ({
  date: "20250620",
  vouchertypename: "Purchase",
  vouchernumber: "P/L-0001",
  partyledgername: "Ravi Steel Traders",
  allledgerentries: [
    { ledgername: "Steel Fabrication Charges", amount: "-23500" },
    { ledgername: "Ravi Steel Traders", amount: "23500" },
  ],
  ledgerentries: [],
  allinventoryentries: [],
});

describe("loadDayBookText: encodings", () => {
  it("decodes UTF-16 LE with BOM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "db-"));
    const file = join(dir, "daybook.json");
    await writeFile(file, `\uFEFF${JSON.stringify({ tallymessage: [invoiceRaw()] })}`, "utf16le");
    const text = await loadDayBookText(file, 1024 * 1024);
    const db = readDayBook(text, { fromDate: "20250401", toDate: "20260331" });
    expect(db.shape).toBe("tallymessage");
  });

  it("still reads plain UTF-8 without a BOM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "db-"));
    const file = join(dir, "daybook.json");
    await writeFile(file, JSON.stringify({ tallymessage: [invoiceRaw()] }), "utf8");
    const text = await loadDayBookText(file, 1024 * 1024);
    expect(readDayBook(text, { fromDate: "20250401", toDate: "20260331" }).shape).toBe("tallymessage");
  });
});

/**
 * Tally-free harness: the downstream's groups tree (and any live book read)
 * fails the test if the review ever reaches for Tally.
 */
const runTdsReviewOffline = async (bundle: unknown, o: { fromDate: string; toDate: string }) => {
  const s = createSession(
    Object.assign(fakeDownstream({}), {
      groups: async () => {
        throw new Error("tally unreachable");
      },
      ledgersTax: async () => {
        throw new Error("tally unreachable");
      },
      ledgerVoucherRows: async () => {
        throw new Error("live books must not be read when a day book is given");
      },
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );
  const dayBook = readDayBook(JSON.stringify(bundle), o);
  return {
    result: await s.tdsReview(
      undefined, o.fromDate, o.toDate, o.toDate, REVIEW_OPERATOR, "json", undefined, dayBook,
    ),
  };
};

// An offline bundle whose masters cover a different ledger set than reviewYard's
// fixtures exercise: Site Expenses (expense side) and Acme Contracting (party).
const offlineBundle = {
  tallyAgentExport: 1,
  company: "Example Infra",
  fromDate: "20250401",
  toDate: "20260331",
  groups: [
    { name: "Indirect Expenses", parent: "" },
    { name: "Sundry Creditors", parent: "Current Liabilities" },
  ],
  ledgers: [
    { name: "Site Expenses", parent: "Indirect Expenses" },
    { name: "Acme Contracting", parent: "Sundry Creditors" },
  ],
  vouchers: revYear,
};

describe("Tally-free run", () => {
  it("completes when groups and masters both fail, using the bundle's masters", async () => {
    const { result } = await runTdsReviewOffline(offlineBundle, { fromDate: "20250401", toDate: "20260331" });
    expect(result.mastersAvailable).toBe(false);
    expect(result.books?.mastersSource).toBe("bundle");
    expect(result.ledgerCalls).toBe(0);
  });

  it("completes when the bundle carries no masters either, and says so", async () => {
    const { result } = await runTdsReviewOffline(
      { tallyAgentExport: 1, vouchers: revYear },
      { fromDate: "20250401", toDate: "20260331" },
    );
    expect(result.books?.mastersSource).toBe("absent");
  });

  it("default-masks a ledger whose group is unknown and raises a review finding", async () => {
    const { result } = await runTdsReviewOffline(
      { tallyAgentExport: 1, vouchers: revYear },
      { fromDate: "20250401", toDate: "20260331" },
    );
    const unmastered = result.findings.filter((f) => f.check === "tds_daybook_ledger_unmastered");
    expect(unmastered.length).toBeGreaterThan(0);
    expect(unmastered.every((f) => f.severity === "review")).toBe(true);
    // the real names must not survive anywhere in the output
    expect(JSON.stringify(result)).not.toMatch(/Acme Contracting|Sample Builders LLP|Site Repairs Contract|TDS Contractors/);
  });
});
