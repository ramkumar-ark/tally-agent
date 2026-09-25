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
