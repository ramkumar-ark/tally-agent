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
  it("a ledger mapped twice throws citing the entry index, never a value", () => {
    const dup = JSON.stringify({ mappings: [
      { ledger: "Alpha Traders", as26Name: "Alpha Traders" },
      { ledger: "Alpha Traders", as26Name: "Beta Traders" },
    ]});
    expect(() => loadAs26Map(mapFile(dup))).toThrow(/as26-map entry 2/);
  });
  it("repeated 26AS names with different ledgers are allowed", () => {
    const split = JSON.stringify({ mappings: [
      { ledger: "Alpha Site Ledger", as26Name: "Alpha Builders" },
      { ledger: "Alpha Head Office", as26Name: "Alpha Builders" },
    ]});
    expect(loadAs26Map(mapFile(split)).mappings).toEqual([
      { ledger: "Alpha Site Ledger", as26Name: "Alpha Builders" },
      { ledger: "Alpha Head Office", as26Name: "Alpha Builders" },
    ]);
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
  it("groups several ledgers under one 26AS name into a single party", () => {
    const map = { mappings: [
      { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Nagar Palika Nagar Bhavan" },
      { ledger: "Kaveri Minerals Trading", as26Name: "Nagar Palika Nagar Bhavan" },
    ]};
    const { matches, gaps } = matchParties(file, facts(ledgers), map, ledgers);
    expect(matches).toHaveLength(1);
    expect(matches[0].ledgerKeys).toEqual([
      canonicalKey("Anand Buildmart Pvt Ltd"), canonicalKey("Kaveri Minerals Trading"),
    ]);
    expect(matches[0].ledgerName).toBe("Anand Buildmart Pvt Ltd + Kaveri Minerals Trading");
    // every grouped ledger counts as matched — none resurfaces as an unmapped gap
    const unmappedLedgers = gaps.filter((g) => g.reason === "unmapped" && g.ledger).map((g) => g.ledger);
    expect(unmappedLedgers).not.toContain("Anand Buildmart Pvt Ltd");
    expect(unmappedLedgers).not.toContain("Kaveri Minerals Trading");
  });
  it("reports an absent grouped ledger as a gap while reconciling the rest", () => {
    const map = { mappings: [
      { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Nagar Palika Nagar Bhavan" },
      { ledger: "No Such Ledger", as26Name: "Nagar Palika Nagar Bhavan" },
    ]};
    const { matches, gaps } = matchParties(file, facts(ledgers), map, ledgers);
    expect(matches).toHaveLength(1);
    expect(matches[0].ledgerKeys).toEqual([canonicalKey("Anand Buildmart Pvt Ltd")]);
    const absent = gaps.find((g) => g.reason === "ledger-absent")!;
    expect(absent.ledger).toBe("No Such Ledger");
    // the deductor formed a group, so it is not also reported unmapped
    expect(gaps.some((g) => g.reason === "unmapped" && g.nameKey === "nagarpalikanagarbhavan")).toBe(false);
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

// --- Task 7: stage-2 reconciliation core ---

import { reconcileParty } from "../src/as26.js";
import type { As26File, As26SummaryRow, As26Transaction } from "../src/as26-file.js";

const NK = "nagar palika nagar bhavan";
const nameOf = "Nagar Palika Nagar Bhavan";

const sum = (taxTotal: number): As26SummaryRow => ({
  kind: "tds", name: nameOf, nameKey: NK, section: "194C",
  taxTotal, taxClaimed: 0, balanceCf: 0, gross: 0,
});
const txn = (tax: number, bookingDate: string | null = null, date = "20250612"): As26Transaction => ({
  kind: "tds", nameKey: NK, date, amount: tax, tax, status: bookingDate ? "O" : "F", bookingDate, section: "194C",
});
const txFile = (tx: As26Transaction[], total: number): As26File => ({
  summaries: [sum(total)], transactions: tx,
  skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
});
const bookFacts = (ded: Array<[string, number]>): BooksFacts => ({
  deductions: ded.map(([date, tax]) => ({
    ledgerKey: NK, kind: "tds" as const, date, tax, voucherType: "Journal",
  })),
  sales: [],
});
const mapper = { mappings: [{ ledger: nameOf, as26Name: nameOf }] };
const matchOf = (file: As26File, facts: BooksFacts) =>
  matchParties(file, facts, mapper, ledgers).matches[0];

describe("reconcileParty", () => {
  it("bulk: three books deductions explained by one 26AS line", () => {
    const facts = bookFacts([["20250610", 6000], ["20250611", 8000], ["20250612", 10000]]);
    const file = txFile([txn(24000)], 24000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20251231");
    expect(r.booksTax).toBe(24000);
    expect(r.as26Tax).toBe(24000);
    expect(r.paired).toHaveLength(0);
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].parts).toHaveLength(3);
    expect(r.combinations[0].side).toBe("as26");
    expect(r.unmatchedBooks).toHaveLength(0);
    expect(r.unmatchedAs26).toHaveLength(0);
  });
  it("split: one books deduction explained by two 26AS lines", () => {
    const facts = bookFacts([["20250612", 10000]]);
    const file = txFile([txn(6000), txn(4000, null, "20250620")], 10000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20251231");
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].side).toBe("books");
    expect(r.combinations[0].parts).toHaveLength(2);
    expect(r.unmatchedBooks).toHaveLength(0);
    expect(r.unmatchedAs26).toHaveLength(0);
  });
  it("ambiguous: multiple fitting subsets never force a pick", () => {
    const facts = bookFacts([["20250612", 30000]]);
    const file = txFile([txn(20000), txn(10000), txn(25000, null, "20250620"), txn(5000, null, "20250621")], 60000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20251231");
    expect(r.ambiguous).toBeGreaterThanOrEqual(1);
    expect(r.unmatchedBooks).toHaveLength(1);
    expect(r.combinations).toHaveLength(0);
  });
  it("cap: over 40 unmatched per side skips the search", () => {
    const facts = bookFacts(Array.from({ length: 41 }, (_, i) => [`202506${String(1 + i % 20).padStart(2, "0")}`, 1000 + i] as [string, number]));
    const file = txFile([txn(999999)], 999999);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20251231");
    expect(r.combinationSearchSkipped).toBe(true);
    expect(r.combinations).toHaveLength(0);
  });
  it("tolerance: ₹0.60 reconciles, ₹1.60 does not", () => {
    const near = bookFacts([["20250612", 10000.6]]);
    const fNear = txFile([txn(10000)], 10000);
    expect(reconcileParty(fNear, near, matchOf(fNear, near), "20251231").paired).toHaveLength(1);
    const far = bookFacts([["20250612", 10001.6]]);
    const r = reconcileParty(fNear, far, matchOf(fNear, far), "20251231");
    expect(r.paired).toHaveLength(0);
    expect(r.unmatchedBooks).toHaveLength(1);
    expect(r.unmatchedAs26).toHaveLength(1);
  });
  it("late booking sums where bookingDate > toDate; totals stay primary", () => {
    const facts = bookFacts([["20250612", 7000]]);
    const file = txFile([txn(7000), txn(3000, "20260115", "20250620")], 10000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20251231");
    expect(r.lateBookedTax).toBe(3000);
    expect(r.as26Tax).toBe(10000);
    expect(r.booksTax).toBe(7000);
  });
});

describe("multi-ledger aggregation", () => {
  const splitFacts = (): BooksFacts => ({
    deductions: [
      { ledgerKey: canonicalKey("Anand Buildmart Pvt Ltd"), kind: "tds", date: "20250612", tax: 10000, voucherType: "Journal" },
      { ledgerKey: canonicalKey("Kaveri Minerals Trading"), kind: "tds", date: "20250613", tax: 14000, voucherType: "Journal" },
    ],
    sales: [],
  });
  const splitMap = { mappings: [
    { ledger: "Anand Buildmart Pvt Ltd", as26Name: nameOf },
    { ledger: "Kaveri Minerals Trading", as26Name: nameOf },
  ]};
  it("sums every ledger mapped to one deductor and compares against 26AS once", () => {
    const file = txFile([txn(24000)], 24000);
    const r = analyzeAs26(file, splitFacts(), splitMap, ledgers, { fromDate: "20250401", toDate: "20251231" });
    expect(r.recon).toHaveLength(1);
    expect(r.recon[0].booksTax).toBe(24000);
    expect(r.recon[0].as26Tax).toBe(24000);
    expect(r.recon[0].match.ledgerName).toBe("Anand Buildmart Pvt Ltd + Kaveri Minerals Trading");
    expect(r.findings.some((f) => f.check === "books_tax_not_in_26as" || f.check === "as26_tax_not_in_books")).toBe(false);
  });
  it("would report a shortfall if only one of the split ledgers were mapped", () => {
    const file = txFile([txn(24000)], 24000);
    const r = analyzeAs26(file, splitFacts(), { mappings: [splitMap.mappings[0]] }, ledgers, { fromDate: "20250401", toDate: "20251231" });
    const f = r.findings.find((x) => x.check === "as26_tax_not_in_books")!;
    expect(f).toBeTruthy();
    expect(f.amount).toBe(14000);
  });
});

// --- Task 8: stage-3 findings ---

import { analyzeAs26 } from "../src/as26.js";
import type { As26Finding } from "../src/types.js";

const result = (
  ded: Array<[string, number]>,
  tx: As26Transaction[],
  total: number,
  opts: { sales?: BooksFacts["sales"]; gross?: number; toDate?: string; led?: string[] } = {},
) => {
  const file = txFile(tx, total);
  const s = file.summaries[0];
  if (opts.gross !== undefined) s.gross = opts.gross;
  const f: BooksFacts = { deductions: bookFacts(ded).deductions, sales: opts.sales ?? [] };
  return analyzeAs26(
    file, f, mapper, opts.led ?? ledgers,
    { fromDate: "20250401", toDate: opts.toDate ?? "20251231" },
  );
};

describe("analyzeAs26 — findings 001–008", () => {
  it("001 fires with the invoice schedule, money detail and the late-booking annotation", () => {
    const sales = [{ ledgerKey: NK, date: "20250612", ref: "CS/9", taxable: 160000, gross: 190000 }];
    const r = result(
      [["20250612", 190000]],
      [txn(180000), txn(7000, "20260115", "20250620")],
      187000,
      { sales, toDate: "20251231", gross: 187000 },
    );
    const f = r.findings.find((x) => x.check === "books_tax_not_in_26as")!;
    expect(f).toBeTruthy();
    expect(f.severity).toBe("critical");
    expect(f.id).toBe("AS26-001-1");
    expect(f.amount).toBe(3000);
    expect(f.detail).toMatch(/1,90,000\.00/);
    expect(f.detail).toMatch(/1,87,000\.00/);
    expect(f.detail).toMatch(/31-Dec-2025/); // date never bare
    expect(f.detail).toMatch(/booked after/);
    expect(f.schedule).toHaveLength(1);
    expect(f.schedule![0]).toMatchObject({ label: "CS/9", amount: 190000, date: "20250612" });
    for (const x of r.findings) expect(x.detail).not.toMatch(/\d{6,}/);
  });
  it("002 fires on 26AS excess with the latest booking date and statuses seen", () => {
    const r = result([["20250612", 100000]], [txn(104000), txn(3000, "20260210", "20250801")], 107000);
    const f = r.findings.find((x) => x.check === "as26_tax_not_in_books")!;
    expect(f.severity).toBe("critical");
    expect(f.detail).toMatch(/10-Feb-2026/);
    expect(f.detail).toMatch(/F, O/);
    expect(f.amount).toBe(7000);
  });
  it("003 says explicitly when the GST-inclusive interpretation matched", () => {
    const sales = [{ ledgerKey: NK, date: "20250612", ref: null, taxable: 40000, gross: 47200 }];
    const r = result([["20250612", 18000]], [txn(18000)], 18000, { sales, gross: 47200 });
    const f = r.findings.find((x) => x.check === "assessable_value_mismatch")!;
    expect(f.severity).toBe("warning");
    expect(f.amount).toBe(7200);
    expect(f.detail).toMatch(/GST-inclusive/);
  });
  it("003 with neither interpretation matching names the closer one", () => {
    const sales = [{ ledgerKey: NK, date: "20250612", ref: null, taxable: 40000, gross: 50000 }];
    const r = result([["20250612", 18000]], [txn(18000)], 18000, { sales, gross: 47200 });
    const f = r.findings.find((x) => x.check === "assessable_value_mismatch")!;
    expect(f.amount).toBe(2800); // the smaller delta
    expect(f.detail).toMatch(/closer/);
  });
  it("004 fires per mapping gap with the tax at stake", () => {
    const EMPTY = analyzeAs26(txFile([txn(18000)], 18000), facts(ledgers), { mappings: [] }, ledgers, {
      fromDate: "20250401", toDate: "20251231",
    });
    const f = EMPTY.findings.find((x) => x.check === "mapping_gap")!;
    expect(f.id).toBe("AS26-004-1");
    expect(f.severity).toBe("review");
    expect(f.amount).toBe(18000);
    expect(EMPTY.findings.filter((x) => x.check === "mapping_gap").length).toBeGreaterThanOrEqual(4);
  });
  it("005 fires per party with late-booked tax", () => {
    const r = result([["20250612", 7000]], [txn(7000), txn(3000, "20260115", "20250620")], 10000);
    const f = r.findings.find((x) => x.check === "late_booking")!;
    expect(f.severity).toBe("review");
    expect(f.amount).toBe(3000);
    expect(f.detail).toMatch(/31-Dec-2025/);
  });
  it("006 fires when the summary and detailed sheets disagree", () => {
    // total 19000 declared, transactions carry 18000
    const r = result([["20250612", 18000]], [txn(18000)], 19000);
    const f = r.findings.find((x) => x.check === "export_inconsistent")!;
    expect(f.severity).toBe("review");
    expect(f.detail).toMatch(/19,000\.00/);
    expect(f.detail).toMatch(/18,000\.00/);
  });
  it("006 fires on a summary row with zero transactions", () => {
    const r = result([], [], 18000);
    expect(r.findings.some((x) => x.check === "export_inconsistent" && /no transactions/.test(x.detail))).toBe(true);
  });
  it("007 fires when totals reconcile but residuals remain", () => {
    const r = result(
      [["20250612", 3000], ["20250613", 3000]],
      [txn(3000), txn(3000, null, "20250620")],
      6000,
    );
    const f = r.findings.find((x) => x.check === "unresolved_combination")!;
    expect(f.severity).toBe("review");
    expect(f.amount).toBe(6000);
    expect(f.schedule!.length).toBeGreaterThanOrEqual(2);
  });
  it("008 fires when a party has deductions but no sale entry in the period", () => {
    const r = result([["20250612", 18000]], [txn(18000)], 18000);
    const f = r.findings.find((x) => x.check === "deduction_without_sale")!;
    expect(f.severity).toBe("review");
    expect(f.amount).toBe(18000);
    expect(f.detail).toMatch(/no sale entry/);
  });
  it("every id matches the AS26 ordinal-pad shape", () => {
    const r = result([["20250612", 18000]], [txn(18000)], 18000);
    for (const f of r.findings) expect(f.id).toMatch(/^AS26-\d{3}-\d+$/);
  });
  it("totals aggregate the matched parties", () => {
    const sales = [{ ledgerKey: NK, date: "20250612", ref: null, taxable: 18000, gross: 18000 }];
    const r = result([["20250612", 18000]], [txn(18000)], 18000, { sales, gross: 18000 });
    expect(r.totals).toMatchObject({ booksTax: 18000, as26Tax: 18000, partiesMatched: 1, ambiguous: 0 });
    expect(r.skipped).toEqual({ noDate: 0, blankTax: 0, form16BCDE: 0 });
    expect(r.recon).toHaveLength(r.totals.partiesMatched);
  });
});
