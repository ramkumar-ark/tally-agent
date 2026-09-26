import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDayBook } from "../src/tds-daybook.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { makeTdsTcsFixture } from "./fixtures/winman-fixture.js";
import { partText, readXlsm } from "../src/xlsm.js";
import { readSchema } from "../src/winman3cd.js";
import { money } from "../src/format.js";

const MASTERS = JSON.stringify([
  { name: "Sample Builders LLP", parent: "Sundry Creditors", state: "Karnataka", IncomeTaxNumber: "ABCC1234A", IsTDSApplicable: "Yes", TDSDeducteeType: "Company" },
  { name: "Sample Consultants", parent: "Sundry Creditors", state: "Karnataka", IncomeTaxNumber: "ABCS1234B", IsTDSApplicable: "Yes", TDSDeducteeType: "Company" },
  { name: "Site Repairs Contract", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  { name: "Professional Fees", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  { name: "TDS Contractors", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  { name: "TDS Professional Fees", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  { name: "TCS Receivable", parent: "Duties & Taxes", IsTDSApplicable: "No" },
  { name: "TCS Other", parent: "Duties & Taxes", IsTDSApplicable: "No" },
  { name: "Scrap Sales", parent: "Sales Accounts" },
]);

// Raw Tally sign on every entry (negative = debit); the flip to
// positive = debit happens once in parseVoucherRows, as at the gateway.
const voucher = (
  date: string,
  voucherNumber: string,
  voucherType: string,
  entries: Array<[string, number]>,
) => ({
  date,
  voucherType,
  voucherNumber,
  partyLedgerName: "",
  entries: entries.map(([LEDGERNAME, AMOUNT]) => ({ LEDGERNAME, AMOUNT })),
});

// 194C: 3,00,000 booked and deducted at the standard 2% (6,000) on the same
// day, deposited late on 15-Jul (due 07-Jun -> 3 months of interest (ii)).
const puC = voucher("20250510", "PU/C", "Purchase", [
  ["Site Repairs Contract", -300000],
  ["Sample Builders LLP", 300000],
]);
const jvC = voucher("20250510", "JV/C", "Journal", [
  ["Sample Builders LLP", -6000],
  ["TDS Contractors", 6000],
]);
const pyC = voucher("20250715", "PY/C", "Journal", [
  ["TDS Contractors", -6000],
  ["Bank", 6000],
]);
// 194J: 2,00,000 booked same day, deducted at the s.197 certificate rate
// (2% = 4,000), deposited late on 10-Sep (due 07-Aug -> 3 months).
const puJ = voucher("20250715", "PU/J", "Purchase", [
  ["Professional Fees", -200000],
  ["Sample Consultants", 200000],
]);
const jvJ = voucher("20250715", "JV/J", "Journal", [
  ["Sample Consultants", -4000],
  ["TDS Professional Fees", 4000],
]);
const pyJ = voucher("20250910", "PY/J", "Journal", [
  ["TDS Professional Fees", -4000],
  ["Bank", 4000],
]);
// TCS scrap: 1% of 3,00,000 collected on 10-Oct, deposited on 15-Jan (3
// months late against the 07-Nov due date). The receipt side's day-book
// sign follows the engine's convention (tcs.test.ts): the receipt slice
// reads downstream-positive. TCS Other carries an unmapped debit only (its
// nature stays unresolvable -> the unclassified finding), never a tax row.
const stT = voucher("20251010", "S/T", "Sales", [
  ["Scrap Sales", -300000],
  ["TCS Receivable", 3000],
  ["Scrap Buyer", 303000],
]);
const ptT = voucher("20251125", "PY/T", "Journal", [
  ["TCS Receivable", -3000],
  ["Bank", 3000],
]);
const stO = voucher("20251011", "S/O", "Sales", [
  ["Bank", 700],
  ["TCS Other", -700],
]);

const VOUCHERS: unknown[] = [puC, jvC, pyC, puJ, jvJ, pyJ, stT, ptT, stO];

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: "Site Repairs Contract", section: "194C" },
    { ledger: "Professional Fees", section: "194J" },
    { ledger: "TDS Contractors", section: "194C", kind: "duty" },
    { ledger: "TDS Professional Fees", section: "194J", kind: "duty" },
  ],
  parties: [
    { ledger: "Sample Builders LLP", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
    { ledger: "Sample Consultants", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
  ],
  certificates: [
    { ledger: "Sample Consultants", section: "194J", rate: 2, from: "20250401", to: "20260331", limit: 0 },
  ],
  statements: [
    { form: "24Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 6000 },
    { form: "26QE", quarter: "Q2", filedDate: "20251015", tdsAmount: 4000 },
  ],
  tan: "MUMS12345A",
  tcsSections: [
    { ledger: "TCS Receivable", nature: "Scrap" },
    { ledger: "Scrap Sales", nature: "Scrap" },
  ],
  interestPaid: [{ form: "24Q", quarter: "Q1", amount: 100, paidOn: "20250801" }],
};

const BUNDLE_MASTERS = {
  groups: [
    { name: "Purchase Accounts", parent: " Primary" },
    { name: "Sales Accounts", parent: " Primary" },
    { name: "Sundry Creditors", parent: "Current Liabilities" },
    { name: "Current Liabilities", parent: " Primary" },
    { name: "Duties & Taxes", parent: " Primary" },
    { name: "Bank Accounts", parent: "Current Assets" },
    { name: "Current Assets", parent: " Primary" },
  ],
  ledgers: [
    { name: "Sample Builders LLP", parent: "Sundry Creditors" },
    { name: "Sample Consultants", parent: "Sundry Creditors" },
    { name: "Site Repairs Contract", parent: "Purchase Accounts" },
    { name: "Professional Fees", parent: "Purchase Accounts" },
    { name: "TDS Contractors", parent: "Duties & Taxes" },
    { name: "TDS Professional Fees", parent: "Duties & Taxes" },
    { name: "TCS Receivable", parent: "Duties & Taxes" },
    { name: "TCS Other", parent: "Duties & Taxes" },
    { name: "Scrap Sales", parent: "Sales Accounts" },
    { name: "Bank", parent: "Bank Accounts" },
  ],
};

const reviewSession = async () => {
  const s = createSession(
    fakeDownstream({ tally_get_ledgers: MASTERS }),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
    { tdsRound100: false },
  );
  const dayBook = readDayBook(
    JSON.stringify({
      tallyAgentExport: 1,
      fromDate: "20250401",
      toDate: "20260331",
      ...BUNDLE_MASTERS,
      vouchers: VOUCHERS,
    }),
    { fromDate: "20250401", toDate: "20260331" },
  );
  const result = await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json", undefined, dayBook);
  return { s, result };
};

describe("tdsReview clause-34 wiring", () => {
  it("produces the counts-and-amounts preview from the day-book bundle", async () => {
    const { result } = await reviewSession();
    expect(result.tds3cd?.sheets).toEqual({
      tds: 2,
      tcs: 1,
      returns: 2,
      interestTds: 1,
      interestTcs: 1,
    });
    expect(result.tds3cd?.totals).toEqual({
      tdsNotDeposited: money(0),
      tcsNotDeposited: money(3000),
      interestPayable: money(270 + 225),
    });
    expect(result.tds3cd?.skippedInterestQuarters).toEqual(["Q2:26QE"]);
    expect(JSON.stringify(result.tds3cd)).not.toMatch(/MUMS12345/);
    expect(JSON.stringify(result.tds3cd)).not.toMatch(/Sample|Scrap|TCS Receivable/);
  });

  it("caches the full slice for tds3cdResult with no 194Q rows", async () => {
    const { s } = await reviewSession();
    const cached = s.tds3cdResult();
    expect(cached).toBeDefined();
    expect(cached?.tan).toBe("MUMS12345A");
    expect(cached?.tds.map((r) => r.section)).toEqual(["194C", "194J"]);
    expect(cached?.tds[0]).toMatchObject({
      totalPayments: 300000,
      sumLiable: 300000,
      atRateLiable: 300000,
      atRateTds: 6000,
      lowerRateLiable: 0,
      lowerRateTds: 0,
      notDeposited: 0,
    });
    // certificate-rate 194J into the lower bucket
    expect(cached?.tds[1]).toMatchObject({
      sumLiable: 200000,
      atRateLiable: 0,
      atRateTds: 0,
      lowerRateLiable: 200000,
      lowerRateTds: 4000,
      notDeposited: 0,
    });
    expect(cached?.tcs).toEqual([
      {
        collector: "",
        nature: "Scrap",
        totalReceipt: 300000,
        sumLiable: 300000,
        atRateLiable: 300000,
        atRateTcs: 3000,
        lowerRateLiable: 0,
        lowerRateTcs: 0,
        notDeposited: 3000,
      },
    ]);
    expect(cached?.returns.map((r) => [r.form, r.quarter, r.dueDate, r.filedOn, r.accurate])).toEqual([
      ["24Q", "Q1", "20250731", "20250731", "Yes"],
      ["26QE", "Q2", "20251031", "20251015", "Yes"],
    ]);
    expect(cached?.interestTds).toEqual([
      { form: "24Q", quarter: "Q1", payable: 270, paid: 100, paidOn: "20250801" },
    ]);
    expect(cached?.interestTcs).toEqual([{ form: "27EQ", quarter: "Q3", payable: 225 }]);
    expect(cached?.skippedInterestQuarters).toEqual(["Q2:26QE"]);
  });

  it("raises a review finding on a participating TCS ledger whose nature stays unresolved", async () => {
    const { result } = await reviewSession();
    const f = result.findings.find((x) => x.check === "tcs_unclassified_ledger");
    expect(f?.severity).toBe("review");
    expect(f?.detail).not.toMatch(/TCS Other/);
  });
});

// ---- writer ---------------------------------------------------------------

describe("write3cdTdsTcs", () => {
  it("refuses before any tdsReview ran", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tds3cd-"));
    const source = join(dir, "winman-3cd.xlsm");
    await writeFile(source, makeTdsTcsFixture().buf);
    const s = createSession(
      fakeDownstream({ tally_get_ledgers: MASTERS }),
      EMPTY_OVERRIDES,
      EMPTY_WRONG_GROUP,
      { tdsRound100: false },
    );
    await expect(s.write3cdTdsTcs({ sourcePath: source })).rejects.toThrow(/tb_tds_review/i);
  });

  it("refuses to write over its own source workbook", async () => {
    const { session, fixture } = await writerSetup();
    await expect(
      session.write3cdTdsTcs({ sourcePath: fixture.source, outPath: fixture.source }),
    ).rejects.toThrow(/resolves to the source workbook itself/);
  });

  it("writes a 3cdTDS copy that re-reads with readSchema", async () => {
    const { session, fixture } = await writerSetup();
    const target = await session.write3cdTdsTcs({ sourcePath: fixture.source, outPath: fixture.out });
    expect(target).not.toBe(fixture.source);
    expect(existsSync(target)).toBe(true);
    const pkg = readXlsm(await readFile(target, null));
    expect(readSchema(pkg, "TDS").formId).toBe("3cdTDS");
    expect(readSchema(pkg, "TCS").formId).toBe("3cdTDS");
    expect(readSchema(pkg, "Return details").formId).toBe("3cdTDS");
    expect(readSchema(pkg, "Interest on TDS").formId).toBe("3cdTDS");
    expect(readSchema(pkg, "Interest on TCS").formId).toBe("3cdTDS");
    const tdsPart = partText(pkg, "xl/worksheets/sheet1.xml");
    expect(tdsPart).toContain('<row r="7"');
    expect(tdsPart).toContain("194C");
    const tcsPart = partText(pkg, "xl/worksheets/sheet2.xml");
    expect(tcsPart).not.toContain('<c r="C7"');
    expect(tcsPart).toContain("Scrap");
    expect(partText(pkg, "xl/worksheets/sheet3.xml")).toMatch(/<c r="D7"[^>]*><v>1<\/v><\/c>/);
    const interestTcs = partText(pkg, "xl/worksheets/sheet5.xml");
    expect(interestTcs).toContain("27EQ");
    expect(interestTcs).toMatch(/<c r="C7"[^>]*t="inlineStr"/);
  });
});

// ---- helpers ---------------------------------------------------------------

async function writerSetup() {
  const dir = await mkdtemp(join(tmpdir(), "tds3cd-"));
  const outDir = join(dir, "out");
  await mkdir(outDir, { recursive: true });
  const source = join(dir, "winman-3cd.xlsm");
  await writeFile(source, makeTdsTcsFixture().buf);
  const { s } = await reviewSession();
  return { session: s, fixture: { source, out: outDir } };
}
