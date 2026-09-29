import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { parseAs26Export } from "../src/as26-file.js";
import { buildAs26Fixture } from "./as26-fixture.js";
import { readWorkbook, type GridSheet } from "../src/xlsx-read.js";
import { writeAs26Report, as26Markdown } from "../src/report.js";
import { createVault } from "../src/vault.js";
import type { As26ReviewResult } from "../src/review.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import type { Downstream } from "../src/downstream.js";

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d;
};
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

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
const vouchers = [
  {
    date: "20250605", voucherType: "Sales", voucherNumber: "CS/9", partyLedgerName: "Anand Buildmart Pvt Ltd",
    cancelled: false,
    entries: [
      { ledger: "Anand Buildmart Pvt Ltd", amount: 230000 },
      { ledger: "Works Contract Service", amount: -230000 },
    ],
  },
];
const receivableRows = [
  { date: "20250612", voucherType: "Journal", voucherNumber: "JV/1", reference: "", counterparty: "Anand Buildmart Pvt Ltd", amount: 115000, matchStatus: "matched", tax: null },
];

const fakeDown = (): Downstream =>
  ({
    groups: async () => groups,
    ledgersTax: async () => masters as never,
    ledgerVoucherRows: async (_c: unknown, ledger: string, from: string, to: string) => ({
      rows: ledger === "TDS Receivable"
        ? receivableRows.filter((r) => r.date >= from && r.date <= to)
        : [],
      dropped: 0,
    }),
    vouchers: async () => vouchers as never,
    callRaw: async () => { throw new Error("not used"); },
    listCompanies: async () => ["Demo Traders Pvt Ltd"],
    trialBalance: async () => { throw new Error("not used"); },
    ledgers: async () => [] as never,
    ledgerVouchers: async () => [] as never,
    close: async () => {},
  }) as never;

/** The demo books as an operator day-book file: the sale voucher and one
 *  receivable debit. Entry amounts carry the export's Tally sign (credit
 *  positive) — the reader negates them into the gateway's positive = debit. */
const writeDayBook = (): string => {
  const p = join(tempDir("as26-daybook-"), "daybook.json");
  writeFileSync(
    p,
    JSON.stringify({
      company: "Demo Traders Pvt Ltd",
      groups,
      ledgers: [
        { name: "TDS Receivable", parent: "Current Assets" },
        { name: "Anand Buildmart Pvt Ltd", parent: "Sundry Debtors" },
        { name: "Works Contract Service", parent: "Sales Accounts" },
      ],
      vouchers: [
        // in-memory vouchers carry gateway amounts (positive = debit); the
        // export's rows are Tally-signed and keyed LEDGERNAME/AMOUNT
        ...vouchers.map((v) => ({
          ...v,
          entries: v.entries.map((e) => ({ LEDGERNAME: e.ledger, AMOUNT: -e.amount })),
        })),
        {
          date: "20250612", voucherType: "Journal", voucherNumber: "JV/1",
          partyLedgerName: "Anand Buildmart Pvt Ltd", isCancelled: false,
          entries: [
            { LEDGERNAME: "TDS Receivable", AMOUNT: -115000 },
            { LEDGERNAME: "Anand Buildmart Pvt Ltd", AMOUNT: 115000 },
          ],
        },
      ],
    }),
    "utf8",
  );
  return p;
};

function harness() {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _desc, _schema, handler) => {
    tools.set(name, handler);
  };
  const session = createSession(fakeDown(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
  const reportDir = tempDir("as26-report-");
  registerTools(registrar, session, { reportDir, dayBookMaxBytes: 64 * 1_048_576 }, "20260331T100000Z");
  return { tools, session, reportDir };
}

describe("tb_26as_review tool", () => {
  it("errors when as26Path is missing, before touching downstream", async () => {
    const { tools } = harness();
    await expect(
      tools.get("tb_26as_review")!({ fromDate: "20250401", toDate: "20260331" }),
    ).rejects.toThrow(/as26Path|required|Argument/i);
  });

  it("reads the export inside the gateway, audits the path only, returns masked JSON", async () => {
    const { tools, reportDir } = harness();
    const as26Path = join(tempDir("as26-input-"), "export.xlsm");
    writeFileSync(as26Path, buildAs26Fixture());
    const out = await tools.get("tb_26as_review")!({
      fromDate: "20250401", toDate: "20260331", as26Path, company: "Demo Traders Pvt Ltd",
      dayBookPath: writeDayBook(),
    });
    const res = JSON.parse(out);
    expect(res.findings.length).toBeGreaterThanOrEqual(0);
    expect(out).not.toContain("Anand Buildmart");
    const auditText = readFileSync(join(reportDir, "session-20260331T100000Z.jsonl"), "utf8").trim();
    const audit = JSON.parse(auditText.split("\n").pop()!);
    expect(audit.tool).toBe("tb_26as_review");
    expect(audit.args.as26Path).toBe(as26Path);
    expect(JSON.stringify(audit)).not.toContain("Nagar Palika");
  });

  it("a ledger mapped to two 26AS names reconciles as one masked shared party", async () => {
    const { tools } = harness();
    const as26Path = join(tempDir("as26-shared-"), "export.xlsm");
    writeFileSync(as26Path, buildAs26Fixture());
    const mapPath = join(tempDir("as26-sharedmap-"), "as26-map.json");
    writeFileSync(mapPath, JSON.stringify({ mappings: [
      { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" },
      { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Nagar Palika Nagar Bhavan" },
    ]}));
    const out = await tools.get("tb_26as_review")!({
      fromDate: "20250401", toDate: "20260331", as26Path, as26MapPath: mapPath, company: "Demo Traders Pvt Ltd",
      dayBookPath: writeDayBook(),
    });
    // One party, not two — and no real name or ledger escapes through the
    // shared group's members, which the engine keeps raw.
    expect(out).not.toContain("Anand Buildmart");
    expect(out).not.toContain("Nagar Palika");
    const res = JSON.parse(out);
    const shared = res.recon.filter((r: { match: { shared?: boolean } }) => r.match.shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].match.members).toHaveLength(2);
    expect(shared[0].as26Tax).toBe(18600.15);   // 26AS detail rows of both names
    expect(shared[0].booksTax).toBe(115000);
    // the finding names both members by pseudonym, never by value
    const f = res.findings.find((x: { check: string }) => x.check === "as26_totals_mismatch");
    expect(f.party).not.toContain("Nagar");
    expect(f.detail).toMatch(/Debtor \d/);
  });
});

describe("tb_write_26as_report", () => {
  it("errors before a review ran", async () => {
    const { tools } = harness();
    await expect(
      tools.get("tb_write_26as_report")!({ company: "x", fromDate: "20250401", toDate: "20260331", markdown: "m" }),
    ).rejects.toThrow(/tb_26as_review first/);
  });

  it("writes de-masked md + workbook whose Deductors sheet carries real names", async () => {
    const { tools, session, reportDir } = harness();
    const as26Path = join(tempDir("as26-input2-"), "export.xlsm");
    writeFileSync(as26Path, buildAs26Fixture());
    const mapPath = join(tempDir("as26-map2-"), "as26-map.json");
    writeFileSync(mapPath, JSON.stringify({ mappings: [
      { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" },
    ]}));
    await tools.get("tb_26as_review")!({
      fromDate: "20250401", toDate: "20260331", as26Path, as26MapPath: mapPath, company: "Demo Traders Pvt Ltd",
      dayBookPath: writeDayBook(),
    });
    const out = await tools.get("tb_write_26as_report")!({
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: "Deductor Anand Buildmart Pvt Ltd shows books tax.",
    });
    const paths = JSON.parse(out);
    const md = readFileSync(paths.markdownPath, "utf8");
    expect(md).toContain("Anand Buildmart Pvt Ltd");
    const wb = readWorkbook(readFileSync(paths.workbookPath));
    const names = wb.map((s) => s.name);
    expect(names).toEqual([
      "Findings", "Deductors", "Books Events", "Mapping",
      "Books not in 26AS", "26AS unmatched", "Bill value mismatch", "Combination matches", "FD interest 20% TDS", "FD ledger auto-assign",
    ]);
    const deductors = wb.find((s) => s.name === "Deductors")!;
    const cells = [...deductors.rows.values()].flatMap((r) => [...r.cells.values()].map((c) => String(c.value)));
    const joined = cells.join("|");
    expect(joined).toContain("Anand Buildmart");
    // the Books Events sheet carries the de-masked evidence rows
    const events = wb.find((s) => s.name === "Books Events")!;
    const eventCells = [...events.rows.values()].flatMap((r) => [...r.cells.values()].map((c) => String(c.value))).join("|");
    expect(eventCells).toContain("12-Jun-2025");
    expect(eventCells).toContain("CS/9");
    void session;
  });

  it("names every row by its own side: the 26AS deductor on 26AS rows, the booked ledger on books rows", async () => {
    const { tools } = harness();
    const as26Path = join(tempDir("as26-labels-"), "export.xlsm");
    writeFileSync(as26Path, buildAs26Fixture());
    const mapPath = join(tempDir("as26-labelsmap-"), "as26-map.json");
    // the books ledger and its 26AS deductor name DIFFER, so the two labels
    // are distinguishable cell by cell
    writeFileSync(mapPath, JSON.stringify({ mappings: [
      { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Nagar Palika Nagar Bhavan" },
    ]}));
    const reviewOut = await tools.get("tb_26as_review")!({
      fromDate: "20250401", toDate: "20260331", as26Path, as26MapPath: mapPath, company: "Demo Traders Pvt Ltd",
      dayBookPath: writeDayBook(),
    });
    // the tool result is masked on both channels
    expect(reviewOut).not.toContain("Anand Buildmart");
    expect(reviewOut).not.toContain("Nagar Palika");
    const out = await tools.get("tb_write_26as_report")!({
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: "narrative",
    });
    const paths = JSON.parse(out);
    const wb = readWorkbook(readFileSync(paths.workbookPath));
    const sheet = (name: string) => wb.find((s) => s.name === name)!;
    const partyCells = (name: string, col: number): string[] =>
      // the first row of every sheet is its header row
      [...sheet(name).rows.values()].slice(1).map((r) => String(r.cells.get(col)?.value ?? ""));

    // Deductors is the party-level sheet: it names the 26AS deductor.
    expect(partyCells("Deductors", 0)).toContain("Nagar Palika Nagar Bhavan");
    // Books entries are named by the ledger they are booked on ...
    expect(partyCells("Books not in 26AS", 2)).toContain("Anand Buildmart Pvt Ltd");
    expect(partyCells("Books Events", 0)).toContain("Anand Buildmart Pvt Ltd");
    // ... 26AS entries by the 26AS deductor (the 26AS unmatched and value
    // sheets are 26AS-side rows, so the deductor name is what identifies them)
    expect(partyCells("26AS unmatched", 2)).toContain("Nagar Palika Nagar Bhavan");
    for (const r of partyCells("Bill value mismatch", 1)) {
      expect(r).toBe("Nagar Palika Nagar Bhavan");
    }
    // a combination is named by its TARGET's side (books target = its ledger,
    // 26AS target = the deductor) — either way, never a joined list
    for (const r of [...partyCells("Combination matches", 2), ...partyCells("FD interest 20% TDS", 1)]) {
      if (!r) continue; // the FD sheet's trailing total row
      expect(["Anand Buildmart Pvt Ltd", "Nagar Palika Nagar Bhavan"]).toContain(r);
    }
    // the findings follow their own side too
    const BOOKS_SIDE = new Set(["books_tax_not_in_26as", "deduction_without_sale", "fd_20pct_tds"]);
    const AS26_SIDE = new Set([
      "as26_tax_not_in_books", "assessable_value_mismatch", "unresolved_combination",
      "late_booking", "as26_totals_mismatch",
    ]);
    const findingsRows = [...sheet("Findings").rows.values()]
      .map((r) => ({ check: String(r.cells.get(1)?.value ?? ""), party: String(r.cells.get(3)?.value ?? ""), detail: String(r.cells.get(7)?.value ?? "") }))
      .filter((r) => BOOKS_SIDE.has(r.check) || AS26_SIDE.has(r.check));
    expect(findingsRows.filter((r) => BOOKS_SIDE.has(r.check)).length).toBeGreaterThan(0);
    expect(findingsRows.filter((r) => AS26_SIDE.has(r.check)).length).toBeGreaterThan(0);
    for (const r of findingsRows) {
      expect(r.party, r.check).toBe(BOOKS_SIDE.has(r.check) ? "Anand Buildmart Pvt Ltd" : "Nagar Palika Nagar Bhavan");
    }
    // no party cell anywhere joins names with " + "
    for (const [name, col] of [
      ["Findings", 3], ["Books Events", 0], ["Books not in 26AS", 2],
      ["26AS unmatched", 2], ["Bill value mismatch", 1], ["Combination matches", 2],
      ["FD interest 20% TDS", 1],
    ] as const) {
      for (const r of partyCells(name, col)) expect(r, name).not.toContain(" + ");
    }
    // the cross-sheet party key: one id per party, the SAME on both unmatched
    // sheets and on the party's Deductors row (captain 2026-09-29)
    const bookIds = partyCells("Books not in 26AS", 1).filter(Boolean);
    const as26Ids = partyCells("26AS unmatched", 1).filter(Boolean);
    expect(bookIds.length).toBeGreaterThan(0);
    expect(as26Ids.length).toBeGreaterThan(0);
    for (const id of new Set(bookIds)) expect(as26Ids).toContain(id);
    for (const id of new Set([...bookIds, ...as26Ids])) {
      expect(id).toMatch(/^P\d+$/);
      expect(partyCells("Deductors", 1)).toContain(id);
    }
    // the row-id pointers still join: a books row is cited under the ledger
    // label, a 26AS row under the deductor label
    const rowParties = new Map<string, string>();
    for (const [name, col] of [
      ["Books not in 26AS", 2], ["26AS unmatched", 2], ["Bill value mismatch", 1],
    ] as const) {
      for (const r of sheet(name).rows.values()) {
        const id = r.cells.get(0)?.value;
        if (typeof id === "string" && id) rowParties.set(id, String(r.cells.get(col)?.value ?? ""));
      }
    }
    let pointers = 0;
    for (const r of findingsRows) {
      for (const m of r.detail.matchAll(/\b([BDV]\d+)\b/g)) {
        pointers += 1;
        expect(rowParties.get(m[1]), `${r.party} → ${m[1]}`).toBe(m[1].startsWith("B")
          ? "Anand Buildmart Pvt Ltd"
          : "Nagar Palika Nagar Bhavan");
      }
    }
    expect(pointers).toBeGreaterThan(0);
  });

  it("writes the three bill-level sheets with row ids, numeric tolerance and window text", async () => {
    const reportDir = tempDir("as26-billsheets-");
    const result: As26ReviewResult = {
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      findings: [],
      recon: [],
      gaps: [],
      totals: { booksTax: 0, as26Tax: 0, partiesMatched: 0, combinationExplained: 0, ambiguous: 0 },
      mastersUnavailable: false,
      groupsUnavailable: false,
      skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
      counts: { credits: 0, receivableLedgers: [] },
      bookEvents: [],
      billRows: [
        {
          sheetId: "booksded", partyId: "P1", party: "Pseudonym One", date: "10-Jun-2025", tax: 4600.15,
          gross: null, voucherType: "Journal", ref: "Doc 1", status: null, section: null,
          inWindow: true, linkBasis: "reference",
          linked: { date: "09-Sep-2025", ref: "Doc 2", taxable: 230000 }, delta: null,
          windowState: "in",
        },
        {
          // no party id: the defensive blank case (a hand-built row that
          // carries no recon index) renders an empty cell, never a wrong one
          sheetId: "booksded", party: "Pseudonym One", date: "20-Dec-2025", tax: 1100,
          gross: null, voucherType: "Journal", ref: "Doc 3", status: null, section: null,
          inWindow: true, linkBasis: "none", linked: null, delta: null, windowState: "in",
        },
        {
          sheetId: "as26", partyId: "P1", party: "Pseudonym One", date: "05-Jan-2026", tax: 2000,
          gross: 100000, voucherType: null, ref: "Doc 4", status: "L", section: "194C",
          inWindow: false, linkBasis: "none", linked: null, delta: null, windowState: "post",
        },
        {
          sheetId: "value", party: "Pseudonym One", date: "09-Sep-2025", tax: 4600.15,
          gross: 240000, voucherType: null, ref: null, status: null, section: "194C",
          inWindow: true, linkBasis: "invoice-rate",
          linked: { date: "05-Jun-2025", ref: "Doc 5", taxable: 230000 },
          delta: 10000.89, windowState: "in",
        },
      ],
    };
    const paths = await writeAs26Report({
      reportDir,
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: "plain markdown",
      result,
      vault: createVault(),
    });
    const wb = readWorkbook(readFileSync(paths.workbookPath));
    const names = wb.map((s) => s.name);
    expect(names).toEqual([
      "Findings", "Deductors", "Books Events", "Mapping",
      "Books not in 26AS", "26AS unmatched", "Bill value mismatch", "Combination matches", "FD interest 20% TDS", "FD ledger auto-assign",
    ]);

    // data row n (1-based) is rows[n] — Excel row 1 is the header row
    const dataRows = (sh: GridSheet): string[][] =>
      sh.rows.slice(1).map((r) => {
        const out: string[] = [];
        let prev = -1;
        for (const k of [...r.cells.keys()].sort((a, b) => a - b)) {
          for (let i = prev + 1; i < k; i++) out.push("");
          out.push(String(r.cells.get(k)!.value ?? ""));
          prev = k;
        }
        return out;
      });

    const books = dataRows(wb.find((s) => s.name === "Books not in 26AS")!);
    // the party id sits beside the row id: the same party carries the same
    // id on both unmatched sheets and on its Deductors row
    expect(books[0]).toEqual([
      "B1", "P1", "Pseudonym One", "10-Jun-2025", "Journal", "Doc 1", "4600.15",
      "Doc 2", "09-Sep-2025", "230000", "reference", "",
    ]);
    expect(books[1]).toEqual([
      "B2", "", "Pseudonym One", "20-Dec-2025", "Journal", "Doc 3", "1100",
      "", "", "", "none", "",
    ]);

    const as26 = dataRows(wb.find((s) => s.name === "26AS unmatched")!);
    expect(as26[0]).toEqual([
      "D1", "P1", "Pseudonym One", "05-Jan-2026", "194C", "2000", "100000", "L", "none", "post-period",
    ]);

    const value = dataRows(wb.find((s) => s.name === "Bill value mismatch")!);
    expect(value[0]).toEqual([
      "V1", "Pseudonym One", "09-Sep-2025", "240000", "Doc 5", "05-Jun-2025",
      "230000", "10000.89", "1000", "invoice-rate", "",
    ]);
    // the tolerance renders as the NUMERIC 1000 (format: "money"), never a string
    expect(value[0][8]).toBe("1000");
    expect(value[0][8]).not.toBe("1,000.00");
  });
});

describe("tb_write_26as_report > Deductors cell placement", () => {
  // Inbox 009: the captain's viewer showed the GST-inclusive value under the
  // "books interest" header for sales parties. The sheet was already correct
  // (blank value cells shift dense viewers); this test pins the layout so a
  // regression cannot reintroduce an actual mis-assignment.
  it("puts GST-inclusive value in 'gross incl GST', interest in 'books interest', nothing shifted", async () => {
    const session = createSession(fakeDown(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const mk = (as26Name: string, ledger: string, over: Partial<As26ReviewResult["recon"][number]>): As26ReviewResult["recon"][number] => ({
      match: {
        ledgerKeys: [ledger], ledgerNames: [ledger], ledgerName: ledger,
        as26NameKey: ledger, as26Name, kind: "tds", source: "operator",
      },
      booksTax: 0, as26Tax: 0, paired: [], combinations: [], ambiguous: 0,
      unmatchedBooks: [], unmatchedAs26: [], combinationSearchSkipped: false,
      lateBookedTax: 0,
      ...over,
    });
    const result = {
      company: "Demo Traders Pvt Ltd", fromDate: "20250401", toDate: "20260331",
      findings: [], gaps: [],
      totals: { booksTax: 0, as26Tax: 0, partiesMatched: 2, combinationExplained: 0, ambiguous: 0 },
      mastersUnavailable: false, groupsUnavailable: false,
      skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
      counts: { credits: 0, receivableLedgers: [] }, bookEvents: [], billRows: [],
      recon: [
        // sales party: taxable book 1800000, GST-inclusive 2124000
        mk("Acme Vendor", "Acme Vendor Sales A/c", {
          booksTax: 4600, as26Tax: 4600, booksTaxableValue: 1800000,
          booksGrossValue: 2124000, as26GrossValue: 1800000,
          valueBasis: "taxable", valueDelta: 0,
        }),
        // bank party: books interest 1199509, no sales value
        mk("Union Finance Bank", "FD Interest Ledger", {
          booksTax: 0, as26Tax: 0, booksInterestValue: 1199509,
          as26GrossValue: 962258, valueBasis: "interest", valueDelta: 237251,
        }),
      ],
    } as As26ReviewResult;
    const paths = await writeAs26Report({
      reportDir: tempDir("as26-deductors-"), company: "Demo Traders Pvt Ltd",
      fromDate: "20250401", toDate: "20260331",
      markdown: "narrative", result, vault: session.vault,
    });
    const wb = readWorkbook(readFileSync(paths.workbookPath));
    const sheet = wb.find((s) => s.name === "Deductors")!;
    // header row: column letters must hold the right header
    const header = sheet.rows[0];
    // column B is the cross-sheet party id, so the value columns shifted by one
    expect(header.cells.get(8)!.value).toBe("books interest"); // I
    expect(header.cells.get(9)!.value).toBe("gross incl GST"); // J
    const cell = (eRow: number, col: number): unknown => sheet.rows[eRow].cells.get(col)?.value;
    const sales = 1, bank = 2;
    // the cross-sheet party id: P1, P2 in Deductors-sheet order
    expect(cell(sales, 1)).toBe("P1");
    expect(cell(bank, 1)).toBe("P2");
    // sales row: taxable H, GST-inclusive J, I EMPTY
    expect(cell(sales, 7)).toBe(1800000); // H taxable
    expect(cell(sales, 8) ?? null).toBeNull(); // I books interest stays empty
    expect(cell(sales, 9)).toBe(2124000); // J gross incl GST
    expect(cell(sales, 11)).toBe("taxable"); // L basis
    // bank row: interest I, no GST-inclusive value
    expect(cell(bank, 8)).toBe(1199509); // I books interest
    expect(cell(bank, 9) ?? null).toBeNull(); // J gross incl GST stays empty
    expect(cell(bank, 11)).toBe("interest"); // L basis
  });
});

describe("tb_write_26as_report > FD interest 20% TDS sheet", () => {
  it("lists the 20%-taxed FD interest entries with a totals row, de-masked on disk", async () => {
    const session = createSession(fakeDown(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const result = {
      company: "Demo Traders Pvt Ltd", fromDate: "20250401", toDate: "20260331",
      findings: [], recon: [], gaps: [], totals: { booksTax: 0, as26Tax: 0, partiesMatched: 0, combinationExplained: 0, ambiguous: 0 },
      mastersUnavailable: false, groupsUnavailable: false,
      skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
      counts: { credits: 0, receivableLedgers: [] }, bookEvents: [], billRows: [],
      fd20: [{ party: "Ledger 1", date: "01-Aug-2025", interest: 5000, tax: 1000 },
             { party: "Ledger 1", date: "01-Nov-2025", interest: 4000, tax: 800 }],
    } as As26ReviewResult;
    const paths = await writeAs26Report({
      reportDir: tempDir("as26-out"), company: "Demo Traders Pvt Ltd",
      fromDate: "20250401", toDate: "20260331",
      markdown: "narrative", result, vault: session.vault,
    });
    const wb = readWorkbook(readFileSync(paths.workbookPath));
    const sheet = wb.find((s) => s.name === "FD interest 20% TDS")!;
    const rows = [...sheet.rows.values()].map((r) => [...r.cells.values()].map((c) => c.value));
    expect(rows).toEqual([
      ["row", "party", "date", "interest", "TDS (20%)"],
      ["F20-1", "Ledger 1", "01-Aug-2025", 5000, 1000],
      ["F20-2", "Ledger 1", "01-Nov-2025", 4000, 800],
      [null, null, "total", 9000, 1800],
    ]);
  });
});

describe("tb_write_26as_report > FD ledger auto-assign sheet", () => {
  it("names the unassigned FD ledgers AS26-011 counts, before the assigned rows", async () => {
    const session = createSession(fakeDown(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const result = {
      company: "Demo Traders Pvt Ltd", fromDate: "20250401", toDate: "20260331",
      findings: [], recon: [], gaps: [], totals: { booksTax: 0, as26Tax: 0, partiesMatched: 0, combinationExplained: 0, ambiguous: 0 },
      mastersUnavailable: false, groupsUnavailable: false,
      skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
      counts: { credits: 0, receivableLedgers: [] }, bookEvents: [], billRows: [],
      fd20: [],
      fdAuto: [{ ledger: "FD - 100099221 A", bank: "Union Bank of India", rule: "name-match" }],
      fdUnassigned: ["FD - 100099222", "FD - 100099223"],
    } as unknown as As26ReviewResult;
    const paths = await writeAs26Report({
      reportDir: tempDir("as26-fdauto"), company: "Demo Traders Pvt Ltd",
      fromDate: "20250401", toDate: "20260331",
      markdown: "narrative", result, vault: session.vault,
    });
    const wb = readWorkbook(readFileSync(paths.workbookPath));
    const sheet = wb.find((s) => s.name === "FD ledger auto-assign")!;
    const rows = [...sheet.rows.values()].map((r) => [...r.cells.values()].map((c) => c.value));
    expect(rows).toEqual([
      ["row", "FD ledger", "assigned bank", "rule"],
      ["FAS-1", "FD - 100099222", "unassigned", "unassigned"],
      ["FAS-2", "FD - 100099223", "unassigned", "unassigned"],
      ["FAS-3", "FD - 100099221 A", "Union Bank of India", "name-match"],
    ]);
  });
});

describe("writeAs26Report — combination sheet (addendum 7 follow-up)", () => {
  it("matched groups leave the unmatched sheets and show their invoice link", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "as26-combo-"));
    try {
      const result = {
        findings: [],
        gaps: [],
        totals: { booksTax: 0, as26Tax: 0, partiesMatched: 1, combinationExplained: 1, ambiguous: 0 },
        mastersUnavailable: false,
        groupsUnavailable: false,
        skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
        counts: { credits: 0, receivableLedgers: ["TDS Receivable"] },
        bookEvents: [],
        fd20: [],
        fdAuto: [],
        bankParties: [],
        section194QApplicable: true,
        recon: [
          {
            match: { kind: "tds" as const, nameKey: "nk", ledgerKeys: ["lk"], ledgerName: "Pseudonym One", as26Name: "Debtor One" },
            booksTax: 59962, as26Tax: 59962, paired: [], ambiguous: 0,
            unmatchedBooks: [], unmatchedAs26: [],
            combinationSearchSkipped: false, lateBookedTax: 0,
            combinations: [
              {
                target: { date: "01-Nov-2025", tax: 59962 },
                parts: [
                  { date: "02-Jul-2025", tax: 4840 },
                  { date: "02-Jul-2025", tax: 22725 },
                  { date: "02-Jul-2025", tax: 14870 },
                  { date: "02-Jul-2025", tax: 17527 },
                ],
                side: "as26" as const,
                basis: "taxable-rate" as const,
                invoiceRef: "Doc 12", invoiceDate: "21-Jul-2025", invoiceTaxable: 2998069,
                targetId: "D2", partIds: ["B1", "B2", "B3", "B4"],
              },
            ],
            booksTaxableValue: 0, booksGrossValue: 0, as26GrossValue: 0,
          },
        ],
        billRows: [],
      };
      const paths = await writeAs26Report({
        reportDir, company: "Demo Traders Pvt Ltd",
        fromDate: "20250401", toDate: "20260331",
        markdown: as26Markdown(result, "Demo Traders Pvt Ltd", "20250401", "20260331"),
        result, vault: createVault(),
      });
      const sheets = readWorkbook(readFileSync(paths.workbookPath));
      const cell = (r: { cells: Map<number, { value: unknown }> }, i: number) => r.cells.get(i)?.value ?? "";
      const books = sheets.find((x) => x.name === "Books not in 26AS")!;
      const as26 = sheets.find((x) => x.name === "26AS unmatched")!;
      const combo = sheets.find((x) => x.name === "Combination matches")!;
      expect(books.rows.slice(1).filter((r) => cell(r, 0) !== "")).toHaveLength(0);
      expect(as26.rows.slice(1).filter((r) => cell(r, 0) !== "")).toHaveLength(0);
      const comboRows = combo.rows.slice(1).filter((r) => cell(r, 0) !== "");
      expect(comboRows).toHaveLength(1);
      expect(cell(comboRows[0], 1)).toBe("as26");
      expect(cell(comboRows[0], 2)).toBe("Debtor One"); // the TARGET is a 26AS row, so the 26AS name ("Debtor One"), not the TALLY ledger name ("Pseudonym One")
      expect(cell(comboRows[0], 3)).toBe("D2");
      expect(cell(comboRows[0], 6)).toBe("4");
      expect(cell(comboRows[0], 7)).toBe("B1, B2, B3, B4");
      expect(cell(comboRows[0], 9)).toBe("Doc 12");
      expect(cell(comboRows[0], 12)).toBe("taxable-rate");
      const md = readFileSync(paths.markdownPath, "utf8");
      expect(md).toMatch(/Unmatched after reconciliation: 0 books entries and 0 26AS rows/);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  it("books-target aggregate shows its consumed rows and hides them from the unmatched sheets", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "as26-combo2-"));
    try {
      const billRow = (over: Partial<As26ReviewResult["billRows"][number]>) => ({
        sheetId: "booksded" as const, party: "Pseudonym One", date: "31-Mar-2026",
        tax: 17107, gross: null, voucherType: "Journal", ref: null, status: null,
        section: null, inWindow: true, linkBasis: "none" as const, windowState: "in" as const,
        linked: null, delta: null, explained: false, ...over,
      });
      const result = {
        findings: [],
        gaps: [],
        totals: { booksTax: 0, as26Tax: 0, partiesMatched: 1, combinationExplained: 1, ambiguous: 0 },
        mastersUnavailable: false,
        groupsUnavailable: false,
        skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
        counts: { credits: 0, receivableLedgers: ["TDS Receivable"] },
        bookEvents: [],
        fd20: [],
        fdAuto: [],
        bankParties: [],
        section194QApplicable: true,
        recon: [
          {
            match: { kind: "tds" as const, nameKey: "nk", ledgerKeys: ["lk"], ledgerName: "Pseudonym One", as26Name: "Pseudonym One" },
            booksTax: 17107, as26Tax: 17107, paired: [], ambiguous: 0,
            unmatchedBooks: [], unmatchedAs26: [],
            combinationSearchSkipped: false, lateBookedTax: 0,
            combinations: [
              {
                target: { date: "31-Mar-2026", tax: 17107 },
                parts: [{ date: "31-Mar-2026", tax: 17107 }],
                side: "books" as const,
                targetId: "B1", partIds: ["D1"],
              },
            ],
            booksTaxableValue: 0, booksGrossValue: 0, as26GrossValue: 0,
          },
        ],
        billRows: [
          billRow({ explained: true }),
          billRow({ date: "01-Apr-2026", tax: 500 }),
          billRow({ sheetId: "as26", tax: 1426, voucherType: null, section: "194R", status: "F", explained: true }),
          billRow({ sheetId: "as26", tax: 8000, voucherType: null, section: "194R", status: "F" }),
        ],
      };
      const paths = await writeAs26Report({
        reportDir, company: "Demo Traders Pvt Ltd",
        fromDate: "20250401", toDate: "20260331",
        markdown: as26Markdown(result, "Demo Traders Pvt Ltd", "20250401", "20260331"),
        result, vault: createVault(),
      });
      const sheets = readWorkbook(readFileSync(paths.workbookPath));
      const cell = (r: { cells: Map<number, { value: unknown }> }, i: number) => r.cells.get(i)?.value ?? "";
      const books = sheets.find((x) => x.name === "Books not in 26AS")!;
      const as26 = sheets.find((x) => x.name === "26AS unmatched")!;
      const combo = sheets.find((x) => x.name === "Combination matches")!;
      // Consumed rows keep their reserved ids but are not displayed.
      const booksShown = books.rows.slice(1).filter((r) => cell(r, 0) !== "");
      expect(booksShown).toHaveLength(1);
      expect(cell(booksShown[0], 0)).toBe("B2");
      const as26Shown = as26.rows.slice(1).filter((r) => cell(r, 0) !== "");
      expect(as26Shown).toHaveLength(1);
      expect(cell(as26Shown[0], 0)).toBe("D2");
      const comboRows = combo.rows.slice(1).filter((r) => cell(r, 0) !== "");
      expect(comboRows).toHaveLength(1);
      expect(cell(comboRows[0], 1)).toBe("books");
      expect(cell(comboRows[0], 3)).toBe("B1");
      expect(cell(comboRows[0], 6)).toBe("1");
      expect(cell(comboRows[0], 7)).toBe("D1");
      expect(cell(comboRows[0], 8)).toBe(17107);
      expect(cell(comboRows[0], 12)).toBe("aggregate");
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});

describe("writeAs26Report — shared-ledger group", () => {
  it("names every 26AS name on the ledger with its own tax, on the sheet and in the markdown", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "as26-shared-"));
    try {
      const result = {
        findings: [],
        gaps: [],
        totals: { booksTax: 1668896, as26Tax: 1668896, partiesMatched: 1, combinationExplained: 0, ambiguous: 0 },
        mastersUnavailable: false,
        groupsUnavailable: false,
        skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 },
        counts: { credits: 0, receivableLedgers: ["TDS Receivable"] },
        bookEvents: [],
        fd20: [],
        fdAuto: [],
        bankParties: [],
        section194QApplicable: true,
        recon: [
          {
            match: {
              kind: "tds" as const, nameKey: "nk1", ledgerKeys: ["lk"], ledgerName: "Pseudonym Ledger",
              as26Name: "Pseudonym One", shared: true,
              members: [
                { as26NameKey: "nk1", as26Name: "Pseudonym One", kind: "tds" as const, tax: 523944, ledgerNames: ["Pseudonym Ledger"] },
                { as26NameKey: "nk2", as26Name: "Pseudonym Two", kind: "tds" as const, tax: 1144952, ledgerNames: ["Pseudonym Ledger"] },
              ],
            },
            booksTax: 1668896, as26Tax: 1668896, paired: [], combinations: [], ambiguous: 0,
            unmatchedBooks: [], unmatchedAs26: [], combinationSearchSkipped: false, lateBookedTax: 0,
            totalsOnly: true,
          },
        ],
        billRows: [],
      } as unknown as As26ReviewResult;
      const paths = await writeAs26Report({
        reportDir, company: "Demo Traders Pvt Ltd", fromDate: "20250401", toDate: "20260331",
        markdown: as26Markdown(result, "Demo Traders Pvt Ltd", "20250401", "20260331"),
        result, vault: createVault(),
      });
      const wb = readWorkbook(readFileSync(paths.workbookPath));
      const cell = (r: { cells: Map<number, { value: unknown }> }, i: number) => r.cells.get(i)?.value ?? "";
      const deductors = wb.find((s) => s.name === "Deductors")!;
      expect(cell(deductors.rows[1], 0)).toBe("Pseudonym One + Pseudonym Two");
      expect(cell(deductors.rows[1], 1)).toBe("P1"); // the cross-sheet party key
      expect(cell(deductors.rows[1], 3)).toBe(1668896);
      // The Mapping sheet lists one row per 26AS name, each with its OWN tax.
      const mapping = wb.find((s) => s.name === "Mapping")!;
      expect(cell(mapping.rows[1], 0)).toBe("Pseudonym One");
      expect(cell(mapping.rows[1], 2)).toBe(523944);
      expect(cell(mapping.rows[2], 0)).toBe("Pseudonym Two");
      expect(cell(mapping.rows[2], 2)).toBe(1144952);
      expect(cell(mapping.rows[2], 3)).toBe("Pseudonym Ledger");
      const md = readFileSync(paths.markdownPath, "utf8");
      expect(md).toContain("Shared ledger Pseudonym Ledger");
      expect(md).toContain("Pseudonym One: 26AS tax 5,23,944.00");
      expect(md).toContain("Pseudonym Two: 26AS tax 11,44,952.00");
      expect(md).toContain("group total: 26AS tax 16,68,896.00 against books tax 16,68,896.00");
      expect(md).toContain("not split between the names");
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});
