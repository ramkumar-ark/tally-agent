// Manual 26AS decisions (design §14): the operator channel on the mapping
// template — "Manual Matches" (pair entries the tool left unmatched by hand)
// and "Invoice Links" (pin an entry to a specific sales invoice by voucher
// number). Invented names only.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  analyzeAs26, AS26_TAX_TOLERANCE, MANUAL_LINK_SHEET, MANUAL_MATCH_SHEET,
  type As26Map, type BooksFacts, type ManualLinkInstruction, type ManualMatchInstruction,
} from "../src/as26.js";
import { buildBillRows } from "../src/as26-bill.js";
import { buildAs26MapTemplate, parseAs26MapTemplate } from "../src/as26-template.js";
import type { As26File } from "../src/as26-file.js";
import { canonicalKey } from "../src/key.js";
import { buildWorkbook } from "../src/xlsx.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { EMPTY_OVERRIDES } from "../src/overrides.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { createSession } from "../src/review.js";
import type { DayBookInput } from "../src/tds-daybook.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmpDir = (): string => { const d = mkdtempSync(join(tmpdir(), "as26-manual-")); dirs.push(d); return d; };

const ALPHA = canonicalKey("Alpha Traders");
const NAME = "Alpha Traders";
const OTHER = "Executive Engineer Alpha Division";
const opts = { fromDate: "20250401", toDate: "20260331" };

const file = (txs: Array<Partial<As26File["transactions"][number]>>, extraName?: string): As26File => ({
  summaries: [
    { kind: "tds", name: NAME, nameKey: ALPHA, section: "194C", taxTotal: 0, taxClaimed: 0, balanceCf: 0, gross: 0 },
    ...(extraName ? [{ kind: "tds" as const, name: extraName, nameKey: canonicalKey(extraName), section: "194C", taxTotal: 0, taxClaimed: 0, balanceCf: 0, gross: 0 }] : []),
  ],
  transactions: txs.map((t) => ({
    kind: "tds", nameKey: ALPHA, date: "20250420", amount: 100000, tax: 2000,
    status: "F", bookingDate: "20250420", section: "194C", ...t,
  })),
  skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
});

const baseMap: As26Map = { mappings: [{ ledger: NAME, as26Name: NAME }] };

/** Books: a 5000 journal the 26AS side splits as 3000 + 2000 — but a second
 *  3000 makes TWO subsets fit that target, so the automatic search honestly
 *  refuses and the entries stay on the unmatched sheets (the live case the
 *  operator channel exists for). The 9000 pairs automatically. No sales, so
 *  the invoice-anchored stages cannot rescue the split either. */
const splitFacts: BooksFacts = {
  deductions: [
    { ledgerKey: ALPHA, kind: "tds", date: "20250415", tax: 5000, voucherType: "Journal", voucherNumber: "JV/1", reference: null },
    { ledgerKey: ALPHA, kind: "tds", date: "20250715", tax: 9000, voucherType: "Journal", voucherNumber: "JV/2", reference: null },
  ],
  sales: [],
};
const splitFile = file([
  { date: "20250418", tax: 3000, amount: 250000, bookingDate: "20250418" },
  { date: "20250419", tax: 2000, amount: 250000, bookingDate: "20250419" },
  { date: "20250425", tax: 3000, amount: 250000, bookingDate: "20250425" },
  { date: "20250718", tax: 9000, amount: 400000, bookingDate: "20250718" },
]);

const matchIns = (o: Partial<ManualMatchInstruction> = {}): ManualMatchInstruction => ({
  kind: "tds", as26NameKey: ALPHA, as26Name: NAME, group: "g1", row: 2,
  books: [{ date: "20250415", tax: 5000, row: 2 }],
  as26: [{ date: "20250418", tax: 3000, row: 3 }, { date: "20250419", tax: 2000, row: 4 }],
  ...o,
});
const linkIns = (o: Partial<ManualLinkInstruction> = {}): ManualLinkInstruction => ({
  kind: "tds", as26NameKey: ALPHA, as26Name: NAME, side: "books",
  date: "20250901", tax: 12000, invoiceRef: "NC/20", row: 2, ...o,
});
/** Books journal 12000 the 26AS side does not carry, plus a 9000 row and one
 *  invoice whose 2% (11000) matches neither — so no automatic link exists. */
const linkFacts: BooksFacts = {
  deductions: [{ ledgerKey: ALPHA, kind: "tds", date: "20250901", tax: 12000, voucherType: "Journal", voucherNumber: "JV/7", reference: null }],
  sales: [{ ledgerKey: ALPHA, date: "20250801", ref: "NC/20", taxable: 550000, gross: 649000 }],
};
const linkFile = file([{ date: "20250810", tax: 9000, amount: 600000, bookingDate: "20250810" }]);

// ---------------------------------------------------------------- parse

const sheet = (name: string, columns: string[], rows: Array<Array<string | number | Date | null>>, formats?: string[]) => ({
  name, columns: columns.map((h, i) => ({ header: h, ...(formats?.[i] ? { format: formats[i] } : {}) })), rows,
});
const MAPPING = sheet("Mapping", ["26AS name", "kind", "26AS tax", "Tally ledger"],
  [[NAME, "tds", 5000, NAME]]);
const bufOf = (sheets: Array<ReturnType<typeof sheet>>): Buffer => buildWorkbook(sheets);
const MATCH_COLUMNS = ["26AS name", "kind", "group", "side", "date", "tax"];
const LINK_COLUMNS = ["26AS name", "kind", "side", "date", "tax", "invoice number"];

describe("parseAs26MapTemplate — the two instruction sheets", () => {
  it("groups rows by name, kind and the operator's group label into one instruction", () => {
    const buf = bufOf([MAPPING, sheet("Manual Matches", MATCH_COLUMNS, [
      [NAME, "tds", "g1", "books", "15-Apr-2025", 5000],
      [NAME, "tds", "g1", "26as", "18-Apr-2025", 3000],
      [NAME, "tds", "g1", "26as", "19-Apr-2025", 2000],
    ])]);
    const m = parseAs26MapTemplate(buf);
    expect(m.manualMatches).toEqual([matchIns()]);
    expect(m.manualLinks).toEqual([]);
  });

  it("a blank group label is a group of one (a 1:1 match)", () => {
    const buf = bufOf([MAPPING, sheet("Manual Matches", MATCH_COLUMNS, [
      [NAME, "tds", "", "books", "20250715", 9000],
      [NAME, "tds", "", "26as", "20250718", 9000],
    ])]);
    expect(parseAs26MapTemplate(buf).manualMatches).toEqual([
      matchIns({ group: "", books: [{ date: "20250715", tax: 9000, row: 2 }], as26: [{ date: "20250718", tax: 9000, row: 3 }] }),
    ]);
  });

  it("accepts an Excel date cell, a bare 20260116 and the report's own dd-Mon-yyyy", () => {
    const buf = bufOf([MAPPING, sheet("Manual Matches", MATCH_COLUMNS, [
      [NAME, "tds", "a", "books", "20260116", 100],
      [NAME, "tds", "a", "26as", "16-Jan-2026", 100],
      [NAME, "tds", "b", "books", "20260116", 200],
      [NAME, "tds", "b", "26as", "2026/01/16", 200],
    ], ["text", "text", "text", "text", "date", "money"])]);
    const rows = parseAs26MapTemplate(buf).manualMatches;
    expect(rows.map((r) => r.books[0].date)).toEqual(["20260116", "20260116"]);
    expect(rows.map((r) => r.as26[0].date)).toEqual(["20260116", "20260116"]);
  });

  it("a blank row is padding; a name that differs only in case joins the same instruction", () => {
    const buf = bufOf([MAPPING, sheet("Manual Matches", MATCH_COLUMNS, [
      [NAME, "tds", "g1", "books", "20250415", 5000],
      ["alpha traders", "TDS", "G1", "26as", "20250418", 3000],
      [null, null, null, null, null, null],
      [NAME, "tds", "g1", "26as", "20250419", 2000],
    ])]);
    expect(parseAs26MapTemplate(buf).manualMatches).toEqual([matchIns({
      as26: [{ date: "20250418", tax: 3000, row: 3 }, { date: "20250419", tax: 2000, row: 5 }],
    })]);
  });

  it("reads the Invoice Links sheet, one instruction per row", () => {
    const buf = bufOf([MAPPING, sheet("Invoice Links", LINK_COLUMNS, [
      [NAME, "tds", "books", "01-Sep-2025", 12000, "NC/20"],
    ])]);
    expect(parseAs26MapTemplate(buf).manualLinks).toEqual([linkIns()]);
  });

  it("a missing sheet is normal — no instruction", () => {
    const m = parseAs26MapTemplate(bufOf([MAPPING]));
    expect(m.manualMatches).toEqual([]);
    expect(m.manualLinks).toEqual([]);
  });

  it("round-trips through the generated template, pre-filled from the map in force", () => {
    const map: As26Map = { ...baseMap, manualMatches: [matchIns()], manualLinks: [linkIns()] };
    const buf = buildAs26MapTemplate({
      company: "Sample Company", deductors: [{ name: NAME, kind: "tds", tax: 5000 }], map, ledgers: [NAME],
    });
    expect(parseAs26MapTemplate(buf).manualMatches).toEqual([matchIns()]);
    expect(parseAs26MapTemplate(buf).manualLinks).toEqual([linkIns()]);
    // Both sheets are always written, so the operator can find them.
    const names = readWorkbook(buf).map((s) => s.name);
    expect(names).toContain(MANUAL_MATCH_SHEET);
    expect(names).toContain(MANUAL_LINK_SHEET);
  });

  it("refuses a bad side / kind / date / tax, citing row and column, never a value", () => {
    const bad = (rows: Array<Array<string | number | null>>) => bufOf([MAPPING, sheet("Manual Matches", MATCH_COLUMNS, rows)]);
    expect(() => parseAs26MapTemplate(bad([[NAME, "tds", "g", "middle", "15-Apr-2025", 10]])))
      .toThrow(/row 2, column D \(side\) on the Manual Matches sheet: expected books or 26as/);
    expect(() => parseAs26MapTemplate(bad([[NAME, "vat", "g", "books", "15-Apr-2025", 10]])))
      .toThrow(/column B \(kind\) on the Manual Matches sheet: expected tds or tcs/);
    expect(() => parseAs26MapTemplate(bad([[NAME, "tds", "g", "books", "sometime", 10]])))
      .toThrow(/row 2, column E \(date\) on the Manual Matches sheet: the date could not be read/);
    expect(() => parseAs26MapTemplate(bad([[NAME, "tds", "g", "books", "15-Apr-2025", "free"]])))
      .toThrow(/column F \(tax\) on the Manual Matches sheet: cell is not a number/);
    expect(() => parseAs26MapTemplate(bad([["", "tds", "g", "books", "15-Apr-2025", 10]])))
      .toThrow(/row 2 on the Manual Matches sheet: "26AS name" is blank/);
    expect(() => parseAs26MapTemplate(bad([[NAME, "tds", "g", "books", "15-Apr-2025", null]])))
      .toThrow(/row 2 on the Manual Matches sheet: every row needs a date and a tax/);
    expect(() => parseAs26MapTemplate(bufOf([MAPPING, sheet("Invoice Links", ["26AS name", "kind", "side", "date", "tax"], [])])))
      .toThrow(/the 'Invoice Links' sheet needs a "invoice number" header column/);
    expect(() => parseAs26MapTemplate(bufOf([MAPPING, sheet("Invoice Links", LINK_COLUMNS,
      [[NAME, "tds", "books", "01-Sep-2025", 12000, null]])])))
      .toThrow(/row 2 on the Invoice Links sheet: every row needs a date, a tax and an invoice number/);
  });
});

// ---------------------------------------------------------------- refusal

describe("analyzeAs26 — refusal", () => {
  it("refuses an instruction whose 26AS name is not a party of the review", () => {
    expect(() => analyzeAs26(splitFile, splitFacts,
      { ...baseMap, manualMatches: [matchIns({ as26NameKey: canonicalKey("Ghost Ltd"), as26Name: "Ghost Ltd" })] },
      [NAME], opts))
      .toThrow(/row 2 on the Manual Matches sheet: its 26AS name is not a party of this review/);
  });

  it("refuses an instruction on a shared-ledger party (totals only, no entries)", () => {
    const shared: As26Map = { mappings: [
      { ledger: NAME, as26Name: NAME },
      { ledger: NAME, as26Name: OTHER },
    ]};
    const f = file([{ date: "20250418", tax: 3000 }, { date: "20250419", tax: 2000 }], OTHER);
    expect(() => analyzeAs26(f, { deductions: splitFacts.deductions.slice(0, 1), sales: [] }, { ...shared, manualLinks: [linkIns()] }, [NAME], opts))
      .toThrow(/row 2 on the Invoice Links sheet: its 26AS name shares a Tally ledger with another name/);
  });

  it("refuses a match whose date+tax names no unmatched entry", () => {
    expect(() => analyzeAs26(splitFile, splitFacts,
      { ...baseMap, manualMatches: [matchIns({ books: [{ date: "20250101", tax: 5000, row: 2 }] })] }, [NAME], opts))
      .toThrow(/row 2 on the Manual Matches sheet: its books entry matches no unmatched entry of that party/);
  });

  it("refuses a match whose date+tax names more than one entry", () => {
    const facts: BooksFacts = {
      deductions: [
        { ledgerKey: ALPHA, kind: "tds", date: "20250415", tax: 5000, voucherType: "Journal", voucherNumber: "JV/1", reference: null },
        { ledgerKey: ALPHA, kind: "tds", date: "20250415", tax: 5000, voucherType: "Journal", voucherNumber: "JV/9", reference: null },
      ],
      sales: [],
    };
    const f = file([{ date: "20250418", tax: 3000 }, { date: "20250419", tax: 2000 }]);
    expect(() => analyzeAs26(f, facts, { ...baseMap, manualMatches: [matchIns()] }, [NAME], opts))
      .toThrow(/row 2 on the Manual Matches sheet: its books entry matches 2 unmatched entries of that party/);
  });

  it("refuses an entry the automatic 1:1 stage already paired — manual never fights an automatic pair", () => {
    const facts: BooksFacts = { deductions: [splitFacts.deductions[1]], sales: [] };
    const f = file([{ date: "20250718", tax: 9000, amount: 400000 }]);
    expect(analyzeAs26(f, facts, baseMap, [NAME], opts).recon[0].paired).toHaveLength(1);
    expect(() => analyzeAs26(f, facts, { ...baseMap, manualMatches: [matchIns()] }, [NAME], opts))
      .toThrow(/an entry the review already paired automatically is not available/);
  });

  it("refuses a group that does not balance, citing the drift", () => {
    expect(() => analyzeAs26(splitFile, splitFacts,
      { ...baseMap, manualMatches: [matchIns({ as26: [{ date: "20250418", tax: 3000, row: 3 }] })] }, [NAME], opts))
      .toThrow(/row 2 on the Manual Matches sheet: its group does not balance: the books rows and the 26AS rows differ by 2000\.00/);
  });

  it("refuses a group with more than one row on both sides, and one missing a side", () => {
    expect(() => analyzeAs26(splitFile, splitFacts, { ...baseMap, manualMatches: [matchIns({
      books: [{ date: "20250415", tax: 5000, row: 2 }, { date: "20250715", tax: 9000, row: 5 }],
      as26: [{ date: "20250418", tax: 3000, row: 3 }, { date: "20250419", tax: 2000, row: 4 }],
    })] }, [NAME], opts))
      .toThrow(/row 2 on the Manual Matches sheet: its group has more than one row on both sides/);
    expect(() => analyzeAs26(splitFile, splitFacts, { ...baseMap, manualMatches: [matchIns({ as26: [] })] }, [NAME], opts))
      .toThrow(/row 2 on the Manual Matches sheet: its group needs at least one row on each side/);
  });

  it("refuses a link naming an unknown entry, a duplicate link, and an invoice number that is not on the party's ledgers", () => {
    const f = linkFile;
    const facts = linkFacts;
    expect(() => analyzeAs26(f, facts, { ...baseMap, manualLinks: [linkIns({ date: "20250101" })] }, [NAME], opts))
      .toThrow(/row 2 on the Invoice Links sheet: its books entry matches no entry of that party/);
    expect(() => analyzeAs26(f, facts, { ...baseMap, manualLinks: [linkIns(), linkIns({ row: 3 })] }, [NAME], opts))
      .toThrow(/row 3 on the Invoice Links sheet: another link on the sheet already names the same books entry/);
    expect(() => analyzeAs26(f, facts, { ...baseMap, manualLinks: [linkIns({ invoiceRef: "NC/99" })] }, [NAME], opts))
      .toThrow(/row 2 on the Invoice Links sheet: its invoice number matches no sales invoice on that party's ledgers/);
  });

  it("a link resolves within the party's own ledgers, never across a party that shares the invoice number", () => {
    const facts: BooksFacts = {
      ...linkFacts,
      sales: [
        { ledgerKey: ALPHA, date: "20250801", ref: "NC/20", taxable: 550000, gross: 649000 },
        { ledgerKey: canonicalKey("Beta Ltd"), date: "20250801", ref: "NC/20", taxable: 999, gross: 999 },
      ],
    };
    const res = analyzeAs26(linkFile, facts, { ...baseMap, manualLinks: [linkIns()] }, [NAME], opts);
    expect(res.recon[0].manualLinks).toEqual([
      { side: "books", date: "20250901", tax: 12000, linked: { date: "20250801", ref: "NC/20", taxable: 550000 } },
    ]);
  });
});

// ---------------------------------------------------------------- matching effect

describe("a manual match moves the entries off both unmatched sheets", () => {
  it("the matched entries leave the pools and appear as a manual combination", () => {
    const before = analyzeAs26(splitFile, splitFacts, baseMap, [NAME], opts).recon[0];
    // Two subsets fit the 5000 target, so the automatic search declines and
    // the entries stay on the two unmatched sheets.
    expect(before.combinations).toHaveLength(0);
    expect(before.ambiguous).toBeGreaterThan(0);
    expect(before.unmatchedBooks.map((i) => i.tax)).toEqual([5000]);
    expect(before.unmatchedAs26.map((i) => i.tax)).toEqual([3000, 2000, 3000]);

    const after = analyzeAs26(splitFile, splitFacts, { ...baseMap, manualMatches: [matchIns()] }, [NAME], opts).recon[0];
    expect(after.unmatchedBooks).toHaveLength(0);
    expect(after.unmatchedAs26.map((i) => i.tax)).toEqual([3000]);
    const manual = after.combinations.filter((c) => c.basis === "manual");
    expect(manual).toHaveLength(1);
    // one books row against two 26AS rows -> the single row is the target
    expect(manual[0].side).toBe("books");
    expect(manual[0].target.tax).toBe(5000);
    expect(manual[0].parts.map((p) => p.tax)).toEqual([3000, 2000]);
  });

  it("an N:1 match records the single 26AS row as the target", () => {
    const facts: BooksFacts = {
      deductions: [
        { ledgerKey: ALPHA, kind: "tds", date: "20250410", tax: 3000, voucherType: "Journal", voucherNumber: "JV/3", reference: null },
        { ledgerKey: ALPHA, kind: "tds", date: "20250420", tax: 2000, voucherType: "Journal", voucherNumber: "JV/4", reference: null },
        { ledgerKey: ALPHA, kind: "tds", date: "20250430", tax: 3000, voucherType: "Journal", voucherNumber: "JV/5", reference: null },
      ],
      sales: [],
    };
    const f = file([{ date: "20250425", tax: 5000, amount: 250000, bookingDate: "20250425" }]);
    const ins = matchIns({
      row: 6, group: "g2",
      books: [{ date: "20250410", tax: 3000, row: 6 }, { date: "20250420", tax: 2000, row: 7 }],
      as26: [{ date: "20250425", tax: 5000, row: 8 }],
    });
    const r = analyzeAs26(f, facts, { ...baseMap, manualMatches: [ins] }, [NAME], opts).recon[0];
    const manual = r.combinations.filter((c) => c.basis === "manual");
    expect(manual).toHaveLength(1);
    expect(manual[0].side).toBe("as26");
    expect(manual[0].target.tax).toBe(5000);
    expect(manual[0].parts.map((p) => p.tax)).toEqual([3000, 2000]);
    expect(r.unmatchedBooks.map((i) => i.tax)).toEqual([3000]);
    expect(r.unmatchedAs26).toHaveLength(0);
  });

  it("per-party totals and the Deductors figures do not move", () => {
    const before = analyzeAs26(splitFile, splitFacts, baseMap, [NAME], opts);
    const after = analyzeAs26(splitFile, splitFacts, { ...baseMap, manualMatches: [matchIns()] }, [NAME], opts);
    expect(after.recon[0].booksTax).toBe(before.recon[0].booksTax);
    expect(after.recon[0].as26Tax).toBe(before.recon[0].as26Tax);
    // Only the explanation moves: the tax the review compares is identical,
    // and what the manual match resolves is exactly what was ambiguous.
    expect(after.totals.booksTax).toBe(before.totals.booksTax);
    expect(after.totals.as26Tax).toBe(before.totals.as26Tax);
    expect(after.totals.partiesMatched).toBe(before.totals.partiesMatched);
    expect(after.totals.combinationExplained).toBe(before.totals.combinationExplained + 1);
    expect(after.totals.ambiguous).toBe(before.totals.ambiguous - 1);
  });

  it("the identity holds: unmatched books − unmatched 26AS equals the books−26AS delta", () => {
    const maps: As26Map[] = [
      baseMap,
      { ...baseMap, manualMatches: [matchIns()] },
    ];
    for (const map of maps) {
      const res = analyzeAs26(splitFile, splitFacts, map, [NAME], opts);
      for (const r of res.recon) {
        const bk = r.unmatchedBooks.reduce((s, i) => s + i.tax, 0);
        const a26 = r.unmatchedAs26.reduce((s, i) => s + i.tax, 0);
        expect(Math.abs((bk - a26) - (r.booksTax - r.as26Tax))).toBeLessThanOrEqual(AS26_TAX_TOLERANCE);
      }
    }
  });

  it("the manual entries are re-emitted as explained rows, not shown on the unmatched sheets", () => {
    const res = analyzeAs26(splitFile, splitFacts, { ...baseMap, manualMatches: [matchIns()] }, [NAME], opts);
    const rows = buildBillRows(res, splitFacts, splitFile, opts);
    // the two matched rows and the third (genuinely unmatched) 3000 only
    expect(rows.filter((r) => !r.explained).map((r) => [r.kind, r.tax])).toEqual([["as26", 3000]]);
    expect(rows.filter((r) => r.explained).map((r) => r.kind).sort()).toEqual(["as26", "as26", "booksded"]);
    // the paired 9000 never appeared on either unmatched sheet
    expect(rows.filter((r) => r.tax === 9000)).toHaveLength(0);
  });

  it("one entry is never consumed twice: a second instruction naming it is refused", () => {
    expect(() => analyzeAs26(splitFile, splitFacts, { ...baseMap, manualMatches: [
      matchIns(),
      matchIns({ group: "g2", row: 6, books: [{ date: "20250415", tax: 5000, row: 6 }], as26: [{ date: "20250425", tax: 3000, row: 7 }] }),
    ] }, [NAME], opts))
      .toThrow(/row 6 on the Manual Matches sheet: its books entry matches no unmatched entry of that party/);
  });

  it("manual takes precedence over the automatic combination search instead of competing with it", () => {
    const facts: BooksFacts = { deductions: splitFacts.deductions.slice(0, 1), sales: [] };
    // With the duplicate 3000 gone, 3000 + 2000 fits the 5000 target uniquely,
    // so the automatic subset search WOULD explain it on its own; the
    // operator's declaration is the one recorded, and nothing is consumed
    // twice.
    const f = file(splitFile.transactions.slice(0, 2));
    const auto = analyzeAs26(f, facts, baseMap, [NAME], opts).recon[0];
    expect(auto.combinations).toHaveLength(1);
    expect(auto.combinations[0].basis).toBeUndefined(); // the automatic shape, no basis
    const manual = analyzeAs26(f, facts, { ...baseMap, manualMatches: [matchIns()] }, [NAME], opts).recon[0];
    expect(manual.combinations).toHaveLength(1);
    expect(manual.combinations[0].basis).toBe("manual");
    const idx = manual.combinations.flatMap((c) => [c.target, ...c.parts]).map((i) => `${i.dedIdx ?? ""}|${i.txIdx ?? ""}`);
    expect(new Set(idx).size).toBe(idx.length);
  });
});

// ---------------------------------------------------------------- linking effect

describe("a manual link pins an entry to a named invoice", () => {
  const facts = linkFacts;
  const f = linkFile;

  it("fills the linked-invoice columns with basis manual where the tool found nothing", () => {
    const plain = buildBillRows(analyzeAs26(f, facts, baseMap, [NAME], opts), facts, f, opts)
      .find((r) => r.kind === "booksded")!;
    expect(plain.linkBasis).not.toBe("manual");
    expect(plain.linked?.ref).not.toBe("NC/20");

    const res = analyzeAs26(f, facts, { ...baseMap, manualLinks: [linkIns()] }, [NAME], opts);
    expect(res.recon[0].manualLinks).toEqual([
      { side: "books", date: "20250901", tax: 12000, linked: { date: "20250801", ref: "NC/20", taxable: 550000 } },
    ]);
    const row = buildBillRows(res, facts, f, opts).find((r) => r.kind === "booksded")!;
    expect(row.linkBasis).toBe("manual");
    expect(row.linked?.ref).toBe("NC/20");
    expect(row.linked?.taxable).toBe(550000);
    expect(row.linked?.date).toBe("20250801");
  });

  it("a manual link can name an entry the review paired automatically", () => {
    const paired: BooksFacts = {
      ...linkFacts,
      deductions: [{ ledgerKey: ALPHA, kind: "tds", date: "20250901", tax: 9000, voucherType: "Journal", voucherNumber: "JV/7", reference: null }],
    };
    const pf = file([{ date: "20250901", tax: 9000, amount: 600000 }]);
    expect(analyzeAs26(pf, paired, baseMap, [NAME], opts).recon[0].paired).toHaveLength(1);
    const res = analyzeAs26(pf, paired, { ...baseMap, manualLinks: [linkIns({ tax: 9000 })] }, [NAME], opts);
    expect(res.recon[0].manualLinks).toHaveLength(1);
  });

  it("a manual link on the 26AS side enables the bill-value comparison the tool could not make", () => {
    expect(buildBillRows(analyzeAs26(f, facts, baseMap, [NAME], opts), facts, f, opts)
      .filter((r) => r.kind === "value")).toHaveLength(0);
    const res = analyzeAs26(f, facts, { ...baseMap, manualLinks: [linkIns({ side: "as26", date: "20250810", tax: 9000 })] }, [NAME], opts);
    const v = buildBillRows(res, facts, f, opts).filter((r) => r.kind === "value");
    expect(v).toHaveLength(1);
    expect(v[0].linkBasis).toBe("manual");
    expect(v[0].linked?.ref).toBe("NC/20");
    expect(v[0].delta).toBe(50000);
  });

  it("a manual link leaves the totals and the matching decisions untouched", () => {
    const plain = analyzeAs26(linkFile, linkFacts, baseMap, [NAME], opts);
    const linked = analyzeAs26(linkFile, linkFacts, { ...baseMap, manualLinks: [linkIns()] }, [NAME], opts);
    expect(linked.totals).toEqual(plain.totals);
    expect(linked.recon[0].unmatchedBooks.map((i) => i.tax)).toEqual(plain.recon[0].unmatchedBooks.map((i) => i.tax));
    expect(linked.recon[0].combinations).toEqual(plain.recon[0].combinations);
  });
});

// ---------------------------------------------------------------- end to end

describe("Session.as26Review — instructions through the template channel", () => {
  const dayBookGroups = [
    { name: "Current Assets", parent: "" },
    { name: "Loans & Advances (Asset)", parent: "Current Assets" },
    { name: "Sundry Debtors", parent: "Current Assets" },
    { name: "Sales Accounts", parent: "" },
    { name: "Works Contract Service", parent: "Sales Accounts" },
  ];
  const dayBookLedgers = [
    { name: "TDS Receivable", parent: "Loans & Advances (Asset)" },
    { name: NAME, parent: "Sundry Debtors" },
    { name: "Works Contract Service", parent: "Sales Accounts" },
  ];
  const vouchers: DayBookInput["vouchers"] = [
    {
      date: "20250410", voucherType: "Sales", voucherNumber: "NC/20", partyLedgerName: NAME,
      cancelled: false,
      entries: [
        { ledger: NAME, amount: 550000 },
        { ledger: "Works Contract Service", amount: -550000 },
      ],
    },
    {
      date: "20250415", voucherType: "Journal", voucherNumber: "JV/1", partyLedgerName: NAME,
      cancelled: false,
      entries: [
        { ledger: "TDS Receivable", amount: 5000 },
        { ledger: NAME, amount: -5000 },
      ],
    },
  ];
  const dayBook: DayBookInput = {
    shape: "bundle", company: "Demo Traders Pvt Ltd",
    groups: dayBookGroups, ledgers: dayBookLedgers, vouchers,
    observedFrom: "20250401", observedTo: "20250430", rejected: 0, emptyMonths: [],
  };
  const fake = () => ({
    groups: async () => { throw new Error("not used"); },
    ledgersTax: async () => { throw new Error("not used"); },
    ledgerVoucherRows: async () => { throw new Error("not used"); },
    vouchers: async () => { throw new Error("not used"); },
    callRaw: async () => { throw new Error("not used"); },
    listCompanies: async () => ["Demo Traders Pvt Ltd"],
    trialBalance: async () => { throw new Error("not used"); },
    ledgers: async () => [] as never,
    ledgerVouchers: async () => [] as never,
    close: async () => {},
  } as never);
  const exportFile = (): As26File => file([
    { date: "20250418", tax: 3000, amount: 550000, bookingDate: "20250418" },
    { date: "20250419", tax: 2000, amount: 550000, bookingDate: "20250419" },
  ]);
  const mapTemplate = (map: As26Map): string => {
    const p = join(tmpDir(), "as26-map-template.xlsx");
    writeFileSync(p, buildAs26MapTemplate({
      company: "Demo Traders Pvt Ltd",
      deductors: [{ name: NAME, kind: "tds", tax: 5000 }],
      map, ledgers: [NAME],
    }));
    return p;
  };

  it("applies a manual match and a manual link declared on the template", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const res = await s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", exportFile(), mapTemplate({
      ...baseMap,
      manualMatches: [matchIns()],
      manualLinks: [linkIns({ date: "20250415", tax: 5000, invoiceRef: "NC/20" })],
    }), dayBook);
    expect(res.recon[0].combinations.filter((c) => c.basis === "manual")).toHaveLength(1);
    expect(res.recon[0].unmatchedBooks).toHaveLength(0);
    expect(res.recon[0].unmatchedAs26).toHaveLength(0);
    const row = res.billRows.find((r) => r.sheetId === "booksded")!;
    expect(row.linkBasis).toBe("manual");
    expect(row.linked?.ref).toMatch(/^Doc \d+$/); // masked on the way out
    expect(row.linked?.date).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{4}$/);
    expect(JSON.stringify(res)).not.toContain("NC/20");
    expect(JSON.stringify(res)).not.toContain("Alpha Traders");
  });

  it("a stale instruction refuses the run, citing the sheet and row", async () => {
    const s = createSession(fake(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    await expect(s.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", exportFile(), mapTemplate({
      ...baseMap, manualLinks: [linkIns({ date: "20250101" })],
    }), dayBook)).rejects.toThrow(/row 2 on the Invoice Links sheet: its books entry matches no entry of that party/);
  });
});
