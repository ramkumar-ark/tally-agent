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
    });
    const res = JSON.parse(out);
    expect(res.findings.length).toBeGreaterThanOrEqual(0);
    expect(out).not.toContain("Anand Buildmart");
    const auditText = readFileSync(join(reportDir, "session-20260331T100000Z.jsonl"), "utf8").trim();
    const entry = JSON.parse(auditText.split("\n").pop()!);
    expect(entry.tool).toBe("tb_26as_review");
    expect(entry.args.as26Path).toBe(as26Path);
    expect(JSON.stringify(entry)).not.toContain("Nagar Palika");
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
          sheetId: "booksded", party: "Pseudonym One", date: "10-Jun-2025", tax: 4600.15,
          gross: null, voucherType: "Journal", ref: "Doc 1", status: null, section: null,
          inWindow: true, linkBasis: "reference",
          linked: { date: "09-Sep-2025", ref: "Doc 2", taxable: 230000 }, delta: null,
          windowState: "in",
        },
        {
          sheetId: "booksded", party: "Pseudonym One", date: "20-Dec-2025", tax: 1100,
          gross: null, voucherType: "Journal", ref: "Doc 3", status: null, section: null,
          inWindow: true, linkBasis: "none", linked: null, delta: null, windowState: "in",
        },
        {
          sheetId: "as26", party: "Pseudonym One", date: "05-Jan-2026", tax: 2000,
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
    expect(books[0]).toEqual([
      "B1", "Pseudonym One", "10-Jun-2025", "Journal", "Doc 1", "4600.15",
      "Doc 2", "09-Sep-2025", "230000", "reference", "",
    ]);
    expect(books[1]).toEqual([
      "B2", "Pseudonym One", "20-Dec-2025", "Journal", "Doc 3", "1100",
      "", "", "", "none", "",
    ]);

    const as26 = dataRows(wb.find((s) => s.name === "26AS unmatched")!);
    expect(as26[0]).toEqual([
      "D1", "Pseudonym One", "05-Jan-2026", "194C", "2000", "100000", "L", "none", "post-period",
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
    expect(header.cells.get(7)!.value).toBe("books interest"); // H
    expect(header.cells.get(8)!.value).toBe("gross incl GST"); // I
    const cell = (eRow: number, col: number): unknown => sheet.rows[eRow].cells.get(col)?.value;
    const sales = 1, bank = 2;
    // sales row: taxable G, GST-inclusive I, H EMPTY
    expect(cell(sales, 6)).toBe(1800000); // G taxable
    expect(cell(sales, 7) ?? null).toBeNull(); // H books interest stays empty
    expect(cell(sales, 8)).toBe(2124000); // I gross incl GST
    expect(cell(sales, 10)).toBe("taxable"); // K basis
    // bank row: interest H, no GST-inclusive value
    expect(cell(bank, 7)).toBe(1199509); // H books interest
    expect(cell(bank, 8) ?? null).toBeNull(); // I gross incl GST stays empty
    expect(cell(bank, 10)).toBe("interest"); // K basis
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
            match: { kind: "tds" as const, nameKey: "nk", ledgerKeys: ["lk"], ledgerName: "Pseudonym One", as26Name: "Pseudonym One" },
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
      expect(cell(comboRows[0], 2)).toBe("Pseudonym One");
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
