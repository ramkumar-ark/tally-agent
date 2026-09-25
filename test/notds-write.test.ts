import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { partText, readXlsm, replacePart, writeXlsm } from "../src/xlsm.js";
import { readSchema } from "../src/winman3cd.js";
import { makeNotdsFixture, NOTDS_PARTS } from "./fixtures/winman-fixture.js";
import type { NotdsDecision, NotdsOperatorFile } from "../src/notds-file.js";
import { canonicalKey } from "../src/key.js";
import { NOTDS_FORM_ID } from "../src/notds.js";

/**
 * write3cdNoTds over the synthetic No TDS Disallowance.xlsm fixture
 * (design of record: docs/design/2026-09-24-no-tds-disallowance-design.md §3).
 * One row per sheet — including the Winman `194I (a)` spelling (Focus #6) —
 * the sheet4 row at firstDataRow 8 with no D–G keys written, byte-pristine
 * zero-row sheets (Focus #4), the named-form guard, and the rows decoding
 * back through the reader. Every name and PAN in the flow is invented; the
 * workbook copy on the operator's disk is where real names belong, so none
 * of this test writes any tool-facing JSON.
 */

const MASTERS = JSON.stringify([
  { name: "Office Rent", parent: "Indirect Expenses", IsTDSApplicable: "Yes" },
  { name: "TDS Contractors", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  { name: "Ledger Held LLP", parent: "Sundry Creditors", IncomeTaxNumber: "LEDGF1234A", IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
]);

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: "Office Rent", section: "194-I(a)" },
    { ledger: "TDS Contractors", section: "194-I(a)" },
  ],
  parties: [{ ledger: "Ledger Held LLP", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false }],
};

const booking = (amount: number) => ({ date: "2025-09-10", voucherType: "Purchase", voucherNumber: "R/1", amount, partyLedgerName: "Ledger Held LLP" });

const mkSession = (bookings: ReturnType<typeof booking>[] = []) => {
  const s = createSession(
    Object.assign(fakeDownstream({ tally_get_ledgers: MASTERS }), {
      ledgerVoucherRows: async (_c: unknown, ledgerName: string, f: string, t: string) => {
        const list = String(ledgerName).toLowerCase() === "office rent"
          ? bookings.filter((v) => { const d = v.date.replace(/-/g, ""); return d >= f && d <= t; })
          : [];
        return {
          rows: list.map((v) => ({
            date: v.date.replace(/-/g, ""),
            voucherType: v.voucherType,
            voucherNumber: v.voucherNumber,
            reference: "",
            counterparty: v.partyLedgerName,
            amount: v.amount,
            matchStatus: "matched" as const,
            tax: null,
          })),
          dropped: 0,
        } as never;
      },
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );
  return s;
};

const NR_KEY = `${canonicalKey("Ledger Held LLP")}|20250910|R/1|194-I(a)`;

const decision = (key: string, over: Partial<NotdsDecision> = {}): NotdsDecision => ({
  key,
  include: true,
  residency: "NR",
  nrSection: "195",
  ...over,
});

const LEVY_MANUAL: NotdsOperatorFile["manual"][number] =
  { sheet: "40(a)(ib) - Equalisation Levy", party: "Overseas Ads GmbH", date: "20260120", amount: 250000, deducted: 0, deposited: 0 };
const SALARY_MANUAL: NotdsOperatorFile["manual"][number] =
  { sheet: "40(a)(iii)", party: "Payroll Abroad GmbH", date: "20260205", amount: 40000, deducted: 0, deposited: 0 };

const tmpDir = () => mkdtempSync(join(tmpdir(), "tally-agent-notds-w-"));

describe("write3cdNoTds", () => {
  it("fills one row per sheet from the cached review and counts them", async () => {
    const dir = tmpDir();
    const sourcePath = join(dir, "No TDS Disallowance.xlsm");
    writeFileSync(sourcePath, makeNotdsFixture());
    const s = mkSession([booking(300000)]);
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    await s.noTdsReview({
      operator: {
        decisions: new Map([[NR_KEY, decision(NR_KEY)]]),
        manual: [LEVY_MANUAL, SALARY_MANUAL],
      },
    });
    const outDir = join(dir, "filled");
    const w = await s.write3cdNoTds({ sourcePath, outPath: outDir });
    expect(w.rowsBySheet["40(a)(ia) to resident"]).toBe(0);
    expect(w.rowsBySheet["40(a)(i) to non-resident"]).toBe(1);
    expect(w.rowsBySheet["40(a)(ib) - Equalisation Levy"]).toBe(1);
    expect(w.rowsBySheet["40(a)(iii)"]).toBe(1);
    expect(w.path).toMatch(/ - filled - \d{8}\.xlsm$/);
    expect(w.path).toContain(outDir);
    expect(w.path.split("/").pop()!).toContain(" - filled - ");
  });

  it("writes the Winman 194I (a) spelling into the TDSSECTION cell (Focus #6)", async () => {
    const dir = tmpDir();
    const sourcePath = join(dir, "No TDS Disallowance.xlsm");
    writeFileSync(sourcePath, makeNotdsFixture());
    const s = mkSession([booking(300000)]);
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    await s.noTdsReview({});
    const w = await s.write3cdNoTds({ sourcePath, outPath: join(dir, "out.xlsm") });
    const xml = partText(readXlsm(await readFile(w.path)), NOTDS_PARTS.resident);
    const row = xml.match(/<row r="7".*?<\/row>/s)![0];
    expect(row).toContain("194I (a)");
    expect(row).not.toContain("194-I(a)");
  });

  it("lands a sheet4 row at row 8 with no D–G keys written", async () => {
    const dir = tmpDir();
    const sourcePath = join(dir, "No TDS Disallowance.xlsm");
    writeFileSync(sourcePath, makeNotdsFixture());
    const s = mkSession([]);
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    await s.noTdsReview({ operator: { decisions: new Map(), manual: [SALARY_MANUAL] } });
    const w = await s.write3cdNoTds({ sourcePath, outPath: join(dir, "out.xlsm") });
    const pkg = readXlsm(await readFile(w.path));
    const s4 = readSchema(pkg, "40(a)(iii)");
    expect(s4.formId).toBe(NOTDS_FORM_ID);
    expect(s4.firstDataRow).toBe(8);
    const row = partText(pkg, NOTDS_PARTS.salary).match(/<row r="8".*?<\/row>/s)![0];
    for (const col of ["D8", "E8", "F8", "G8"]) {
      expect(row).not.toContain(`r="${col}"`);
    }
    expect(row).toContain("Payroll Abroad GmbH");
  });

  it("leaves a zero-row sheet's part byte-identical to the fixture's (Focus #4)", async () => {
    const dir = tmpDir();
    const sourcePath = join(dir, "No TDS Disallowance.xlsm");
    writeFileSync(sourcePath, makeNotdsFixture());
    const s = mkSession([booking(300000)]);
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    await s.noTdsReview({});
    const w = await s.write3cdNoTds({ sourcePath, outPath: join(dir, "out.xlsm") });
    const written = readXlsm(await readFile(w.path));
    const fresh = readXlsm(makeNotdsFixture());
    for (const part of [NOTDS_PARTS.levy, NOTDS_PARTS.nonResident]) {
      expect(partText(written, part)).toBe(partText(fresh, part));
    }
    for (const name of ["xl/vbaProject.bin", "xl/vbaProjectSignature.bin", "xl/media/image1.jpeg"]) {
      const a = fresh.entries.find((e) => e.name === name)!, b = written.entries.find((e) => e.name === name)!;
      expect(b.data.equals(a.data)).toBe(true);
    }
  });

  it("written rows decode back through the reader", async () => {
    const dir = tmpDir();
    const sourcePath = join(dir, "No TDS Disallowance.xlsm");
    writeFileSync(sourcePath, makeNotdsFixture());
    const s = mkSession([booking(300000)]);
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    await s.noTdsReview({});
    const w = await s.write3cdNoTds({ sourcePath, outPath: join(dir, "out.xlsm") });
    const pkg = readXlsm(await readFile(w.path));
    const sc = readSchema(pkg, "40(a)(ia) to resident");
    expect(sc.formId).toBe(NOTDS_FORM_ID);
    expect(sc.firstDataRow).toBe(7);
    const row = partText(pkg, NOTDS_PARTS.resident).match(/<row r="7".*?<\/row>/s)![0];
    expect(row).toContain("Ledger Held LLP");
    expect(row).toContain("194I (a)");
    expect(() => readSchema(readXlsm(writeXlsm(pkg)), "40(a)(ia) to resident")).not.toThrow();
  });

  it("refuses a workbook whose sheet belongs to another Winman form", async () => {
    const dir = tmpDir();
    const fresh = readXlsm(makeNotdsFixture());
    const wrong = replacePart(
      fresh,
      "xl/sharedStrings.xml",
      partText(fresh, "xl/sharedStrings.xml").replace("3cdNoTDS", "3cdNoTDSx"),
    );
    const wrongPath = join(dir, "wrong.xlsm");
    await writeFile(wrongPath, writeXlsm(wrong));
    const s = mkSession([booking(300000)]);
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    await s.noTdsReview({});
    await expect(
      s.write3cdNoTds({ sourcePath: wrongPath, outPath: join(dir, "o.xlsm") }),
    ).rejects.toThrow(/this tool fills the Winman 3cdNoTDS workbook/);
  });

  it("refuses the source as its own target", async () => {
    const dir = tmpDir();
    const sourcePath = join(dir, "No TDS Disallowance.xlsm");
    writeFileSync(sourcePath, makeNotdsFixture());
    const s = mkSession([booking(300000)]);
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    await s.noTdsReview({});
    await expect(s.write3cdNoTds({ sourcePath, outPath: sourcePath })).rejects.toThrow(/resolves to the source/);
  });
});
