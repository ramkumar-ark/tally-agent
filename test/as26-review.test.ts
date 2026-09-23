import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { buildAs26Fixture } from "./as26-fixture.js";
import { parseAs26Export } from "../src/as26-file.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/overrides.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";

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

  it("rejects a bad period before touching downstream", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    await expect(s.as26Review(undefined, "2026-04-01", "20260331", file, "/x")).rejects.toThrow(/YYYYMMDD/);
    await expect(s.as26Review(undefined, "20260401", "20250331", file, "/x")).rejects.toThrow(/YYYYMMDD/);
  });
});
