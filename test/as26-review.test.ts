import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { buildAs26Fixture, defaultAs26Fixture } from "./as26-fixture.js";
import { parseAs26Export } from "../src/as26-file.js";
import { createSession } from "../src/review.js";
import { buildWorkbook, type CellValue } from "../src/xlsx.js";
import { buildAs26MapTemplate } from "../src/as26-template.js";
import { EMPTY_OVERRIDES } from "../src/overrides.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import type { DayBookInput } from "../src/tds-daybook.js";

const dirs: string[] = [];
const mapFile = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "as26-review-")); dirs.push(dir);
  const p = join(dir, "as26-map.json"); writeFileSync(p, text, "utf8"); return p;
};
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PSEUDONYM = /^(Debtor|Ledger|Creditor|Doc) \d+$/;

/** Fictional masters/classifier universe: one receiveable plus counterparties. */
const groups = [
  { name: "Current Assets", parent: "" },
  { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Works Contract Service", parent: "Sales Accounts" },
  { name: "Sales Accounts", parent: "" },
];
const masters = [
  { name: "Works Contract Service", parent: "Sales Accounts", gstin: null, state: "", pan: null, isTdsApplicable: false, tdsDeducteeType: "", natureOfPayment: null },
  { name: "TDS Receivable", parent: "Current Assets", gstin: null, state: "", pan: null, isTdsApplicable: false, tdsDeducteeType: "", natureOfPayment: null },
  { name: "Anand Buildmart Pvt Ltd", parent: "Sundry Debtors", gstin: "27AAACA1234F1Z9", state: "MH", pan: "AAACA1234F", isTdsApplicable: true, tdsDeducteeType: "Company", natureOfPayment: null },
  { name: "Kaveri Minerals Trading", parent: "Sundry Debtors", gstin: "29AAACK1234K1Z3", state: "KA", pan: "AAACK1234K", isTdsApplicable: true, tdsDeducteeType: "Firm", natureOfPayment: null },
];
const seed = "Anand Buildmart Pvt Ltd";
const vouchers = [
  {
    date: "20250605", voucherType: "Sales", voucherNumber: "CS/9", partyLedgerName: "Anand Buildmart Pvt Ltd",
    cancelled: false,
    entries: [
      { ledger: "Anand Buildmart Pvt Ltd", amount: 230000 },
      { ledger: "Works Contract Service", amount: -230000 },
    ],
  },
  {
    date: "20250620", voucherType: "Journal", voucherNumber: "JV/3", partyLedgerName: "Kaveri Minerals Trading",
    cancelled: false,
    entries: [
      { ledger: "TDS Receivable", amount: 1100 },
      { ledger: "Kaveri Minerals Trading", amount: -1100 },
    ],
  },
];
/**
 * Ledger-Vouchers rows as seen FROM the receivable ledger: a debit row is a
 * deduction booked (positive=debit); counterparty is the other side — the
 * party. One late-booked row past 20251231 exercises 005 + the 001 note.
 */
const receivableRows = [
  { date: "20250612", voucherType: "Journal", voucherNumber: "JV/1", reference: "", counterparty: "Anand Buildmart Pvt Ltd", amount: 115000, matchStatus: "matched", tax: null },
  { date: "20251018", voucherType: "Journal", voucherNumber: "JV/2", reference: "", counterparty: "Anand Buildmart Pvt Ltd", amount: 115000, matchStatus: "matched", tax: null },
  { date: "20260305", voucherType: "Journal", voucherNumber: "JV/8", reference: "", counterparty: "Anand Buildmart Pvt Ltd", amount: 3000, matchStatus: "unknown", tax: null },
  { date: "20260307", voucherType: "Journal", voucherNumber: "JV/9", reference: "", counterparty: "Kaveri Minerals Trading", amount: -50, matchStatus: "unknown", tax: null },
];

const fake = (ranges: Array<[string, string, string]> = [], mastersThrow = false) => ({
  groups: async () => groups,
  ledgersTax: async () => { if (mastersThrow) throw new Error("tally down"); return masters as never; },
  ledgerVoucherRows: async (_c: unknown, ledger: string, from: string, to: string) => {
    ranges.push([ledger, from, to]);
    return { rows: ledger === "TDS Receivable" ? receivableRows.filter((r) => r.date >= from && r.date <= to) : [], dropped: 0 };
  },
  vouchers: async () => vouchers as never,
  callRaw: async () => { throw new Error("not used"); },
  listCompanies: async () => ["Demo Traders Pvt Ltd"],
  trialBalance: async () => { throw new Error("not used"); },
  ledgers: async () => [] as never,
  ledgerVouchers: async () => [] as never,
  close: async () => {},
} as never);

describe("Session.as26Review", () => {
  const file = parseAs26Export(buildAs26Fixture());

  it("wires books facts through the receivable-ledger path and masks every party", async () => {
    const ranges: Array<[string, string, string]> = [];
    const s = createSession(fake(ranges), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file, mapFile(
      JSON.stringify({ mappings: [{ ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" }] }),
    ));

    expect(res.totals.partiesMatched).toBe(1);
    // month-chunked fetch against the receivable ledger only
    expect(ranges.map((r) => r[0]).every((l) => l === "TDS Receivable")).toBe(true);
    expect(ranges.some((r) => r[1] === "20250401" && r[2] === "20250430")).toBe(true);
    expect(ranges.length).toBeGreaterThan(2);

    // findings exist (books exceed 26AS on this fixture) and all parties pseudonym
    const f001 = res.findings.filter((f) => f.check === "books_tax_not_in_26as");
    expect(f001.length).toBeGreaterThanOrEqual(1);
    for (const f of res.findings) {
      expect(f.party).toMatch(PSEUDONYM);
      expect(f.detail).not.toMatch(seed);
      if (f.schedule) {
        for (const row of f.schedule) expect(row.label).not.toMatch("CS/9");
      }
    }
    const raw = JSON.stringify(res);
    expect(raw).not.toContain("Anand Buildmart");
    expect(raw).not.toContain("Kaveri Minerals");
    expect(raw).not.toContain("Works Contract");
    expect(raw).not.toContain("MUMA01234E");
    expect(res.counts.credits).toBe(1);
    expect(res.counts.receivableLedgers).toHaveLength(1);
    expect(res.counts.receivableLedgers[0]).toMatch(/^[A-Za-z]+ \d+$/);
    expect(res.mastersUnavailable).toBe(false);
  });

  it("groups two ledgers under one deductor and keeps both names masked", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file, mapFile(
      JSON.stringify({ mappings: [
        { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" },
        { ledger: "Kaveri Minerals Trading", as26Name: "Anand Buildmart Pvt Ltd" },
      ]}),
    ));
    expect(res.totals.partiesMatched).toBe(1);
    expect(res.recon[0].match.ledgerKeys).toHaveLength(2);
    for (const n of res.recon[0].match.ledgerNames) expect(n).toMatch(PSEUDONYM);
    // The group label joins each ledger's own stable pseudonym; it must not
    // be masked as one opaque name.
    expect(res.recon[0].match.ledgerName).toBe(res.recon[0].match.ledgerNames.join(" + "));
    expect(res.recon[0].match.ledgerName).toContain(" + ");
    const raw = JSON.stringify(res);
    expect(raw).not.toContain("Anand Buildmart");
    expect(raw).not.toContain("Kaveri Minerals");
  });

  it("degrades on master failure and still reconciles against counterparties", async () => {
    const err = console.error;
    console.error = () => {};
    try {
      const s = createSession(fake([], true), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
      const res = await s.as26Review(undefined, "20250401", "20260331", file, mapFile(
        JSON.stringify({ mappings: [{ ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" }] }),
      ));
      expect(res.mastersUnavailable).toBe(true);
      // the receivable ledger is still found by the name heuristic over the
      // voucher entries, so deductions flow and the operator map joins
      expect(res.counts.receivableLedgers).toHaveLength(1);
      expect(res.totals.partiesMatched).toBe(1);
    } finally {
      console.error = err;
    }
  });

  it("keys day-book rows canonically and keeps GST TDS receivables out of the income-tax set", async () => {
    const dayBook: DayBookInput = {
      shape: "bundle",
      company: "Demo Traders Pvt Ltd",
      groups: [
        { name: "Current Assets", parent: "" },
        { name: "Loans & Advances (Asset)", parent: "Current Assets" },
        { name: "Current Liabilities", parent: "" },
        { name: "Duties & Taxes", parent: "Current Liabilities" },
        { name: "GST", parent: "Duties & Taxes" },
      ],
      ledgers: [
        { name: "TDS Receivable", parent: "Loans & Advances (Asset)" },
        { name: "TDS - CGST Receivable A/c", parent: "GST" },
      ],
      vouchers: [
        {
          date: "20250605", voucherType: "Journal", voucherNumber: "JV/1", partyLedgerName: "Kaveri Minerals Trading",
          cancelled: false,
          entries: [
            { ledger: "TDS Receivable", amount: 5000 },
            { ledger: "Kaveri Minerals Trading", amount: -5000 },
          ],
        },
        {
          date: "20250606", voucherType: "Journal", voucherNumber: "JV/2", partyLedgerName: "Kaveri Minerals Trading",
          cancelled: false,
          entries: [
            { ledger: "TDS Receivable", amount: -50 },
            { ledger: "Kaveri Minerals Trading", amount: 50 },
          ],
        },
        {
          date: "20250607", voucherType: "Journal", voucherNumber: "JV/3", partyLedgerName: "Kaveri Minerals Trading",
          cancelled: false,
          entries: [
            { ledger: "TDS - CGST Receivable A/c", amount: 900 },
            { ledger: "Kaveri Minerals Trading", amount: -900 },
          ],
        },
      ],
      observedFrom: "20250605",
      observedTo: "20250607",
      rejected: 0,
      emptyMonths: [],
    };
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review(
      "Demo Traders Pvt Ltd", "20250401", "20260331", file, mapFile('{"mappings":[]}'), dayBook,
    );

    // The asset root is reached through the group tree (ledger -> group ->
    // root), so only the income-tax receivable is selected; the GST-TDS
    // receivable sits under Duties & Taxes and is not income-tax TDS.
    expect(res.counts.receivableLedgers).toHaveLength(1);
    expect(res.counts.receivableLedgers[0]).toMatch(PSEUDONYM);
    // Day-book rows are keyed canonically, so the mixed-case ledger's debit
    // becomes a deduction event and its credit is counted, not silently lost.
    expect(res.bookEvents.filter((e) => e.source === "deduction")).toHaveLength(1);
    expect(res.counts.credits).toBe(1);
    const raw = JSON.stringify(res);
    expect(raw).not.toContain("TDS Receivable");
    expect(raw).not.toContain("CGST");
  });

  it("accepts a filled .xlsx mapping template at as26MapPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as26-review-"));
    dirs.push(dir);
    const p = join(dir, "as26-map.xlsx");
    writeFileSync(
      p,
      buildAs26MapTemplate({
        deductors: [{ name: "Anand Buildmart Pvt Ltd", kind: "tds", tax: 4600.15 }],
        map: { mappings: [{ ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" }] },
        ledgers: ["Anand Buildmart Pvt Ltd"],
      }),
    );
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file, p);
    expect(res.totals.partiesMatched).toBe(1);
  });

  it("rejects a bad period before touching downstream", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    await expect(s.as26Review(undefined, "2026-04-01", "20260331", file, "/x")).rejects.toThrow(/YYYYMMDD/);
    await expect(s.as26Review(undefined, "20260401", "20250331", file, "/x")).rejects.toThrow(/YYYYMMDD/);
  });

  it("counts a bank's receivable credits whose counterparty is the mapped interest/FD ledger (inbox 010)", async () => {
    const BANK = "Union Bank Of India Ro Chennai";
    const INTEREST = "Interest Recd on Fd A/c";
    const FD = "FD - 3412 - Sample";
    const def = defaultAs26Fixture();
    const file = parseAs26Export(buildAs26Fixture({
      ...def,
      tdsSummary: [
        ...def.tdsSummary,
        [BANK, "XYZA01111B", 96226, 96226, 0, 962258, "", 962258, "194A"],
      ],
      tdsDetail: [
        ...def.tdsDetail,
        [BANK.toUpperCase(), "05-Jan-2026", 962258, null, 96226, 96226, "XYZA01111B", null, "F", "09-Feb-2026", "194A"],
      ],
    }));
    const dir = mkdtempSync(join(tmpdir(), "as26-bank-"));
    dirs.push(dir);
    const p = join(dir, "as26-map.xlsx");
    writeFileSync(p, buildWorkbook([
      {
        name: "Mapping", state: "visible",
        columns: [
          { header: "26AS name", width: 20, format: "text" },
          { header: "kind", width: 6, format: "text" },
          { header: "26AS tax", width: 10, format: "money" },
          { header: "Tally ledger", width: 20, format: "text" },
        ],
        rows: [[INTEREST, "tds", 96226, INTEREST]],
      },
      {
        name: "Bank Interest", state: "visible",
        columns: [
          { header: "26AS name (bank)", width: 20, format: "text" },
          { header: "Interest income ledger", width: 20, format: "text" },
          { header: "FD ledger", width: 20, format: "text" },
        ],
        rows: [[BANK, INTEREST, FD]],
      },
    ]));
    const dayBook: DayBookInput = {
      shape: "bundle", company: "Demo Traders Pvt Ltd", groups: null, ledgers: null,
      vouchers: [
        // same-voucher shape: mapped interest credit AND receivable debit together
        {
          date: "20250701", voucherType: "Journal", voucherNumber: "JV/B1", partyLedgerName: INTEREST,
          cancelled: false,
          entries: [
            { ledger: "TDS Receivable", amount: 4600 },
            { ledger: INTEREST, amount: -4600 },
          ],
        },
        // counterparty shape: the receivable debit row's counterparty IS the FD ledger
        {
          date: "20250801", voucherType: "Journal", voucherNumber: "JV/B2", partyLedgerName: "TDS Receivable",
          cancelled: false,
          entries: [
            { ledger: "TDS Receivable", amount: 300 },
            { ledger: FD, amount: -300 },
          ],
        },
        // negative control: receivable credit with an unrelated counterparty
        {
          date: "20250901", voucherType: "Journal", voucherNumber: "JV/B3", partyLedgerName: "TDS Receivable",
          cancelled: false,
          entries: [
            { ledger: "TDS Receivable", amount: 700 },
            { ledger: "Kaveri Minerals Trading", amount: -700 },
          ],
        },
      ],
      observedFrom: "20250701",
      observedTo: "20250901",
      rejected: 0,
      emptyMonths: [],
    };
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file, p, dayBook);
    const r = res.recon.find((x) => x.totalsOnly)!;
    expect(r.booksTax).toBe(4900);
    expect(r.booksInterestValue).toBe(4600);
    expect(res.findings.some((f) => f.check === "as26_totals_mismatch")).toBe(true);
  });

  const anandMap = (): string => mapFile(
    JSON.stringify({ mappings: [{ ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" }] }),
  );

  it("billRows reach the tool result masked, with row pointers on findings", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file, anandMap());

    // every party label is a pseudonym, never a name
    expect(res.billRows.length).toBeGreaterThan(0);
    for (const r of res.billRows) expect(r.party).not.toMatch(/[A-Za-z]+ Traders/);
    const b = res.billRows.find((r) => r.sheetId === "booksded");
    expect(b).toBeDefined();
    expect(b && /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(b.date)).toBe(true); // displayDate form
    const f = res.findings.find((x) => x.check === "books_tax_not_in_26as");
    expect(f).toBeDefined();
    expect(f!.detail).toMatch(/see Books not in 26AS rows B\d/);
    // a booksded row's party equals the masked label of the matching finding's party
    expect(res.billRows.some((r) => r.sheetId === "booksded" && r.party === f!.party)).toBe(true);
    // every row id inside a pointer is a B/D/V ordinal
    for (const g of res.findings) {
      for (const m of g.detail.matchAll(/see ([A-Za-z0-9 ]+?) rows ((?:[BDV]\d+(?:, )?)+)\./g)) {
        for (const id of m[2].split(", ")) expect(id).toMatch(/^[BDV]\d+$/);
      }
    }
    // nothing raw leaves the session
    const raw = JSON.stringify(res.billRows);
    expect(raw).not.toContain("JV/1");
    expect(raw).not.toContain("20250612");
    expect(raw).not.toContain("Anand Buildmart");
  });

  it("orders a party's rows booksded, as26, value and points 003 at value rows", async () => {
    const base = defaultAs26Fixture();
    const swap = (rows: CellValue[][], first: string, next: CellValue[]): CellValue[][] =>
      rows.map((r) => (String(r[0]) === first ? next : r));
    const fileV = parseAs26Export(buildAs26Fixture({
      ...base,
      // Anand's 26AS gross grows past the value tolerance against the books sale
      tdsSummary: swap(base.tdsSummary, "Anand Buildmart Pvt Ltd",
        ["Anand Buildmart Pvt Ltd", "PUNB05678F", 4600.15, 4600.15, 0, 240000, "", 240000, "194C"]),
      tdsDetail: swap(base.tdsDetail, "ANAND BUILDMART PVT LTD",
        ["ANAND BUILDMART PVT LTD", "09-Sep-2025", 240000.89, null, 4600.15, 4600.15, "PUNB05678F", null, "F", "15-Oct-2025", "194C"]),
    }));
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", fileV, anandMap());
    const label = res.recon[0].match.ledgerName;
    const order = res.billRows.filter((r) => r.party === label).map((r) => r.sheetId);
    expect(order).toEqual(["booksded", "booksded", "booksded", "as26", "value"]);
    const f003 = res.findings.find((x) => x.check === "assessable_value_mismatch");
    expect(f003).toBeDefined();
    expect(f003!.detail).toMatch(/see Bill value mismatch rows V1\./);
  });

  it("late_booking pointers name only the out-of-window as26 rows", async () => {
    const base = defaultAs26Fixture();
    const fileL = parseAs26Export(buildAs26Fixture({
      ...base,
      // a second Anand transaction booked after the (shortened) window
      tdsDetail: [...base.tdsDetail,
        ["", "20-Nov-2025", 100000, null, 2000, null, "PUNB05678F", null, "F", "05-Jan-2026", "194C"]],
    }));
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20251231", fileL, anandMap());
    const late = res.findings.find((x) => x.check === "late_booking");
    expect(late).toBeDefined();
    // D2 is the 05-Jan-2026 booking (outside the window); D1 (15-Oct-2025) is in-window
    expect(late!.detail).toMatch(/see 26AS unmatched rows D2\./);
    expect(late!.detail).not.toMatch(/D1\b/);
    const f001 = res.findings.find((x) => x.check === "books_tax_not_in_26as");
    expect(f001!.detail).toMatch(/see Books not in 26AS rows B1, B2\./);
    expect(f001!.detail).not.toMatch(/26AS unmatched/);
  });

  it("masked bill rows carry windowState: pre, post and in", async () => {
    const base = defaultAs26Fixture();
    // Insert after the Anand detail row (indices 3-5) so both blank-named rows
    // band under the Anand name: one transaction dated before the reviewed
    // window opens, one booking after the window closes (05-Jan-2026 booking)
    const preRow = ["", "10-Feb-2025", 80000, null, 1600, null, "PUNB05678F", null, "F", "20-Mar-2025", "194C"];
    const postRow = ["", "20-Nov-2025", 100000, null, 2000, null, "PUNB05678F", null, "F", "05-Jan-2026", "194C"];
    const fileW = parseAs26Export(buildAs26Fixture({
      ...base,
      tdsDetail: [...base.tdsDetail.slice(0, 6), preRow, postRow],
    }));
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20251231", fileW, anandMap());
    const as26rows = res.billRows.filter((r) => r.sheetId === "as26");
    // Pin the DIRECTION per named row: a pre↔post inversion would still leave
    // all three states present, so membership alone cannot catch it. An as26
    // bill row's `date` is the transaction's booking date.
    // pre: transaction 10-Feb-2025, booked 20-Mar-2025 — before the window opens
    const pre = as26rows.find((r) => r.date === "20-Mar-2025");
    expect(pre).toBeDefined();
    expect(pre!.windowState).toBe("pre");
    // post: transaction 20-Nov-2025, booked 05-Jan-2026 — after the window closes
    const post = as26rows.find((r) => r.date === "05-Jan-2026");
    expect(post).toBeDefined();
    expect(post!.windowState).toBe("post");
    // in: Anand's 15-Oct-2025 booking sits inside the reviewed window
    const within = as26rows.find((r) => r.date === "15-Oct-2025");
    expect(within).toBeDefined();
    expect(within!.windowState).toBe("in");
    // every row carries a legal windowState
    for (const r of res.billRows) expect(["pre", "post", "in"]).toContain(r.windowState);
  });

  it("surfaces a books-target aggregate with reserved row ids and skips consumed rows in pointers", async () => {
    const def = defaultAs26Fixture();
    const fileAgg = parseAs26Export(buildAs26Fixture({
      ...def,
      tdsSummary: [...def.tdsSummary.slice(0, 7),
        ["Aggregate Co", "ABCD12345E", 12000, 12000, 0, 600000, "", 600000, "194C"]],
      tdsDetail: [...def.tdsDetail.slice(0, 3),
        ["AGGREGATE CO", "10-Apr-2025", 200000, null, 4000, null, "ABCD12345E", null, "F", "15-Apr-2025", "194C"],
        ["", "10-May-2025", 200000, null, 4000, null, null, null, "F", "15-May-2025", "194C"],
        ["", "10-Jun-2025", 200000, null, 4000, null, null, null, "F", "15-Jun-2025", "194C"],
      ],
    }));
    const dayBook: DayBookInput = {
      shape: "bundle", company: "Demo Traders Pvt Ltd",
      groups: [
        { name: "Current Assets", parent: "" },
        { name: "Loans & Advances (Asset)", parent: "Current Assets" },
        { name: "Sundry Debtors", parent: "Current Assets" },
      ],
      ledgers: [
        { name: "TDS Receivable", parent: "Loans & Advances (Asset)" },
        { name: "Aggregate Co", parent: "Sundry Debtors" },
      ],
      vouchers: [
        {
          date: "20250612", voucherType: "Journal", voucherNumber: "JV/1", partyLedgerName: "Aggregate Co",
          cancelled: false,
          entries: [
            { ledger: "TDS Receivable", amount: 12000 },
            { ledger: "Aggregate Co", amount: -12000 },
          ],
        },
        {
          date: "20250620", voucherType: "Journal", voucherNumber: "JV/2", partyLedgerName: "Aggregate Co",
          cancelled: false,
          entries: [
            { ledger: "TDS Receivable", amount: 500 },
            { ledger: "Aggregate Co", amount: -500 },
          ],
        },
      ],
      observedFrom: "20250612",
      observedTo: "20250620",
      rejected: 0,
      emptyMonths: [],
    };
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", fileAgg, mapFile(
      JSON.stringify({ mappings: [{ ledger: "Aggregate Co", as26Name: "Aggregate Co" }] }),
    ), dayBook);

    const combo = res.recon[0].combinations.find((c) => c.side === "books");
    expect(combo).toBeDefined();
    // the single 12000 books entry matches the whole 26AS tail it aggregates
    expect(combo!.targetId).toBe("B1");
    expect(combo!.partIds).toEqual(["D1", "D2", "D3"]);

    // the consumed books row reserves B1 but is hidden from the sheets and
    // from finding pointers; only the survivor (the 500 row) is named.
    const booksded = res.billRows.filter((r) => r.sheetId === "booksded");
    expect(booksded.some((r) => r.explained)).toBe(true);
    const f001 = res.findings.find((x) => x.check === "books_tax_not_in_26as");
    expect(f001).toBeDefined();
    expect(f001!.detail).toMatch(/see Books not in 26AS rows B2\./);
    expect(f001!.detail).not.toMatch(/B1\b/);
  });

  it("includes same-voucher other income in the party gross basis (addendum 10)", async () => {
    const def = defaultAs26Fixture();
    const fileBonus = parseAs26Export(buildAs26Fixture({
      ...def,
      tdsSummary: [...def.tdsSummary.slice(0, 7),
        ["Bonus Co", "ABCD12345E", 300, 300, 0, 52600, "", 52600, "194C"]],
      tdsDetail: [...def.tdsDetail.slice(0, 3),
        ["BONUS CO", "15-Apr-2025", 15000, null, 300, null, "ABCD12345E", null, "F", "15-Apr-2025", "194C"]],
    }));
    const dayBook: DayBookInput = {
      shape: "bundle", company: "Demo Traders Pvt Ltd",
      groups: [
        { name: "Current Assets", parent: "" },
        { name: "Loans & Advances (Asset)", parent: "Current Assets" },
        { name: "Sundry Debtors", parent: "Current Assets" },
        { name: "Sales Accounts", parent: "" },
        { name: "Works Contract Service", parent: "Sales Accounts" },
        { name: "Indirect Incomes", parent: "" },
      ],
      ledgers: [
        { name: "TDS Receivable", parent: "Loans & Advances (Asset)" },
        { name: "Bonus Co", parent: "Sundry Debtors" },
        { name: "Contract Income", parent: "Works Contract Service" },
        { name: "Bonus Income", parent: "Indirect Incomes" },
      ],
      vouchers: [
        { date: "20250605", voucherType: "Sales", voucherNumber: "CS/1", partyLedgerName: "Bonus Co", cancelled: false,
          entries: [{ ledger: "Bonus Co", amount: 50000 }, { ledger: "Contract Income", amount: -50000 }] },
        { date: "20250620", voucherType: "Journal", voucherNumber: "JV/2", partyLedgerName: "Bonus Co", cancelled: false,
          entries: [{ ledger: "TDS Receivable", amount: 300 }, { ledger: "Bonus Co", amount: 2300 }, { ledger: "Bonus Income", amount: -2600 }] },
      ],
      observedFrom: "20250605", observedTo: "20250620", rejected: 0, emptyMonths: [],
    };
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", fileBonus, mapFile(
      JSON.stringify({ mappings: [{ ledger: "Bonus Co", as26Name: "Bonus Co" }] }),
    ), dayBook);

    // taxable basis = Sales-Accounts credits (50000) + same-voucher bonus (2600)
    expect(res.recon[0].booksTaxableValue).toBe(52600);
    expect(res.findings.some((x) => x.check === "assessable_value_mismatch")).toBe(false);

    const extra = res.bookEvents.find((e) => e.source === "other income");
    expect(extra).toBeDefined();
    expect(extra!.tax).toBe(2600);
    expect(extra!.ledger).toBeDefined();
  });
});

// --- the operator's explicit Credit Ledgers list (captain's fix: a books-side
// credit ledger under Loans & Advances with no "receivable" in its name) ---

/** A company whose credit ledger carries no "receivable" word: the name
 *  heuristic cannot see it, so only an explicit list can drive the review. */
const CREDIT_LEDGER = "TDS (FY:25-26) A/c";
/** Anand Buildmart appears in 26AS under TDS 194C only, so the declared kind
 *  alone decides whether its books deduction reconciles at all. */
const CREDIT_PARTY = "Anand Buildmart Pvt Ltd";
const creditDayBook = (
  credit: Array<{ ledger: string; amount: number }> = [{ ledger: CREDIT_LEDGER, amount: 1100 }],
): DayBookInput => ({
  shape: "bundle", company: "Demo Traders Pvt Ltd",
  groups: [
    { name: "Current Assets", parent: "" },
    { name: "Loans & Advances (Asset)", parent: "Current Assets" },
    { name: "Sundry Debtors", parent: "Current Assets" },
    { name: CREDIT_PARTY, parent: "Sundry Debtors" },
  ],
  ledgers: [
    ...credit.map((c) => ({ name: c.ledger, parent: "Loans & Advances (Asset)" })),
    { name: CREDIT_PARTY, parent: "Sundry Debtors" },
  ],
  vouchers: credit.map((c, i) => ({
    date: "20250620", voucherType: "Journal", voucherNumber: `JV/${i + 2}`,
    partyLedgerName: CREDIT_PARTY, cancelled: false,
    entries: [{ ledger: c.ledger, amount: c.amount }, { ledger: CREDIT_PARTY, amount: -c.amount }],
  })),
  observedFrom: "20250620", observedTo: "20250620", rejected: 0, emptyMonths: [],
});

const creditMapPath = (ledgers: Array<{ ledger: string; kind: "tds" | "tcs" }>): string => {
  const dir = mkdtempSync(join(tmpdir(), "as26-review-")); dirs.push(dir);
  const p = join(dir, "as26-map.xlsx");
  writeFileSync(p, buildAs26MapTemplate({
    deductors: [{ name: CREDIT_PARTY, kind: "tds", tax: 1100 }],
    map: { mappings: [{ ledger: CREDIT_PARTY, as26Name: CREDIT_PARTY }], creditLedgers: ledgers },
    ledgers: [CREDIT_LEDGER, CREDIT_PARTY],
  }));
  return p;
};

describe("Session.as26Review > operator-declared credit ledgers", () => {
  const file = parseAs26Export(buildAs26Fixture());

  it("uses exactly the listed ledger, with its declared kind, and skips the name heuristic", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file,
      creditMapPath([{ ledger: CREDIT_LEDGER, kind: "tds" }]), creditDayBook());

    expect(res.counts.creditLedgerSource).toEqual({ tds: "map", tcs: "heuristic" });
    expect(res.counts.receivableLedgers).toHaveLength(1);
    // the declared kind rides the books side: the debit answers the party's
    // 194C TDS summary (1100 of books tax against it)
    expect(res.recon.find((r) => r.match.kind === "tds")?.booksTax).toBe(1100);
    expect(res.counts.receivableLedgers[0]).toMatch(PSEUDONYM);
    // the declared ledger's debit became a books deduction
    expect(res.bookEvents.filter((e) => e.source === "deduction")).toHaveLength(1);
    const raw = JSON.stringify(res);
    expect(raw).not.toContain("FY:25-26");
    expect(raw).not.toContain("Kaveri Minerals");
  });

  it("keeps a declared TCS ledger on the tcs side of the books", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file,
      creditMapPath([{ ledger: CREDIT_LEDGER, kind: "tcs" }]), creditDayBook());
    expect(res.bookEvents.filter((e) => e.source === "deduction")).toHaveLength(1);
    // a tcs books deduction never answers a tds summary: the 194C recon reads
    // zero books tax and the deduction is reported as a mapping gap instead
    expect(res.recon.find((r) => r.match.kind === "tds")?.booksTax).toBe(0);
    expect(res.gaps.some((g) => g.kind === "tcs" && g.reason === "unmapped")).toBe(true);
  });

  it("refuses a listed ledger that is not in the books, naming no ledger", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    let msg = "";
    try {
      await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file,
        creditMapPath([{ ledger: "TDS Receivable A/c", kind: "tds" }]), creditDayBook());
    } catch (e) { msg = String((e as Error).message); }
    expect(msg).toMatch(/Credit Ledgers sheet names 1 ledger/);
    expect(msg).not.toMatch(/TDS Receivable A\/c/);
  });

  it("throws the setup error when the list is empty and the heuristic cannot see the ledger", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    await expect(s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file,
      creditMapPath([]), creditDayBook())).rejects.toThrow(/no TDS\/TCS receivable ledger found/);
  });

  it("a declared TDS ledger does not switch the rule off for TCS: TCS A/c is still found by name", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file,
      creditMapPath([{ ledger: CREDIT_LEDGER, kind: "tds" }]),
      creditDayBook([
        { ledger: CREDIT_LEDGER, amount: 1100 },
        { ledger: "TCS A/c", amount: 38350 },
      ]));
    expect(res.counts.creditLedgerSource).toEqual({ tds: "map", tcs: "heuristic" });
    // the rule-blind declared ledger AND the rule-findable TCS one, both live
    expect(res.counts.receivableLedgers).toHaveLength(2);
    expect(res.bookEvents.filter((e) => e.source === "deduction")).toHaveLength(2);
    expect(res.recon.find((r) => r.match.kind === "tds")?.booksTax).toBe(1100);
  });

  it("a declared TCS ledger replaces the TCS rule, not the TDS one", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file,
      creditMapPath([
        { ledger: CREDIT_LEDGER, kind: "tds" },
        { ledger: "TCS A/c", kind: "tcs" },
      ]),
      creditDayBook([
        { ledger: CREDIT_LEDGER, amount: 1100 },
        { ledger: "TCS A/c", amount: 38350 },
        { ledger: "TCS Receivable A/c", amount: 500 },
      ]));
    expect(res.counts.creditLedgerSource).toEqual({ tds: "map", tcs: "map" });
    // the rule-findable TCS Receivable is not consulted once tcs is declared
    expect(res.counts.receivableLedgers).toHaveLength(2);
    expect(res.bookEvents.filter((e) => e.source === "deduction")).toHaveLength(2);
  });

  it("falls back to the heuristic untouched when the list is absent", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file,
      mapFile('{"mappings":[]}'), creditDayBook([{ ledger: "TDS Receivable A/c", amount: 1100 }]));
    expect(res.counts.creditLedgerSource).toEqual({ tds: "heuristic", tcs: "heuristic" });
    expect(res.counts.receivableLedgers).toHaveLength(1);
    expect(res.bookEvents.filter((e) => e.source === "deduction")).toHaveLength(1);
  });
});
