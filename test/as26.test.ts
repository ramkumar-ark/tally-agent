import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { EMPTY_AS26_MAP, assignFdLedgers, bankShortForms, isFdLedgerName, loadAs26Map, matchParties, type BooksFacts } from "../src/as26.js";
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
import { deductionEvents, booksSales, receivableLedgers, linkInvoice, reconcileParty } from "../src/as26.js";
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
  it("grouped: eleven small books journals explain one 26AS row (addendum 5, size cap raised on an enumerable pool)", () => {
    // live case: 16+103+131+140+307+391+392+440+473+526+2612 = 5,531 booked in
    // April; the 26AS row dated August carries the same tax on ~2,76,550.
    const src = [16, 103, 131, 140, 307, 391, 392, 440, 473, 526, 2612];
    const facts = bookFacts(src.map((t) => ["20250429", t]));
    const file = txFile([txn(5531, "20250809", "20250809",)], 5531);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20251231");
    expect(r.as26Tax).toBe(5531);
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].parts).toHaveLength(11);
    expect(r.combinations[0].side).toBe("as26");
    expect(r.unmatchedBooks).toHaveLength(0);
    expect(r.unmatchedAs26).toHaveLength(0);
    expect(r.ambiguous).toBe(0);
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
    expect(reconcileParty(fNear, near, matchOf(fNear, near), "20251231").paired).toHaveLength(1);    const far = bookFacts([["20250612", 10001.6]]);
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
  it("four identical split deductions pair earliest-books with earliest-26AS", () => {
    // The live case: a government deductor splits one bill's tax across four
    // equal entries; the books side carries four equal deductions. Neither the
    // unique 1:1 stage nor the size-2..4 combination search can pair them.
    const facts = bookFacts([
      ["20250418", 9000], ["20250516", 9000], ["20250617", 9000], ["20250715", 9000],
    ]);
    const file = txFile([
      txn(9000, "20250808", "20250808"), txn(9000, "20250814", "20250814"),
      txn(9000, "20251110", "20251110"), txn(9000, "20251121", "20251121"),
    ], 36000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.paired).toHaveLength(4);
    expect(r.combinations).toHaveLength(0);
    expect(r.unmatchedBooks).toHaveLength(0);
    expect(r.unmatchedAs26).toHaveLength(0);
    expect(r.paired.map((p) => p.books.date)).toEqual(["20250418", "20250516", "20250617", "20250715"]);
    expect(r.paired.map((p) => p.as26.date)).toEqual(["20250808", "20250814", "20251110", "20251121"]);
    expect(r.paired.every((p) => p.books.tax === 9000 && p.as26.tax === 9000)).toBe(true);
  });
  it("equal-amount surplus pairs by nearest date and leaves the rest unmatched", () => {
    const facts = bookFacts([["20250410", 9000], ["20250820", 9000]]);
    const file = txFile([txn(9000, "20250815")], 9000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.paired).toHaveLength(1);
    expect(r.paired[0].books.date).toBe("20250820");
    expect(r.unmatchedBooks).toHaveLength(1);
    expect(r.unmatchedBooks[0].date).toBe("20250410");
    expect(r.unmatchedAs26).toHaveLength(0);
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
  it("003 compares 26AS gross against books taxable only", () => {
    const sales = [{ ledgerKey: NK, date: "20250612", ref: null, taxable: 40000, gross: 47200 }];
    const r = result([["20250612", 18000]], [txn(18000)], 18000, { sales, gross: 47200 });
    const f = r.findings.find((x) => x.check === "assessable_value_mismatch")!;
    expect(f.severity).toBe("warning");
    expect(f.amount).toBe(7200);
    expect(f.detail).toMatch(/books taxable of/);
    expect(f.detail).toMatch(/Bill-level value rows, where present, carry the per-invoice detail\./);
    expect(f.detail).not.toMatch(/Bill-level rows carry the detail/);
    expect(f.detail).not.toMatch(/GST-inclusive/i);
  });
  it("003 stays silent when the taxable comparison matches within tolerance", () => {
    // 26AS gross 40,500 is within 1,000 of books taxable 40,000, but far from the
    // books GST-inclusive gross 47,200 — the dropped basis must not fire.
    const sales = [{ ledgerKey: NK, date: "20250612", ref: null, taxable: 40000, gross: 47200 }];
    const r = result([["20250612", 18000]], [txn(18000)], 18000, { sales, gross: 40500 });
    expect(r.findings.some((x) => x.check === "assessable_value_mismatch")).toBe(false);
  });
  it("003 measures the delta against books taxable, never the closer GST-inclusive gross", () => {
    const sales = [{ ledgerKey: NK, date: "20250612", ref: null, taxable: 40000, gross: 50000 }];
    const r = result([["20250612", 18000]], [txn(18000)], 18000, { sales, gross: 47200 });
    const f = r.findings.find((x) => x.check === "assessable_value_mismatch")!;
    expect(f.amount).toBe(7200); // the taxable delta, even though the gross delta (2,800) is smaller
    expect(f.detail).toMatch(/books taxable of/);
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
    // Genuinely unpaired: neither side's amounts echo the other's, and no
    // subset of size 2..4 reproduces a single item, yet the totals tie.
    const r = result(
      [["20250612", 2000], ["20250613", 2000]],
      [txn(1000), txn(3000, null, "20250620")],
      4000,
    );
    const f = r.findings.find((x) => x.check === "unresolved_combination")!;
    expect(f.severity).toBe("review");
    expect(f.amount).toBe(4000);
    expect(f.schedule!.length).toBeGreaterThanOrEqual(2);
  });
  it("007 does not fire once equal-amount split deductions pair", () => {
    const r = result(
      [["20250418", 9000], ["20250516", 9000], ["20250617", 9000], ["20250715", 9000]],
      [
        txn(9000, "20250808", "20250808"), txn(9000, "20250814", "20250814"),
        txn(9000, "20251110", "20251110"), txn(9000, "20251121", "20251121"),
      ],
      36000,
    );
    expect(r.recon[0].paired).toHaveLength(4);
    expect(r.findings.some((x) => x.check === "unresolved_combination")).toBe(false);
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

// --- addendum 2: totals-only 194R / bank-194A and 20% FD interest (design §12) ---

const tx194 = (section: string, tx: As26Transaction[], total: number, gross = 0): As26File => ({
  summaries: [{ kind: "tds", name: nameOf, nameKey: NK, section, taxTotal: total, taxClaimed: 0, balanceCf: 0, gross }],
  transactions: tx,
  skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
});
const tx194n = (tax: number, section: string, date = "20250612", bookingDate: string | null = null, amount?: number): As26Transaction => ({
  kind: "tds", nameKey: NK, date, amount: amount ?? tax, tax, status: bookingDate ? "O" : "F", bookingDate, section,
});

/** Invoice-anchored group matching (addendum 6): synthetic 194C party with
 * sales the deductions can rate-link to. `grossOnTx` becomes the 26AS row's
 * amount paid/credited. */
const saleOf = (date: string, ref: string, taxable: number) => ({
  ledgerKey: NK, date, ref, taxable, gross: round2ForTest(taxable * 1.18),
});
const round2ForTest = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const txGross = (tax: number, gross: number, date = "20250809"): As26Transaction => ({
  kind: "tds", nameKey: NK, date, amount: gross, tax, status: "F", bookingDate: null, section: "194C",
});

describe("reconcileParty — invoice-anchored tiers (addendum 6)", () => {
  it("tier 2: two single-journal invoice pools unite when the invoices' taxable sums to the row's gross", () => {
    // one purchase order invoiced as two bills; the deductor's deposit covers both
    const invA = saleOf("20250526", "INV A", 13191869);
    const invB = saleOf("20250526", "INV B", 4887539);
    const facts: BooksFacts = {
      deductions: [
        { ledgerKey: NK, kind: "tds", date: "20250526", tax: 263837, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds", date: "20250526", tax: 97751, voucherType: "Journal" },
      ],
      sales: [invA, invB],
    };
    const file = txFile([txGross(361588, 18079400)], 361588);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20251231");
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].parts).toHaveLength(2);
    expect(r.unmatchedBooks).toHaveLength(0);
    expect(r.unmatchedAs26).toHaveLength(0);
  });

  it("tier 1: a too-big approximate entry is excluded by the plausibility gate and the plausible subset matches", () => {
    // three journals split one invoice's TDS; a fourth entry (a different
    // bill's TDS) exceeds that invoice's whole TDS, so it never pollutes the pool
    const invBig = saleOf("20250917", "INV BIG", 39417820);
    const invSmall = saleOf("20251016", "INV SML", 3262076);
    const facts: BooksFacts = {
      deductions: [432983, 25199, 26333, 13709].map((tax) => ({
        ledgerKey: NK, kind: "tds" as const, date: "20251016", tax, voucherType: "Journal",
      })),
      sales: [invBig, invSmall],
    };
    const file = txFile([txGross(65241, 3262050, "20260228")], 65241);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].parts.map((p) => p.tax).sort((a, b) => a - b)).toEqual([13709, 25199, 26333]);
    expect(r.unmatchedBooks.map((b) => b.tax)).toEqual([432983]);
    expect(r.unmatchedAs26).toHaveLength(0);
    // and the excluded entry links approximately to the plausible big invoice
    const link = linkInvoice([invSmall, invBig], { date: "20251016", tax: 432983, reference: null, section: "194C" });
    expect(link?.sale.ref).toBe("INV BIG");
    expect(link?.basis).toBe("approximate");
  });

  it("a pool with two distinct fitting subsets stays ambiguous, never forced", () => {
    // invoice taxable 1000000 -> whole TDS 20000; entries pair up two ways
    const facts: BooksFacts = {
      deductions: [12000, 8000, 6000, 14000].map((tax) => ({
        ledgerKey: NK, kind: "tds" as const, date: "20250610", tax, voucherType: "Journal",
      })),
      sales: [saleOf("20250501", "INV X", 1000000)],
    };
    const file = txFile([txGross(20000, 1000000)], 20000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20251231");
    expect(r.combinations).toHaveLength(0);
    expect(r.ambiguous).toBeGreaterThanOrEqual(1);
    expect(r.unmatchedBooks).toHaveLength(4);
  });

  it("whole-pool fallback: one deductor spanning two ledgers — the deposit ties the other zone's invoice pool exactly", () => {
    // zone A ledger books the TDS journals; the deposit row's amount names
    // zone B's invoice, but the zone-A pool sums to the deposit exactly
    const facts: BooksFacts = {
      deductions: [21428, 25522].map((tax) => ({
        ledgerKey: "zone-a", kind: "tds" as const, date: "20251014", tax, voucherType: "Journal",
      })),
      sales: [
        { ledgerKey: "zone-a", date: "20251014", ref: "INV A", taxable: 2151293, gross: 2538525 },
        { ledgerKey: "zone-b", date: "20251014", ref: "INV B", taxable: 2347500, gross: 2770050 },
      ],
    };
    const file = txFile([txGross(46950, 2347500, "20260212")], 46950);
    const match = { kind: "tds" as const, as26NameKey: NK, ledgerKeys: ["zone-a", "zone-b"], ledgerNames: ["zone-a", "zone-b"], ledgerName: "zone-a + zone-b" };
    const r = reconcileParty(file, facts, match, "20260331");
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].parts.map((p) => p.tax).sort((a, b) => a - b)).toEqual([21428, 25522]);
    expect(r.unmatchedBooks).toHaveLength(0);
    expect(r.unmatchedAs26).toHaveLength(0);
  });

  it("whole-pool fallback stays silent when two invoice pools both fit — ambiguous, not forced", () => {
    // two invoices, each anchoring a pool that sums to the deposit; neither
    // invoice matches the deposit's own amount or rate
    const facts: BooksFacts = {
      deductions: [
        { ledgerKey: NK, kind: "tds" as const, date: "20251015", tax: 6000, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20251015", tax: 12000, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20251025", tax: 17500, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20251025", tax: 500, voucherType: "Journal" },
      ],
      sales: [
        { ledgerKey: NK, date: "20251001", ref: "INV A", taxable: 800000, gross: 944000 },
        { ledgerKey: NK, date: "20251020", ref: "INV B", taxable: 950000, gross: 1121000 },
      ],
    };
    const file = txFile([txGross(18000, 1234567, "20260212")], 18000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.combinations).toHaveLength(0);
    expect(r.ambiguous).toBeGreaterThanOrEqual(1);
    expect(r.unmatchedBooks).toHaveLength(4);
  });
});

describe("analyzeAs26 — totals-only reconciliation (design §12)", () => {
  it("194R with tying totals raises no findings at all — silence is the success state", () => {
    const file = tx194("194R",
      [tx194n(3000, "194R", "20250612", null, 180000), tx194n(2000, "194R", "20250712", null, 120000)],
      5000, 300000);
    const r = analyzeAs26(file, bookFacts([["20250612", 3000], ["20250712", 2000]]), mapper, ledgers,
      { fromDate: "20250401", toDate: "20251231" });
    expect(r.recon[0].totalsOnly).toBe(true);
    expect(r.findings).toEqual([]);
  });
  it("194R with a totals gap raises 009 critical, never a bill-level finding", () => {
    const file = tx194("194 R", [tx194n(9000, "194 R")], 9000);
    const r = analyzeAs26(file, bookFacts([["20250612", 5000]]), mapper, ledgers,
      { fromDate: "20250401", toDate: "20251231" });
    const f = r.findings.find((x) => x.check === "as26_totals_mismatch")!;
    expect(f).toBeTruthy();
    expect(f.id).toBe("AS26-009-1");
    expect(f.severity).toBe("critical");
    expect(f.amount).toBe(4000);
    expect(f.detail).toMatch(/9,000\.00/);
    expect(f.detail).toMatch(/5,000\.00/);
    expect(f.detail).toMatch(/never bill by bill/);
    expect(r.findings.some((x) =>
      x.check === "books_tax_not_in_26as" || x.check === "unresolved_combination" ||
      x.check === "deduction_without_sale")).toBe(false);
  });
  it("a bank-marked 194A party compares totals with a 20% FD event excluded and reported", () => {
    const file = tx194("194A", [tx194n(5000, "194A", "20250801", null, 50000)], 5000, 50000);
    const bankMap = { mappings: [], banks: [{ as26Name: nameOf, interestLedgers: ["Sample Bank FD Int A/c"], fdLedgers: ["Sample Bank FD A/c"] }] };
    const facts20: BooksFacts = {
      deductions: [], sales: [],
      bankEvents: [{ nameKey: NK, events: [
        // 10% event: comparable
        { nameKey: NK, date: "20250801", interest: 50000, tax: 5000, fdDebit: 45000 },
        // 20% event: excluded, reported separately
        { nameKey: NK, date: "20251101", interest: 5000, tax: 1000, fdDebit: 4000 },
      ]}],
    };
    const r = analyzeAs26(file, facts20, bankMap, ledgers, { fromDate: "20250401", toDate: "20251231" });
    expect(r.recon[0].totalsOnly).toBe(true);
    expect(r.findings.some((f) => f.check === "as26_totals_mismatch")).toBe(false);
    const f20 = r.findings.find((f) => f.check === "fd_20pct_tds")!;
    expect(f20).toBeTruthy();
    expect(f20.id).toBe("AS26-010-1");
    expect(f20.severity).toBe("review");
    expect(f20.amount).toBe(1000);
    expect(f20.detail).toMatch(/1 FD interest entry\/entries/);
    expect(f20.detail).toMatch(/not expected to reflect in 26AS/);
    expect(r.fd20).toEqual([{ nameKey: NK, date: "20251101", interest: 5000, tax: 1000, fdDebit: 4000 }]);
  });
  it("a bank's tax totals tie but interest misses 003's value tolerance — 009 warning", () => {
    const file = tx194("194A", [tx194n(10000, "194A", "20250801", null, 60000)], 10000, 60000);
    const bankMap = { mappings: [], banks: [{ as26Name: nameOf, interestLedgers: ["Sample Bank FD Int A/c"], fdLedgers: [] }] };
    const factsInt: BooksFacts = {
      deductions: [], sales: [],
      bankEvents: [{ nameKey: NK, events: [{ nameKey: NK, date: "20250801", interest: 40000, tax: 10000, fdDebit: 30000 }] }],
    };
    const r = analyzeAs26(file, factsInt, bankMap, ledgers, { fromDate: "20250401", toDate: "20251231" });
    const f = r.findings.find((x) => x.check === "as26_totals_mismatch")!;
    expect(f.severity).toBe("warning");
    expect(f.amount).toBe(20000);
    expect(f.detail).toMatch(/tax totals tie but the interest does not/);
    expect(f.detail).toMatch(/books interest total/);
  });
  it("a mixed party (bill-level plus 194R section) keeps the bill-level behaviour", () => {
    const file = { summaries: [
      { kind: "tds" as const, name: nameOf, nameKey: NK, section: "194C", taxTotal: 6000, taxClaimed: 0, balanceCf: 0, gross: 0 },
      { kind: "tds" as const, name: nameOf, nameKey: NK, section: "194R", taxTotal: 0, taxClaimed: 0, balanceCf: 0, gross: 0 },
    ], transactions: [tx194n(6000, "194C")], skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 } };
    const r = analyzeAs26(file, bookFacts([["20250612", 190000]]), mapper, ledgers,
      { fromDate: "20250401", toDate: "20251231" });
    expect(r.recon[0].totalsOnly).toBe(false);
    expect(r.findings.some((x) => x.check === "books_tax_not_in_26as")).toBe(true);
  });
  it("a bank marked with no ledgers at all surfaces 009 review, never a lesson-learnt critical", () => {
    const file = tx194("194A", [tx194n(10000, "194A")], 10000);
    const bankMap = { mappings: [], banks: [{ as26Name: nameOf, interestLedgers: [], fdLedgers: [] }] };
    const r = analyzeAs26(file, bookFacts([]), bankMap, ledgers, { fromDate: "20250401", toDate: "20251231" });
    const f = r.findings.find((x) => x.check === "as26_totals_mismatch")!;
    expect(f.severity).toBe("review");
    expect(f.detail).toMatch(/names this bank but none of its interest income or FD ledgers/);
  });
});

describe("FD ledger auto-detection and assignment (addendum 3/3a)", () => {
  it("isFdLedgerName: FD tokens whole and case-insensitive; EMD/security/retention are not FDs", () => {
    expect(isFdLedgerName("FD - 123456")).toBe(true);
    expect(isFdLedgerName("fd 123")).toBe(true);
    expect(isFdLedgerName("fix.?. F.D 77")).toBe(true);
    expect(isFdLedgerName("FD A 123")).toBe(true);
    expect(isFdLedgerName("FIXED DEPOSIT 22/2025")).toBe(true);
    expect(isFdLedgerName("EMD - 12345678")).toBe(false);
    expect(isFdLedgerName("SECURITY DEPOSIT - 990")).toBe(false);
    expect(isFdLedgerName("RETENTION MONEY A/c")).toBe(false);
  });

  it("bankShortForms: UBI, UB (the before-'of' initials), punctuation-normalised", () => {
    expect(bankShortForms("Union Bank of India")).toEqual(
      expect.arrayContaining(["UBI", "UB"]),
    );
    // branch/city suffix words are ignored
    expect(bankShortForms("Union Bank of India (Ro Chennai)")).toEqual(
      expect.arrayContaining(["UBI", "UB"]),
    );
    expect(bankShortForms("State Bank of India")).toEqual(expect.arrayContaining(["SBI"]));
    expect(bankShortForms("Indian Overseas Bank")).toEqual(expect.arrayContaining(["IOB"]));
  });

  it("rule 3a: a distinctive token of exactly one bank assigns by name match", () => {
    const [canara, ubi, punct] = assignFdLedgers(
      ["FD - 12345 CANARA", "Deposit 555 Union Bank", "FD - 700 - U.B.I"],
      ["CANARA BANK", "Union Bank of India"],
    );
    expect(canara.bank).toBe("CANARA BANK");
    expect(canara.rule).toBe("name-match");
    expect(ubi.bank).toBe("Union Bank of India");
    expect(ubi.rule).toBe("name-match");
    expect(punct.bank).toBe("Union Bank of India");
    expect(punct.rule).toBe("name-match");
  });

  it("rule 3a: the two-letter short form UB matches only as a standalone token", () => {
    const standalone = assignFdLedgers(["FD UB OD 123"], ["Union Bank of India"]);
    expect(standalone[0].bank).toBe("Union Bank of India");
    const insideWord = assignFdLedgers(["FD PUBLICBANK 123"], ["Union Bank of India"]);
    // PUBLICBANK is one whole token; UB never matches inside it, and with no
    // name match the single listed bank still takes it by fallback.
    expect(insideWord[0].bank).toBe("Union Bank of India");
    expect(insideWord[0].rule).toBe("only-bank");
  });
  it("rule 3a: a short form fitting two listed banks does not match", () => {
    const [unassigned] = assignFdLedgers(
      ["FD - 3412 - UBI"],
      ["Union Bank of India", "United Bank of India"],
    );
    expect(unassigned.bank).toBeUndefined();
    expect(assignFdLedgers(["FD - 3412 - UBI"], ["Union Bank of India", "United Bank of India", "CANARA BANK"])[0].bank).toBeUndefined();
  });

  it("rule 3b: exactly one listed bank takes the unattributable FD ledgers", () => {
    const [only] = assignFdLedgers(["FD - 100099222"], ["Union Bank of India"]);
    expect(only.bank).toBe("Union Bank of India");
    expect(only.rule).toBe("only-bank");
  });

  it("rule 3c: several banks and no name match — unassigned", () => {
    const [none] = assignFdLedgers(["FD - 100099222"], ["CANARA BANK", "Union Bank of India"]);
    expect(none.bank).toBeUndefined();
    expect(none.rule).toBeUndefined();
  });

  it("the engine emits AS26-011 for the unassigned remainder, counts and money only", () => {
    const file = tx194("194A", [tx194n(3000, "194A", "20250801", null, 30000)], 3000, 30000);
    const factsAuto: BooksFacts = {
      deductions: [], sales: [],
      fdAuto: { rows: [{ ledger: "FD - 100099221" }], unassigned: ["FD - 100099222", "FD - 100099"], interest: 10050.5 },
    };
    const r = analyzeAs26(file, factsAuto, mapper, ledgers, { fromDate: "20250401", toDate: "20251231" });
    const f = r.findings.find((x) => x.check === "fd_ledgers_unassigned")!;
    expect(f).toBeTruthy();
    expect(f.id).toBe("AS26-011-1");
    expect(f.severity).toBe("review");
    expect(f.detail).toMatch(/2 fixed-deposit ledger\(s\)/);
    expect(f.detail).toMatch(/10,050\.50/);
    expect(f.detail).not.toMatch(/1000992/);
  });

  it("the result's fdAuto audit rows carry only assigned rows, ledger/bank/rule", () => {
    const file = tx194("194A", [], 0, 0);
    const factsRows: BooksFacts = {
      deductions: [], sales: [],
      fdAuto: {
        rows: [{ ledger: "FD - 100099222 A", bank: "Union Bank of India", rule: "name-match" }, { ledger: "FD - 100099222 B" }],
        unassigned: ["FD - 100099222 B"], interest: 0,
      },
    };
    const r = analyzeAs26(file, factsRows, mapper, ledgers, { fromDate: "20250401", toDate: "20251231" });
    expect(r.fdAuto).toEqual([{ ledger: "FD - 100099222 A", bank: "Union Bank of India", rule: "name-match" }]);
  });
});

describe("addendum 5a — Deductors basis, channel unity, skip wording", () => {
  it("value delta measures the taxable basis when that is closest, and 0 when it ties", () => {
    const sales = [{ ledgerKey: NK, date: "20250612", ref: "CS/9", taxable: 180000, gross: 212400 }];
    const r = result([["20250612", 18000]], [txn(18000)], 18000, { sales, gross: 180000 });
    expect(r.recon[0].valueBasis).toBe("taxable");
    expect(r.recon[0].valueDelta).toBe(0);
    const g = result([["20250612", 18000]], [txn(18000)], 18000, { sales, gross: 214000 });
    expect(g.recon[0].valueBasis).toBe("GST-inclusive");
    expect(g.recon[0].valueDelta).toBe(-1600); // selected books gross 2,12,400 vs 26AS 2,14,000
  });
  it("a bank's Deductors books-tax cell uses the same operator channel the 009 compare uses", () => {
    const file = tx194("194A", [tx194n(5000, "194A", "20250801", null, 50000)], 5000, 50000);
    const bankMap = { mappings: [], banks: [{ as26Name: nameOf, interestLedgers: ["Sample Bank FD Int A/c"], fdLedgers: [] }] };
    const facts: BooksFacts = {
      // raw mapped-ledger deductions would read 4,600 under the old channel
      deductions: [{ ledgerKey: NK, kind: "tds" as const, date: "20250801", tax: 4600, voucherType: "Journal" }],
      sales: [],
      bankEvents: [{ nameKey: NK, events: [{ nameKey: NK, date: "20250801", interest: 50000, tax: 0, fdDebit: 50000 }] }],
    };
    const r = analyzeAs26(file, facts, bankMap, ledgers, { fromDate: "20250401", toDate: "20251231" });
    expect(r.recon[0].totalsOnly).toBe(true);
    expect(r.recon[0].booksTax).toBe(0);
  });
  it("when the bounded search is skipped, the party's findings say so in plain words", () => {
    const items = Array.from({ length: 41 }, (_, i) => txn(1000 + i, "20250612"));
    const r = result([], items, 43000, {});
    const f = r.findings.find((x) => x.check === "as26_tax_not_in_books")!;
    expect(f.detail).toMatch(/item-combination search was skipped/);
  });
});
