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
  it("a ledger mapped to two 26AS names is allowed (a shared-ledger party)", () => {
    const shared = JSON.stringify({ mappings: [
      { ledger: "Alpha Traders", as26Name: "Alpha Traders" },
      { ledger: "Alpha Traders", as26Name: "Executive Engineer Alpha Division" },
    ]});
    expect(loadAs26Map(mapFile(shared)).mappings).toEqual([
      { ledger: "Alpha Traders", as26Name: "Alpha Traders" },
      { ledger: "Alpha Traders", as26Name: "Executive Engineer Alpha Division" },
    ]);
  });
  it("the same ledger AND name pair twice throws citing the entry index, never a value", () => {
    const dup = JSON.stringify({ mappings: [
      { ledger: "Alpha Traders", as26Name: "Alpha Traders" },
      { ledger: "Alpha Traders", as26Name: "ALPHA TRADERS" },
    ]});
    let msg = "";
    try { loadAs26Map(mapFile(dup)); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/as26-map entry 2/);
    expect(msg).not.toContain("Alpha");
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
import { deductionEvents, booksSales, receivableLedgers, linkInvoice, reconcileParty, deductorKey, rekeyDeductionsToDeductor, otherIncomeCredits, voucherIdentity, AS26_TAX_TOLERANCE } from "../src/as26.js";
import { projectLedgerRows } from "../src/tds-daybook.js";
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

describe("deductorKey / rekeyDeductionsToDeductor (addendum 9)", () => {
  // Mirrors the review's party test: a ledger parked under Sundry
  // Debtors/Creditors, nothing else.
  const parentOf = new Map([
    ["d-engineer", "Sundry Debtors"],
    ["contractee receivable", "Sundry Debtors"],
    ["exempt contract income", "Indirect Incomes"],
    ["site expenses", "Indirect Expenses"],
  ]);
  const isPartyLedger = (n: string): boolean =>
    ["sundry debtors", "sundry creditors"].includes((parentOf.get(canonicalKey(n)) ?? "").toLowerCase());
  it("a party counterparty always wins, even when the voucher party differs", () => {
    expect(deductorKey("D-Engineer", "Contractee Receivable", isPartyLedger)).toBe("d-engineer");
  });
  it("an income counterparty falls back to the voucher party line", () => {
    expect(deductorKey("Exempt Contract Income", "D-Engineer", isPartyLedger)).toBe("d-engineer");
  });
  it("a non-party counterparty with no party evidence keeps its key (honest gap)", () => {
    expect(deductorKey("Exempt Contract Income", "Site Expenses", isPartyLedger))
      .toBe("exempt contract income");
    expect(deductorKey("Exempt Contract Income", null, isPartyLedger))
      .toBe("exempt contract income");
  });
  it("a gross-up journal's TDS debit joins the deductor; normal rows are untouched", () => {
    const grossUp: VoucherRow = {
      date: "20251201", voucherType: "Journal", voucherNumber: "1001",
      partyLedgerName: "D-Engineer", cancelled: false,
      entries: [
        { ledger: "D-Engineer", amount: 1500000 },
        { ledger: "TDS Receivable", amount: 30000 },
        { ledger: "Exempt Contract Income", amount: -1530000 },
      ],
    };
    const normal: VoucherRow = {
      date: "20250411", voucherType: "Journal", voucherNumber: "1002",
      partyLedgerName: "Contractee Receivable", cancelled: false,
      entries: [
        { ledger: "Contractee Receivable", amount: 60000 },
        { ledger: "TDS Receivable", amount: 50000 },
        { ledger: "D-Engineer", amount: -110000 },
      ],
    };
    const byLedger = new Map(
      projectLedgerRows([grossUp, normal], ["TDS Receivable"])
        .map((p) => [canonicalKey(p.ledger), p.rows] as const),
    );
    const { events } = deductionEvents(byLedger.get("tds receivable") ?? [], "tds");
    expect(events).toHaveLength(2);
    // The projector is display-faithful: the gross-up row shows the income ledger.
    expect(events[0].ledgerKey).toBe("exempt contract income");
    const rekeyed = rekeyDeductionsToDeductor(events, [grossUp, normal], isPartyLedger);
    expect(rekeyed[0].ledgerKey).toBe("d-engineer");
    expect(rekeyed[0].tax).toBe(30000);
    expect(rekeyed[1].ledgerKey).toBe("d-engineer");
    // An event whose voucher is gone keeps its key rather than guessing.
    const orphan = rekeyDeductionsToDeductor(
      [{ ...events[0], voucherNumber: "nope" }], [grossUp, normal], isPartyLedger,
    );
    expect(orphan[0].ledgerKey).toBe("exempt contract income");
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

describe("otherIncomeCredits (addendum 10)", () => {
  const ctx: GstCtx = {
    groupOf: (l) => (l === "Bonus Income" || l === "Interest Recd on FD A/c" ? "Indirect Incomes" : "Sundry Debtors"),
    rootOf: (g) => (g === "Indirect Incomes" ? "Indirect Incomes" : null),
    roleOf: () => "other",
    inDutiesAndTaxes: () => false,
    gstinOf: () => null,
  };
  const v: VoucherRow = {
    date: "20250620", voucherType: "Journal", voucherNumber: "JV/2", reference: "",
    partyLedgerName: "Bonus Co", cancelled: false,
    entries: [
      { ledger: "TDS Receivable", amount: 300 },
      { ledger: "Bonus Co", amount: 2300 },
      { ledger: "Bonus Income", amount: -2600 },
    ],
  };
  const partyKeyByVoucher = new Map([[voucherIdentity("20250620", "Journal", "JV/2"), "bonus co"]]);

  it("attributes a same-voucher income credit to the voucher's party", () => {
    const out = otherIncomeCredits([v], ctx, partyKeyByVoucher, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(2600);
    expect(out[0].partyKey).toBe("bonus co");
    expect(out[0].incomeLedger).toBe("Bonus Income");
    expect(out[0].voucherType).toBe("Journal");
  });

  it("never counts an income ledger already in the bank/FD basis (guard)", () => {
    const out = otherIncomeCredits([v], ctx, partyKeyByVoucher, new Set([canonicalKey("Bonus Income")]));
    expect(out).toEqual([]);
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
  it("a tcs-only ledger name needs no 'receivable' (addendum 8), mixed tds/tcs names stay tds", () => {
    const led = receivableLedgers([
      { name: "TCS FY 25-26", parent: "Loans & Advances (Asset)" },
      { name: "TDS/TCS Receivable", parent: "Current Assets" },
      { name: "TCS Collected", parent: "Duties & Taxes" },
      { name: "Loans & Advances (Asset)", parent: "" },
    ], (g) => g.includes("Current Assets") || g.includes("Loans & Advances"));
    expect(led).toEqual([
      { name: "TCS FY 25-26", kind: "tcs" },
      { name: "TDS/TCS Receivable", kind: "tds" },
    ]);
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
  it("aggregate: one books deduction equal to the SUM of many 26AS lines matches one-to-many", () => {
    // The books booked a single deduction; the deductor reported the same tax
    // as many small 26AS detail rows. No subset of size 2..4 can reach the
    // target, so the old books-direction cap left both sides unexplained.
    const parts = [...Array.from({ length: 11 }, () => 1426), 1421];
    expect(parts.reduce((a, b) => a + b, 0)).toBe(17107);
    const facts = bookFacts([["20260331", 17107]]);
    const file = txFile(parts.map((t) => txn(t, null, "20251231")), 17107);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].side).toBe("books");
    expect(r.combinations[0].parts).toHaveLength(12);
    expect(r.combinations[0].parts.reduce((t, p) => t + p.tax, 0)).toBe(17107);
    expect(r.unmatchedBooks).toHaveLength(0);
    expect(r.unmatchedAs26).toHaveLength(0);
    expect(r.ambiguous).toBe(0);
  });
  it("aggregate: a five-line 26AS tail is still one fit (minuscule pool)", () => {
    const facts = bookFacts([["20260331", 8000]]);
    const file = txFile([1600, 1600, 1600, 1600, 1600].map((t) => txn(t, null, "20251231")), 8000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.unmatchedBooks).toHaveLength(0);
    expect(r.combinations[0].parts).toHaveLength(5);
  });
  it("aggregate: a large 26AS tail keeps the size-4 cap (no combinatorial blow-up)", () => {
    // Pool larger than COMBINATION_GROUP_POOL_MAX stays at size 4: the 16-line
    // 26AS tail is NOT reassembled into the single books entry.
    const facts = bookFacts([["20260331", 1600]]);
    const file = txFile(Array.from({ length: 16 }, () => txn(100, null, "20251231")), 1600);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.combinations).toHaveLength(0);
    expect(r.unmatchedBooks).toHaveLength(1);
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

// --- shared-ledger groups: ONE Tally ledger, several 26AS names ---

import { buildBillRows } from "../src/as26-bill.js";

const THIRD_NAME = "Alpha Works Town Office";

describe("shared-ledger group (one ledger, two 26AS names)", () => {
  // The real shape: a party that deducts under a short name and under a
  // departmental one, both landing on a single Tally ledger. Invented names,
  // CMDA's proportions — the books carry exactly the sum, so nothing is
  // mismatched and the group must produce no money finding at all.
  const SHORT = "Alpha Works Agency";
  const DEPT = "Executive Engineer Alpha Division";
  const LEDGER = "Alpha Works Ledger";
  const LK = canonicalKey(LEDGER);
  const sharedFile = (): As26File => ({
    summaries: [
      { kind: "tds", name: SHORT, nameKey: canonicalKey(SHORT), section: "194C", taxTotal: 523944, taxClaimed: 0, balanceCf: 0, gross: 2619720 },
      { kind: "tds", name: DEPT, nameKey: canonicalKey(DEPT), section: "194C", taxTotal: 1144952, taxClaimed: 0, balanceCf: 0, gross: 5724760 },
    ],
    transactions: [
      { kind: "tds", nameKey: canonicalKey(SHORT), date: "20250810", amount: 2619720, tax: 523944, status: "F", bookingDate: null, section: "194C" },
      { kind: "tds", nameKey: canonicalKey(DEPT), date: "20250914", amount: 5724760, tax: 1144952, status: "F", bookingDate: null, section: "194C" },
    ],
    skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
  });
  const sharedMap = { mappings: [
    { ledger: LEDGER, as26Name: SHORT },
    { ledger: LEDGER, as26Name: DEPT },
  ]};
  const books = (tax: number): BooksFacts => ({
    deductions: [{ ledgerKey: LK, kind: "tds" as const, date: "20250901", tax, voucherType: "Journal" }],
    sales: [],
  });
  const WINDOW = { fromDate: "20250401", toDate: "20251231" };

  it("matchParties merges the names into ONE shared party, each name keeping its own tax", () => {
    const { matches, gaps } = matchParties(sharedFile(), books(1668896), sharedMap, [LEDGER]);
    expect(matches).toHaveLength(1);
    const m = matches[0];
    expect(m.shared).toBe(true);
    expect(m.ledgerKeys).toEqual([LK]);
    expect(m.ledgerName).toBe(LEDGER);
    expect(m.as26Name).toBe(SHORT); // the first-inserted name labels the group
    expect(m.members).toEqual([
      { as26NameKey: canonicalKey(SHORT), as26Name: SHORT, kind: "tds", tax: 523944, ledgerNames: [LEDGER] },
      { as26NameKey: canonicalKey(DEPT), as26Name: DEPT, kind: "tds", tax: 1144952, ledgerNames: [LEDGER] },
    ]);
    // neither name resurfaces as an unmapped gap, and the ledger is consumed
    expect(gaps.filter((g) => g.reason === "unmapped")).toHaveLength(0);
  });

  it("books tax equal to the sum of the names reconciles with zero delta and no finding", () => {
    const r = analyzeAs26(sharedFile(), books(1668896), sharedMap, [LEDGER], WINDOW);
    expect(r.recon).toHaveLength(1);
    expect(r.recon[0].booksTax).toBe(1668896);
    expect(r.recon[0].as26Tax).toBe(1668896);
    expect(r.recon[0].totalsOnly).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("a shortfall surfaces as 009 naming every member with its own 26AS tax, no guessed split", () => {
    const r = analyzeAs26(sharedFile(), books(1600000), sharedMap, [LEDGER], WINDOW);
    const f = r.findings.find((x) => x.check === "as26_totals_mismatch")!;
    expect(f).toBeTruthy();
    expect(f.severity).toBe("critical");
    expect(f.amount).toBe(68896);
    expect(f.detail).toContain(SHORT);
    expect(f.detail).toContain(DEPT);
    expect(f.detail).toMatch(/5,23,944\.00/);   // each name's OWN figure
    expect(f.detail).toMatch(/11,44,952\.00/);
    expect(f.detail).toMatch(/16,68,896\.00/);  // the sum the group compares
    expect(f.detail).toMatch(/not split between them/);
    for (const x of r.findings) expect(x.detail).not.toMatch(/\d{6,}/);
  });

  it("the group is never paired item by item and yields no drill-down rows", () => {
    const r = analyzeAs26(sharedFile(), books(1668896), sharedMap, [LEDGER], WINDOW);
    const rec = r.recon[0];
    expect(rec.paired).toEqual([]);
    expect(rec.combinations).toEqual([]);
    expect(rec.unmatchedBooks).toEqual([]);
    expect(rec.unmatchedAs26).toEqual([]);
    expect(buildBillRows(r, { deductions: books(1668896).deductions, sales: [] }, sharedFile(), WINDOW)).toEqual([]);
  });

  it("the same ledger under a TDS and a TCS name stays two parties (kind is not mixed)", () => {
    const file = parseAs26Export(buildAs26Fixture());
    const cross = { mappings: [
      { ledger: "Kaveri Minerals Trading", as26Name: "Nagar Palika Nagar Bhavan" },
      { ledger: "Kaveri Minerals Trading", as26Name: "Kaveri Minerals Trading" },
    ]};
    const { matches } = matchParties(file, facts([]), cross, ledgers);
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.shared === undefined)).toBe(true);
    expect(matches.map((m) => m.kind).sort()).toEqual(["tcs", "tds"]);
  });

  it("a plain one-to-one map carries no shared/members fields at all", () => {
    const { matches } = matchParties(sharedFile(), books(1668896), { mappings: [sharedMap.mappings[0]] }, [LEDGER]);
    expect(matches).toHaveLength(1);
    expect(matches[0].shared).toBeUndefined();
    expect("members" in matches[0]).toBe(false);
  });

  it("a three-name component, one name owning two ledgers, keeps the whole picture", () => {
    const SECOND = "Alpha Works Head Office";
    const file: As26File = {
      ...sharedFile(),
      summaries: [...sharedFile().summaries, { kind: "tds", name: THIRD_NAME, nameKey: canonicalKey(THIRD_NAME), section: "194C", taxTotal: 100, taxClaimed: 0, balanceCf: 0, gross: 500 }],
      transactions: [...sharedFile().transactions, { kind: "tds" as const, nameKey: canonicalKey(THIRD_NAME), date: "20251001", amount: 500, tax: 100, status: "F", bookingDate: null, section: "194C" }],
    };
    const map = { mappings: [
      { ledger: LEDGER, as26Name: SHORT },
      { ledger: SECOND, as26Name: SHORT },
      { ledger: LEDGER, as26Name: DEPT },
      { ledger: LEDGER, as26Name: THIRD_NAME },
    ]};
    const r = analyzeAs26(file, books(1668996), map, [LEDGER, SECOND], WINDOW);
    expect(r.recon).toHaveLength(1);
    expect(r.recon[0].match.ledgerKeys).toEqual([LK, canonicalKey(SECOND)]);
    expect(r.recon[0].match.members!.map((m) => m.as26Name)).toEqual([SHORT, DEPT, THIRD_NAME]);
    // SHORT's own ledgers are the two it was mapped to, not the group's
    expect(r.recon[0].match.members![0].ledgerNames).toEqual([LEDGER, SECOND]);
    expect(r.recon[0].as26Tax).toBe(1668996);
    expect(r.recon[0].booksTax).toBe(1668996);
    expect(r.findings).toEqual([]);
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
  it("008 stays silent for a tcs-kind party with no sale (addendum 8: TCS rides purchases)", () => {
    const file = txFile([{ ...txn(18000), kind: "tcs", section: "206CL" }], 18000);
    file.summaries[0].kind = "tcs";
    const tcsFacts: BooksFacts = {
      deductions: bookFacts([["20250612", 18000]]).deductions.map((d) => ({ ...d, kind: "tcs" as const })),
      sales: [],
    };
    const r = analyzeAs26(file, tcsFacts, mapper, ledgers, { fromDate: "20250401", toDate: "20251231" });
    expect(r.findings.some((x) => x.check === "deduction_without_sale")).toBe(false);
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

  it("capacity rule (addendum 7): a fully-claimed invoice is never an approximate anchor, and the rate-exact later invoice takes its journals", () => {
    // one invoice whose whole TDS is claimed by an exact journal, and the
    // true (later) invoice rate-exact for the deposit; the four journals
    // pre-date their invoice, so approximate must refuse to guess
    const facts: BooksFacts = {
      deductions: [
        { ledgerKey: NK, kind: "tds" as const, date: "20250702", tax: 295589, voucherType: "Journal" },
        ...[4840, 22725, 14870, 17527].map((tax) => ({
          ledgerKey: NK, kind: "tds" as const, date: "20250702", tax, voucherType: "Journal" as const,
        })),
      ],
      sales: [
        saleOf("20250702", "INV 10", 14779427), // 2% = 295588.54, claimed by 295589
        saleOf("20250721", "INV 12", 2998069), // 2% = 59961.38 ~ 59962
      ],
    };
    const file = txFile([txGross(59962, 2998100, "20251101")], 59962);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].parts.map((p) => p.tax).sort((a, b) => a - b)).toEqual([4840, 14870, 17527, 22725]);
    expect(r.unmatchedBooks.map((b) => b.tax)).toEqual([295589]);
    expect(r.unmatchedAs26).toHaveLength(0);
  });

  it("rate-exact fallback survives a pool larger than the subset bound (addendum 7 follow-up)", () => {
    // Pool shape mirrors a real books export: the capacity pool holds many
    // items besides the four journals that sum exactly to the target — but
    // each filler is a half-target, so no filler combination can land in the
    // window and the four journals stay the UNIQUE exact subset.
    const filler: Array<[string, number]> = [
      ["20250410", 25000], ["20250415", 25000], ["20250420", 25000], ["20250425", 25000],
      ["20250430", 25000], ["20250505", 25000], ["20250510", 25000], ["20250515", 25000],
      ["20250520", 25000], ["20250525", 25000], ["20250530", 25000], ["20250604", 25000],
      ["20250608", 25000], ["20250616", 25000],
    ];
    const ded: Array<[string, number]> = [
      ...filler,
      ["20250702", 295589],
      ["20250702", 4840], ["20250702", 22725], ["20250702", 14870], ["20250702", 17527],
    ];
    const sales = [
      { ledgerKey: NK, date: "20250702", ref: "INV 10", taxable: 14779427, gross: 17439324 },
      { ledgerKey: NK, date: "20250721", ref: "INV 12", taxable: 2998069, gross: 3537721 },
    ];
    const r = result(ded, [txn(59962, null, "20251101")], 59962, { sales });
    const target = r.recon[0];
    expect(target.unmatchedAs26).toHaveLength(0);
    const combo = target.combinations.find((c) => c.invoiceRef === "INV 12");
    expect(combo).toBeDefined();
    expect(combo!.parts).toHaveLength(4);
    expect(combo!.parts.reduce((t, x) => t + x.tax, 0)).toBeCloseTo(59962, 2);
    expect(target.unmatchedBooks.reduce((t, x) => t + x.tax, 0)).toBeCloseTo(295589 + filler.length * 25000, 2);
    expect(combo!.basis).toBe("taxable-rate");
  });
  it("rate-exact fallback matches unexplained journals even when anchored decoys outnumber them (unanchored journals outvote anchored decoys)", () => {
    // Four journals pre-date their invoice (no earlier invoice explains
    // them: anchor none), while three decoy journals approximately anchor to
    // two other invoices. Both groups sum exactly to the deposit, so the
    // full pool holds two fitting subsets — only the unexplained pool is
    // unique, and the match lands on the true invoice.
    const facts: BooksFacts = {
      deductions: [
        ...[4840, 22725, 14870, 17527].map((tax) => ({
          ledgerKey: NK, kind: "tds" as const, date: "20250702", tax, voucherType: "Journal" as const,
        })),
        { ledgerKey: NK, kind: "tds" as const, date: "20250801", tax: 41092, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20250802", tax: 11876, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20250802", tax: 6994, voucherType: "Journal" },
      ],
      sales: [
        saleOf("20250701", "INV 09", 150000), // 2% = 3000: too small to explain anything
        saleOf("20250721", "INV 12", 2998069), // 2% = 59961.38 ~ 59962
        saleOf("20250801", "INV 20", 2100000), // decoy anchor for 41092
        saleOf("20250802", "INV 21", 700000), // decoy anchor for 11876 + 6994
      ],
    };
    const file = txFile([txGross(59962, 2998100, "20251101")], 59962);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.combinations).toHaveLength(1);
    const combo = r.combinations[0];
    expect(combo.parts.map((p) => p.tax).sort((a, b) => a - b)).toEqual([4840, 14870, 17527, 22725]);
    expect(combo.basis).toBe("taxable-rate");
    expect(combo.invoiceRef).toBe("INV 12");
    expect(r.unmatchedBooks.map((b) => b.tax).sort((a, b) => a - b)).toEqual([6994, 11876, 41092]);
    expect(r.unmatchedAs26).toHaveLength(0);
  });

  it("rate-exact fallback never steals approximately-anchored journals for a later invoice", () => {
    // Every journal already has an invoice explanation (one strong, two
    // approximate); the later rate-exact invoice's pool is therefore empty
    // and the deposit stays unmatched instead of consuming them.
    const facts: BooksFacts = {
      deductions: [
        { ledgerKey: NK, kind: "tds" as const, date: "20250705", tax: 6000, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20250708", tax: 6000, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20250715", tax: 12000, voucherType: "Journal" },
      ],
      sales: [
        saleOf("20250701", "INV A", 500000), // 2% = 10000
        saleOf("20250710", "INV B", 600000), // 2% = 12000: strong anchor for the 12000 journal
        saleOf("20250721", "INV C", 900000), // 2% = 18000: the later deposit's invoice
      ],
    };
    const file = txFile([txGross(18000, 777777, "20251101")], 18000);
    const r = reconcileParty(file, facts, matchOf(file, facts), "20260331");
    expect(r.combinations).toHaveLength(0);
    expect(r.unmatchedBooks).toHaveLength(3);
    expect(r.unmatchedAs26).toHaveLength(1);
  });
  it("capacity fallback stays ambiguous when two rate-exact invoices each hold a fitting subset", () => {
    const facts: BooksFacts = {
      deductions: [6000, 12000, 17500, 500].map((tax) => ({
        ledgerKey: NK, kind: "tds" as const,
        date: tax === 17500 || tax === 500 ? "20251025" : "20251015", tax, voucherType: "Journal" as const,
      })),
      sales: [
        saleOf("20251001", "INV A", 800000), // 2% = 16000
        saleOf("20251020", "INV B", 950000), // 2% = 19000
      ],
    };
    // target tax 18000 = neither invoice's exact rate TDS -> no fallback fires
    const noFit = txFile([txGross(18000, 1234567, "20260212")], 18000);
    const r1 = reconcileParty(noFit, facts, matchOf(noFit, facts), "20260331");
    expect(r1.combinations).toHaveLength(0);
    // now two invoices BOTH rate-exact for 18000 (taxable 900000 each),
    // each anchoring one fitting subset -> ambiguous, nothing consumed
    const facts2: BooksFacts = {
      deductions: [
        { ledgerKey: NK, kind: "tds" as const, date: "20251015", tax: 10000, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20251015", tax: 8000, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20251025", tax: 12000, voucherType: "Journal" },
        { ledgerKey: NK, kind: "tds" as const, date: "20251025", tax: 6000, voucherType: "Journal" },
      ],
      sales: [saleOf("20251001", "INV C", 900000), saleOf("20251020", "INV D", 900000)],
    };
    const twoFit = txFile([txGross(18000, 1100000, "20260212")], 18000);
    const r2 = reconcileParty(twoFit, facts2, matchOf(twoFit, facts2), "20260331");
    expect(r2.combinations).toHaveLength(0);
    expect(r2.ambiguous).toBeGreaterThanOrEqual(1);
    expect(r2.unmatchedBooks).toHaveLength(4);
  });
});

/** One books entry explained by at most ONE match: the two unmatched sheets
 * must net to the Deductors delta. Live case (Narayanan, Greater Chennai
 * Corporation, v5): one zone-4 journal of 24,256 sat in TWO rate-exact
 * combination matches (26AS 27,047 and 46,089), so the books side was
 * explained by it twice and the sheets missed the 26AS tax by that amount. */
describe("a books entry is explained by at most one match (combo reuse)", () => {
  // The three journals pre-date every invoice, so no entry anchors (the
  // rate-exact fallback's pool) and each 26AS row is rate-exact for one
  // invoice at 2%: 27,047 = 24,256 + 2,791 and 46,089 = 21,833 + 24,256.
  const sharedFacts: BooksFacts = {
    deductions: [
      { ledgerKey: NK, kind: "tds" as const, date: "20251007", tax: 24256, voucherType: "Journal" },
      { ledgerKey: NK, kind: "tds" as const, date: "20251112", tax: 2791, voucherType: "Journal" },
      { ledgerKey: NK, kind: "tds" as const, date: "20251007", tax: 21833, voucherType: "Journal" },
    ],
    sales: [saleOf("20251201", "INV 1", 1352350), saleOf("20251201", "INV 2", 2304450)],
  };
  const sharedFile = txFile(
    [txGross(27047, 1352350, "20260212"), txGross(46089, 2304450, "20260212")],
    27047 + 46089,
  );
  /** Per party: books-not-in-26AS minus 26AS-unmatched equals the Deductors
   * delta, up to one tolerance per accepted match (each accepted match ties
   * its two sides within AS26_TAX_TOLERANCE). */
  const sheetIdentity = (r: ReturnType<typeof reconcileParty>): { gap: number; slack: number } => {
    const net = round2ForTest(
      r.unmatchedBooks.reduce((s, i) => s + i.tax, 0) - r.unmatchedAs26.reduce((s, i) => s + i.tax, 0),
    );
    return {
      gap: round2ForTest(Math.abs(net - (r.booksTax - r.as26Tax))),
      slack: AS26_TAX_TOLERANCE * (r.paired.length + r.combinations.length),
    };
  };

  it("the later 26AS row that needs the consumed journal is left unmatched, not double-explained", () => {
    const r = reconcileParty(sharedFile, sharedFacts, matchOf(sharedFile, sharedFacts), "20260331");
    expect(r.combinations).toHaveLength(1);
    expect(r.combinations[0].target.tax).toBe(27047);
    expect(r.combinations[0].parts.map((p) => p.tax).sort((a, b) => a - b)).toEqual([2791, 24256]);
    // the second row and the journal only it could use both stay unmatched
    expect(r.unmatchedAs26.map((i) => i.tax)).toEqual([46089]);
    expect(r.unmatchedBooks.map((i) => i.tax)).toEqual([21833]);
    const { gap, slack } = sheetIdentity(r);
    expect(gap).toBeLessThanOrEqual(slack);
  });

  it("no books or 26AS entry is consumed by two matches of any kind", () => {
    const r = reconcileParty(sharedFile, sharedFacts, matchOf(sharedFile, sharedFacts), "20260331");
    const used = { books: new Map<number, number>(), as26: new Map<number, number>() };
    const dupes: string[] = [];
    const claim = (side: "books" | "as26", id: number | undefined): void => {
      if (id === undefined) return;
      const n = (used[side].get(id) ?? 0) + 1;
      used[side].set(id, n);
      if (n > 1) dupes.push(`${side}#${id}`);
    };
    for (const p of r.paired) { claim("books", p.books.dedIdx); claim("as26", p.as26.txIdx); }
    for (const c of r.combinations) {
      if (c.side === "as26") { claim("as26", c.target.txIdx); c.parts.forEach((p) => claim("books", p.dedIdx)); }
      else { claim("books", c.target.dedIdx); c.parts.forEach((p) => claim("as26", p.txIdx)); }
    }
    expect(dupes).toEqual([]);
  });

  it("every party's two sheets net to its delta, a rounding-accepted match included", () => {
    const SECOND = "anand buildmart pvt ltd";
    const secondName = "Anand Buildmart Pvt Ltd";
    const file: As26File = {
      summaries: [
        sum(27047 + 46089),
        { kind: "tds", name: secondName, nameKey: SECOND, section: "194C",
          taxTotal: 15041, taxClaimed: 0, balanceCf: 0, gross: 0 },
      ],
      transactions: [
        ...sharedFile.transactions,
        { kind: "tds", nameKey: SECOND, date: "20260212", amount: 15041, tax: 15041,
          status: "F", bookingDate: null, section: "194C" },
      ],
      skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
    };
    const f: BooksFacts = {
      deductions: [
        ...sharedFacts.deductions,
        { ledgerKey: SECOND, kind: "tds" as const, date: "20251007", tax: 1628, voucherType: "Journal" },
        { ledgerKey: SECOND, kind: "tds" as const, date: "20251007", tax: 13414, voucherType: "Journal" },
      ],
      sales: sharedFacts.sales,
    };
    const map = { mappings: [
      { ledger: nameOf, as26Name: nameOf },
      { ledger: secondName, as26Name: secondName },
    ] };
    const r = analyzeAs26(file, f, map, [nameOf, secondName],
      { fromDate: "20250401", toDate: "20260331" });
    expect(r.recon).toHaveLength(2);
    for (const p of r.recon) {
      const { gap, slack } = sheetIdentity(p);
      expect(gap).toBeLessThanOrEqual(slack);
    }
    // the second party's accepted match is off by one rupee: identity holds
    // within exactly one tolerance, never more
    const second = r.recon.find((p) => p.match.as26NameKey === SECOND)!;
    expect(second.combinations).toHaveLength(1);
    expect(sheetIdentity(second).slack).toBeCloseTo(AS26_TAX_TOLERANCE, 5);
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
