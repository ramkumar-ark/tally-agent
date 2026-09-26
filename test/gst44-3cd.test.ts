import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partText, readXlsm, replacePart, writeXlsm } from "../src/xlsm.js";
import { readSchema } from "../src/winman3cd.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_GST44 } from "../src/gst44.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { GST44_PART, makeWinmanGst44Fixture } from "./fixtures/winman-fixture.js";
import { buildGstWorksheet } from "../src/gst44-worksheet-template.js";
import { readWorksheetTotals } from "../src/gst44-worksheet-read.js";
import type { WsLedgerRow } from "../src/gst44-worksheet.js";
import type { VoucherRow } from "../src/downstream.js";

describe("winman gst44 fixture", () => {
  it("carries the clause-44 schema the reader expects", () => {
    const pkg = readXlsm(makeWinmanGst44Fixture());
    const s = readSchema(pkg, "Break-up of GST expenditure");
    expect(s.formId).toBe("3CDGSTbreakup44");
    expect(s.firstDataRow).toBe(8);
    expect(s.fieldPath).toBe("");
    expect(s.partName).toBe(GST44_PART);
    expect([...s.keys.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0])).toEqual([
      "PARTICULARS", "TOTALEXPENDITURE", "TOWARDSSUPPLIES", "COMPOSITIONSUPPLIER", "OTHERS", "REGISTEREDUNDERGST",
    ]);
  });

  it("marks the prototype row hidden in row 7, like the real export", () => {
    const pkg = readXlsm(makeWinmanGst44Fixture());
    const s = readSchema(pkg, "Break-up of GST expenditure");
    expect(s.prototypeRow).toBe(7);
    expect(s.prototypeStyles.get(0)).toBe(87);
    expect(s.prototypeStyles.get(5)).toBe(88);
  });
});

// Synthetic names/GSTINs/figures only (captain ruling, gst44-review.test.ts
// convention). The stub reuses that file's exact shapes: one taxed registered
// purchase so the revenue row is non-zero and the cached rows are real.
const ROOT = "\u0004 Primary";
const GROUPS = [
  { name: "Sundry Creditors", parent: ROOT },
  { name: "Purchase Accounts", parent: ROOT },
  { name: "Duties & Taxes", parent: ROOT },
  { name: "Input GST", parent: "Duties & Taxes" },
];
const MASTERS = [
  { name: "Nova Traders", parent: "Sundry Creditors", openingBalance: 0, closingBalance: 0 },
  { name: "Site Materials", parent: "Purchase Accounts", openingBalance: 0, closingBalance: 0 },
  { name: "Input IGST A/c", parent: "Input GST", openingBalance: 0, closingBalance: 0 },
];
const GSTIN_REG = "27AAAAA0000A1Z5";
const LEDGERS_TAX = [
  { name: "Nova Traders", parent: "Sundry Creditors", gstin: GSTIN_REG, state: "Maharashtra", pan: "AAAAA0000A", isTdsApplicable: false, tdsDeducteeType: "", natureOfPayment: null },
];
const v = (
  party: string,
  voucherNumber: string,
  entries: Array<[string, number]>,
): VoucherRow => ({
  date: "20250405", voucherType: "Purchase", voucherNumber,
  partyLedgerName: party, cancelled: false,
  entries: entries.map(([ledger, amount]) => ({ ledger, amount })),
});
const stubFor = (vouchers: VoucherRow[]) =>
  Object.assign(fakeDownstream(), {
    groups: async () => GROUPS,
    ledgers: async () => MASTERS,
    vouchers: async () => vouchers,
    ledgersTax: async () => LEDGERS_TAX,
  } as never);

/** Seed lastGst44 through the session: a 100000 registered purchase -> revenue row's OTHERS. */
async function seededSession(vouchers: VoucherRow[]) {
  const session = createSession(stubFor(vouchers), EMPTY_OVERRIDES);
  await session.gst44Review({ fromDate: "20250401", toDate: "20250630", operator: EMPTY_GST44 });
  return session;
}

const HK_VOUCHER = [v("Nova Traders", "P-1", [["Site Materials", 100000], ["Nova Traders", -100000]])];

describe("write3cdGst44", () => {
  it("writes both rows with labels, replacing the pre-filled 8/9 wholesale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gst44-"));
    const src = join(dir, "wb.xlsm");
    writeFileSync(src, makeWinmanGst44Fixture());
    const session = await seededSession(HK_VOUCHER);
    const out = await session.write3cdGst44({ sourcePath: src, outPath: dir });
    // The source template stays byte-identical; the copy lands beside outPath.
    expect(out.startsWith(dir)).toBe(true);
    expect(readFileSync(src).equals(makeWinmanGst44Fixture())).toBe(true);
    const xml = partText(readXlsm(readFileSync(out)), GST44_PART);
    // Rows >= 8 are replaced wholesale, so the pre-filled labels are re-written by us.
    expect(xml).toContain("Capital Expenditure");
    expect(xml).toContain("Revenue Expenditure");
    // The revenue row's OTHERS bucket and row total, from the seeded review.
    expect(xml).toMatch(/<v>100000<\/v>/);
    // The capital row's zeros are preserved, not dropped.
    expect(xml).toMatch(/<v>0<\/v>/);
    expect((xml.match(/<row r="8"/g) ?? []).length).toBe(1);
    expect((xml.match(/<row r="9"/g) ?? []).length).toBe(1);
    expect(xml).not.toMatch(/<row r="1[0-9]"/); // no stray rows
    // xf 88's quotePrefix prototype had no twin in this fixture, so the
    // styles append happened: 94 xfs + 1 appended twin = 95.
    const styles = partText(readXlsm(readFileSync(out)), "xl/styles.xml");
    expect(Number(styles.match(/<cellXfs count="(\d+)"/)![1])).toBe(95);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a workbook whose Break-up sheet carries another form id", async () => {
    // Doctor A1's shared-string ref through the package tools (the fixture
    // zip builder has no per-part override): A1 then points at the sheet-key
    // string, so the form id no longer matches. The error cites the real
    // form id 3CDGSTbreakup44, never the doctored cell's value.
    const doctored = writeXlsm(
      replacePart(
        readXlsm(makeWinmanGst44Fixture()),
        GST44_PART,
        partText(readXlsm(makeWinmanGst44Fixture()), GST44_PART).replace(
          /(<c r="A1"[^>]*t="s"><v>)17(<\/v>)/,
          "$118$2",
        ),
      ),
    );
    const dir = mkdtempSync(join(tmpdir(), "gst44-bad-"));
    const src = join(dir, "wb.xlsm");
    writeFileSync(src, doctored);
    const session = await seededSession([]);
    await expect(session.write3cdGst44({ sourcePath: src, outPath: dir })).rejects.toThrow(/3CDGSTbreakup44/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an outPath that resolves onto the source workbook itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gst44-guard-"));
    const sourcePath = join(dir, "breakup.xlsm");
    const source = makeWinmanGst44Fixture();
    writeFileSync(sourcePath, source);
    const session = await seededSession(HK_VOUCHER);
    // Both the plain identity and a dot-dotted, spelt-differently alias of it.
    await expect(
      session.write3cdGst44({ sourcePath, outPath: sourcePath }),
    ).rejects.toThrow(/resolves to the source workbook/);
    await expect(
      session.write3cdGst44({ sourcePath, outPath: join(dir, ".", "breakup.xlsm") }),
    ).rejects.toThrow(/resolves to the source workbook/);
    expect(readFileSync(sourcePath).equals(source)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to write when no review has run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gst44-norev-"));
    const src = join(dir, "wb.xlsm");
    writeFileSync(src, makeWinmanGst44Fixture());
    const session = createSession(stubFor([]), EMPTY_OVERRIDES);
    await expect(session.write3cdGst44({ sourcePath: src, outPath: dir })).rejects.toThrow(
      /run tb_gst44_review first/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

// ------------------- approved working sheet as the write source -------------------

const seed = (over: Partial<Record<"d" | "e" | "h" | "j", number>>) => ({
  d: 0,
  e: 0,
  h: 0,
  j: 0,
  treatment: "others" as const,
  kind: "policy keyword" as const,
  reason: "test seed",
  ...over,
});

const WS_REVENUE: WsLedgerRow[] = [
  { ledger: "Alpha", group: "Purchase Accounts", rowKey: "revenue", amount: 100000, seed: seed({}) },
  { ledger: "Beta", group: "Indirect Expenses", rowKey: "revenue", amount: 50000, seed: seed({ d: 30000, j: 20000 }) },
  { ledger: "Gamma", group: "Indirect Expenses", rowKey: "revenue", amount: 8000, seed: seed({ h: 8000 }) },
];
const WS_CAPITAL: WsLedgerRow[] = [
  { ledger: "Plant", group: "Fixed Assets", rowKey: "capital", amount: 40000, seed: seed({}) },
];

const workingSheet = (): Buffer =>
  buildGstWorksheet({
    company: "Test Co",
    period: "FY 25-26",
    revenueRows: WS_REVENUE,
    capitalRows: WS_CAPITAL,
    rules: [],
    priorYearUsed: false,
  });

describe("readWorksheetTotals", () => {
  it("recomputes the clause-44 rows from the sheet's literal cells (F/G/I are formulas)", () => {
    const rows = readWorksheetTotals(workingSheet());
    expect(rows.map((r) => r.key)).toEqual(["capital", "revenue"]);
    const [capital, revenue] = rows;
    expect(capital.label).toBe("Capital Expenditure");
    expect(capital).toMatchObject({ total: 40000, exempt: 0, composition: 0, others: 40000, unregistered: 0 });
    expect(revenue.label).toBe("Revenue Expenditure");
    // D=30000 exempt, H=8000 unregistered, others = B - H - J - E - D = 100000
    expect(revenue).toMatchObject({
      total: 138000,
      exempt: 30000,
      composition: 0,
      others: 100000,
      unregistered: 8000,
    });
    // Winman C5 invariant: total = exempt + composition + others + unregistered.
    expect(revenue.total).toBe(revenue.exempt + revenue.composition + revenue.others + revenue.unregistered);
  });

  it("errors clearly when the workbook is not a working sheet", () => {
    expect(() => readWorksheetTotals(makeWinmanGst44Fixture())).toThrow(/no "CAPITAL" sheet/);
  });
});

describe("write3cdGst44 from the approved working sheet", () => {
  it("writes the worksheet totals without a review having run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gst44-ws-"));
    const src = join(dir, "wb.xlsm");
    const sheetPath = join(dir, "ws.xlsx");
    writeFileSync(src, makeWinmanGst44Fixture());
    writeFileSync(sheetPath, workingSheet());
    // Deliberately NO gst44Review: the worksheet path must stand alone.
    const session = createSession(stubFor([]), EMPTY_OVERRIDES);
    const out = await session.write3cdGst44({ sourcePath: src, outPath: dir, worksheetPath: sheetPath });
    expect(readFileSync(src).equals(makeWinmanGst44Fixture())).toBe(true);
    const xml = partText(readXlsm(readFileSync(out)), GST44_PART);
    for (const v of [138000, 30000, 100000, 8000, 40000]) expect(xml).toMatch(new RegExp(`<v>${v}</v>`));
    expect(xml).toContain("Capital Expenditure");
    expect(xml).toContain("Revenue Expenditure");
    rmSync(dir, { recursive: true, force: true });
  });
});
