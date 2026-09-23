import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { EMPTY_AS26_MAP, loadAs26Map, matchParties, type BooksFacts } from "../src/as26.js";
import { parseAs26Export } from "../src/as26-file.js";
import { buildAs26Fixture } from "./as26-fixture.js";
import { canonicalKey } from "../src/key.js";

const dirs: string[] = [];
const mapFile = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "as26-")); dirs.push(dir);
  const p = join(dir, "as26-map.json"); writeFileSync(p, text, "utf8"); return p;
};
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("loadAs26Map", () => {
  it("missing file degrades to empty with a warning", () => {
    const warns: string[] = [];
    expect(loadAs26Map("/nonexistent/as26-map.json", (w) => warns.push(w))).toEqual(EMPTY_AS26_MAP);
    expect(warns).toHaveLength(1);
  });
  it("malformed JSON throws", () => {
    expect(() => loadAs26Map(mapFile("{"))).toThrow(/as26-map/);
  });
  it("duplicate ledger or as26Name keys throw citing the entry index, never a value", () => {
    const dup = JSON.stringify({ mappings: [
      { ledger: "Alpha Traders", as26Name: "Alpha Traders" },
      { ledger: "Alpha Traders", as26Name: "Beta Traders" },
    ]});
    expect(() => loadAs26Map(mapFile(dup))).toThrow(/as26-map entry 2/);
  });
  it("blank fields throw citing the entry index", () => {
    const blank = JSON.stringify({ mappings: [{ ledger: "  ", as26Name: "X" }] });
    expect(() => loadAs26Map(mapFile(blank))).toThrow(/as26-map entry 1/);
  });
});

const ledgers = ["Nagar Palika Nagar Bhavan", "Anand Buildmart Pvt Ltd", "Kaveri Minerals Trading", "Orphan Debtors"];
const facts = (keys: string[]): BooksFacts => ({
  deductions: keys.map((k) => ({ ledgerKey: canonicalKey(k), kind: "tds" as const, date: "20250612", tax: 5000, voucherType: "Journal" })),
  sales: [],
});

describe("matchParties — mapping-only", () => {
  const file = parseAs26Export(buildAs26Fixture());
  it("operator map joins exactly; everything else surfaces as gaps", () => {
    const map = { mappings: [{ ledger: "Nagar Palika Nagar Bhavan", as26Name: "Nagar Palika Nagar Bhavan" }] };
    const { matches, gaps } = matchParties(file, facts(ledgers), map, ledgers);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ ledgerName: "Nagar Palika Nagar Bhavan", source: "operator", kind: "tds" });
    // unmapped deductors + unmapped ledgers with deductions
    const reasons = gaps.map((g) => g.reason);
    expect(reasons.filter((r) => r === "unmapped").length).toBeGreaterThanOrEqual(4);
  });
  it("stale/absent mappings become gaps, never throws", () => {
    const map = { mappings: [
      { ledger: "No Such Ledger", as26Name: "Nagar Palika Nagar Bhavan" },
      { ledger: "Orphan Debtors", as26Name: "No Such Deductor" },
    ]};
    const { matches, gaps } = matchParties(file, facts(ledgers), map, ledgers);
    expect(matches).toHaveLength(0);
    expect(gaps.map((g) => g.reason).sort()).toEqual(
      ["ledger-absent", "name-absent",
       "unmapped", "unmapped", "unmapped", // 3 unmapped deductors
       "unmapped", "unmapped", "unmapped", "unmapped"].sort()); // 4 ledgers with deductions, none matched
  });
  it("an unmapped deductor gap carries the 26AS tax at stake", () => {
    const { gaps } = matchParties(file, facts([]), { mappings: [] }, ledgers);
    const g = gaps.find((x) => x.name === "Nagar Palika Nagar Bhavan")!;
    expect(g.reason).toBe("unmapped");
    expect(g.tax).toBe(18000);
  });
});

// --- Task 6: books facts helpers ---

import type { LedgerVoucherRow, VoucherRow } from "../src/downstream.js";
import { deductionEvents, booksSales, receivableLedgers } from "../src/as26.js";
import type { GstCtx } from "../src/gst.js";

const lvRow = (date: string, counterparty: string, amount: number, voucherType = "Journal"): LedgerVoucherRow => ({
  date, voucherType, voucherNumber: `V/${date}`, reference: "", counterparty,
  amount, matchStatus: "unknown", tax: null,
});

const as26Ctx: GstCtx = {
  groupOf: (l) =>
    l === "Nagar Palika Nagar Bhavan" || l === "Anand Buildmart Pvt Ltd"
      ? "Sundry Debtors"
      : l === "Works Contract Service" ? "Sales Accounts"
      : l === "Building Materials" ? "Purchase Accounts"
      : l.includes("CGST") || l.includes("IGST") ? "Duties & Taxes"
      : "Unclassified",
  rootOf: (g) => (g === "Sales Accounts" ? "Sales Accounts" : g === "Purchase Accounts" ? "Purchase Accounts" : null),
  roleOf: (g) => (g === "Sundry Debtors" ? "debtor" : "other"),
  inDutiesAndTaxes: (g) => g.includes("Duties"),
  gstinOf: () => null,
};

/** Normal outward Tally layout (positive=debit): party debit, sales-accounts credit, GST heads credit. */
const sale = (): VoucherRow => ({
  date: "20250612", voucherType: "Contract Sales", voucherNumber: "CS/9", reference: "",
  partyLedgerName: "Nagar Palika Nagar Bhavan", cancelled: false,
  entries: [
    { ledger: "Nagar Palika Nagar Bhavan", amount: 47200 },
    { ledger: "Works Contract Service", amount: -40000 },
    { ledger: "Output CGST", amount: -3600 },
    { ledger: "Output IGST", amount: -3600 },
  ],
});

describe("deductionEvents", () => {
  it("debits become events, credits are counted not netted", () => {
    const ledger = "TDS Receivable";
    const rows = [
      lvRow("20250612", "Nagar Palika Nagar Bhavan", 9000.5, "Journal"),
      lvRow("20250712", "Anand Buildmart Pvt Ltd", 2000.25, "Journal"),
      lvRow("20250812", "Nagar Palika Nagar Bhavan", -500, "D/Note"),
    ];
    const { events, credits } = deductionEvents(rows, "tds");
    expect(credits).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      ledgerKey: "nagar palika nagar bhavan", kind: "tds",
      date: "20250612", tax: 9000.5, voucherType: "Journal",
    });
    expect(events[1].tax).toBe(2000.25);
    void ledger;
  });
  it("only debits — a zero row is ignored", () => {
    const { events, credits } = deductionEvents([lvRow("20250612", "X", 0)], "tds");
    expect(events).toHaveLength(0);
    expect(credits).toBe(0);
  });
});

describe("booksSales", () => {
  it("per-invoice sale rows with taxable, GST-inclusive gross and ref", () => {
    const cancelled: VoucherRow = { ...sale(), cancelled: true, voucherNumber: "CS/X" };
    const otherSide: VoucherRow = {
      ...sale(), partyLedgerName: "Anand Buildmart Pvt Ltd",
      entries: [
        { ledger: "Anand Buildmart Pvt Ltd", amount: -47200 },
        { ledger: "Building Materials", amount: 40000 },
      ],
    };
    const sales = booksSales([sale(), cancelled, otherSide], as26Ctx);
    expect(sales).toHaveLength(1); // cancelled skipped; inward voucher not a sale
    expect(sales[0]).toMatchObject({
      ledgerKey: "nagar palika nagar bhavan", date: "20250612",
      taxable: 40000, gross: 47200, ref: "CS/9",
    });
  });
});

describe("receivableLedgers", () => {
  const isAssetRoot = (g: string) => g.includes("Current Assets");
  it("identifies TDS/TCS receivable ledgers under an asset root, kind by name", () => {
    const led = receivableLedgers([
      { name: "TDS Receivable", parent: "Current Assets" },
      { name: "TCS Receivable", parent: "Current Assets" },
      { name: "TDS Yellow Led", parent: "Sundry Debtors" },
      { name: "Sunil Sharma", parent: "Sundry Debtors" },
      { name: "Sunil Sharma", parent: "Sundry Debtors" },
      { name: "Current Assets", parent: "" },
    ], isAssetRoot);
    expect(led).toEqual([
      { name: "TDS Receivable", kind: "tds" },
      { name: "TCS Receivable", kind: "tcs" },
    ]);
  });
  it("none found ⇒ empty array", () => {
    expect(receivableLedgers([{ name: "Cash", parent: "Current Assets" }], isAssetRoot)).toEqual([]);
  });
});
