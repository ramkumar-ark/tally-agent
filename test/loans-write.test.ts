import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { buildLoansTemplateWorkbook } from "../src/loans-file.js";
import { buildWorkbook } from "../src/xlsx.js";
import { makeLoansWinmanFixture, makeWinmanFixture } from "./fixtures/winman-fixture.js";
import { readXlsm, partText } from "../src/xlsm.js";
import { readSchema } from "../src/winman3cd.js";

// Synthetic ledgers and figures only: the real operator's loan ledgers, party
// names, PANs and addresses never appear in the repo (captain ruling).
// The cache is populated by a REAL Session.loansReview run over a stubbed
// downstream and a day-book bundle — write3cdLoans reads the session's raw
// cache closure, so the test must drive the same path a real tool call does.

const LEDGERS = [
  { name: "Trust Cash", parent: "Loans (Liability)" },
  { name: "Trust Mapped", parent: "Loans (Liability)" },
  { name: "Trust Declared", parent: "Loans (Liability)" },
  { name: "Cash", parent: "Cash-in-Hand" },
  { name: "Axle Client", parent: "Sundry Debtors" },
];
const GROUPS = [
  { name: "Loans (Liability)", parent: "\u0004 Primary" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Current Assets", parent: "\u0004 Primary" },
  { name: "Sundry Debtors", parent: "Current Assets" },
];

// File amounts follow the day-book raw sign (negative = debit); the reader
// flips once at load, so the engine sees positive = debit.
const VOUCHERS = [
  // Trust Cash cash acceptance 25,000 — plain 269SS breach row (sheet 1,
  // non-ac payee, no PAN/address anywhere).
  {
    date: "2025-04-15", voucherType: "Journal", voucherNumber: "J-1",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -25000 }, { LEDGERNAME: "Trust Cash", AMOUNT: 25000 }],
  },
  // Trust Mapped cash acceptance 25,000 — overridden to a/c payee by template.
  {
    date: "2025-04-20", voucherType: "Journal", voucherNumber: "J-2",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -25000 }, { LEDGERNAME: "Trust Mapped", AMOUNT: 25000 }],
  },
  // Trust Declared cash repayment 25,000 — Cash-breach-declared: rides BOTH
  // sheet 3 (whose Winman sheet the fixture does not carry) and sheet 4.
  {
    date: "2025-05-15", voucherType: "Payment", voucherNumber: "P-1",
    entries: [{ LEDGERNAME: "Trust Declared", AMOUNT: -25000 }, { LEDGERNAME: "Cash", AMOUNT: 25000 }],
  },
  // Axle Client cash receipt 2,05,000 — 269ST receipt register row, dated
  // 2025-07-01 (Excel serial 45839), narration becomes the NATURE text.
  {
    date: "2025-07-01", voucherType: "Receipt", voucherNumber: "R-1",
    narration: "cash against truck hire deposit",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -205000 }, { LEDGERNAME: "Axle Client", AMOUNT: 205000 }],
  },
];

const REAL_PAN = "AAACM1234E";
const REAL_ADDRESS = "12, Subhash Road, Metropolis";
const REAL_ADDRESS_B = "34 Invented Road";

const BUNDLE = {
  tallyAgentExport: true,
  company: "Sample Co",
  groups: GROUPS,
  ledgers: LEDGERS,
  vouchers: VOUCHERS,
};

const PHASE = { fromDate: "20250401", toDate: "20260331" };

const rejectWith = (why: string) => async () => {
  throw new Error(why);
};

async function bundlePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loans-write-bundle-"));
  const p = join(dir, "daybook-bundle.json");
  await writeFile(p, JSON.stringify(BUNDLE), "utf8");
  return p;
}

async function templatePath(): Promise<string> {
  const { sheets } = buildLoansTemplateWorkbook(
    LEDGERS.map((l) => ({ name: l.name })).filter((p) =>
      ["Trust Cash", "Trust Mapped", "Trust Declared"].includes(p.name),
    ),
    {},
  );
  // Parties columns: Tally ledger, PAN or Aadhaar, Address, Exempt,
  // Mode accepted, Mode repaid.
  sheets[0].rows = [
    ["Trust Mapped", REAL_PAN, REAL_ADDRESS, "", "A/c payee Cheque", ""],
    ["Trust Declared", "", REAL_ADDRESS_B, "", "", "Cash-breach-declared"],
  ];
  const dir = await mkdtemp(join(tmpdir(), "loans-write-template-"));
  const p = join(dir, "loans-template.xlsx");
  await writeFile(p, buildWorkbook(sheets));
  return p;
}

/** A session whose loans cache is populated by a real review run. */
async function sessionWithCache() {
  const stub = Object.assign(fakeDownstream(), {
    groups: rejectWith("no live tally"),
    ledgers: rejectWith("no live tally"),
  } as never);
  const session = createSession(stub, EMPTY_OVERRIDES);
  const result = await session.loansReview({
    ...PHASE,
    dayBookPath: await bundlePath(),
    templatePath: await templatePath(),
  });
  // The run really produced the rows this test writes.
  expect(result.sheets.sheet1).toBe(2);
  expect(result.sheets.sheet3).toBe(1);
  expect(result.sheets.sheet4).toBe(1);
  expect(result.sheets.sheet6).toBe(1);
  return session;
}

function withSource(opts: { formId?: string } = {}): { dir: string; sourcePath: string; source: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "loans-write-"));
  const sourcePath = join(dir, "Loans Deposits 269SS & 269T.xlsm");
  const source = makeLoansWinmanFixture(opts);
  writeFileSync(sourcePath, source);
  return { dir, sourcePath, source };
}

describe("Session.write3cdLoans", () => {
  it("writes the cached rows demasked into the non-empty sheets, rows at C1", async () => {
    const { dir, sourcePath, source } = withSource();
    const session = await sessionWithCache();
    const { written: out } = await session.write3cdLoans({ sourcePath, outPath: dir });
    expect(out.endsWith(".xlsm")).toBe(true);
    expect(out.startsWith(dir)).toBe(true);
    expect(/ - filled - \d{8}\.xlsm$/.test(out)).toBe(true);
    // The source workbook is never touched.
    expect(readFileSync(sourcePath).equals(source)).toBe(true);

    const pkg = readXlsm(readFileSync(out));
    expect(readSchema(pkg, "Sec.269SS Loans & Deposits").formId).toBe("269SS/269T_LoansAc/RpinCash");

    // Sheet 1: data rows start at C1 (8). Both acceptance rows are 25,000, so
    // amount-ties order by party: Trust Cash first, Trust Mapped second.
    const s1 = readSchema(pkg, "Sec.269SS Loans & Deposits");
    expect(s1.firstDataRow).toBe(8);
    const sheet1 = partText(pkg, s1.partName);
    expect(sheet1).toContain('t="inlineStr"');
    // Real values ride the on-disk operator artifact — never vault aliases.
    expect(sheet1).toContain("Trust Cash");
    expect(sheet1).toContain("Trust Mapped");
    expect(sheet1).toContain(REAL_PAN);
    expect(sheet1).toContain(REAL_ADDRESS);
    expect(sheet1).not.toContain("TaxId ");
    expect(sheet1).not.toContain("Ledger ");
    // Byte-exact mode tokens: the plain cash row is the non-ac payee breach,
    // the mapped row carries the template's a/c payee override.
    expect(sheet1).toContain("Non-A/c payee modes");
    expect(sheet1).toContain(">Cash<");
    expect(sheet1).toContain(">A/c payee Cheque<");
    expect(sheet1).toContain("<v>25000</v>");
    // Blank cells omitted: Trust Cash has no PAN or address, so its row
    // (r=8) carries no B/H cells; Trust Mapped's row (r=9) does.
    expect(sheet1).not.toContain('r="B8"');
    expect(sheet1).not.toContain('r="H8"');
    expect(sheet1).toContain('r="B9"');
    expect(sheet1).toContain('r="H9"');
    expect(sheet1).not.toContain('r="G9"');

    // Sheet 4 ("Sec.269T Repayments Others"): the Cash-breach-declared row
    // keeps the 4-column shape — no PAN column was mapped, so the PAN cell
    // is omitted entirely, and no mode/movement field fabricates a column
    // this sheet does not define.
    const s4 = readSchema(pkg, "Sec.269T Repayments Others");
    expect([...s4.keys.keys()].sort()).toEqual([
      "ADDRESS",
      "AMOUNT",
      "NAME",
      "PANORAADHAAR",
    ]);
    const sheet4 = partText(pkg, s4.partName);
    expect(sheet4).toContain("Trust Declared");
    expect(sheet4).toContain("<v>25000</v>");
    expect(sheet4).toContain(REAL_ADDRESS_B);
    expect(sheet4).not.toContain(REAL_PAN);
    expect(sheet4).not.toContain("TaxId ");
    expect(sheet4).not.toContain("Non-A/c payee modes");
    expect(sheet4).not.toContain("SQUAREDUP");
    // One data row only: the fixture's own old rows 8 and 9 are replaced.
    expect(sheet4).not.toContain('<row r="9"');

    // Sheet 6 ("Sec.269ST_others"): date written as a serial, TYPE/NATURE real.
    const s6 = readSchema(pkg, "Sec.269ST_others");
    expect(s6.firstDataRow).toBe(9);
    const sheet6 = partText(pkg, s6.partName);
    // 2025-07-01 -> Excel serial 45839 (days since 1899-12-30).
    expect(sheet6).toContain("<v>45839</v>");
    expect(sheet6).toContain("<v>205000</v>");
    expect(sheet6).toContain("Axle Client");
    expect(sheet6).toContain(">Receipts<");
    expect(sheet6).toContain("cash against truck hire deposit");
    // No PAN or address was mapped for the receipt party.
    expect(sheet6).not.toContain('r="B9"');
    expect(sheet6).not.toContain('r="G9"');
    expect(sheet6).not.toContain('<row r="10"');

    // The Cash-breach-declared repayment ALSO produced a sheet-3 row, but
    // the fixture carries no "sec.269T" sheet: it was skipped, not invented.
    expect(() => readSchema(pkg, "sec.269T")).toThrow(/no sheet named/);
  });

  it("refuses to run with no cached loans review", async () => {
    const { dir, sourcePath } = withSource();
    const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    await expect(session.write3cdLoans({ sourcePath, outPath: dir })).rejects.toThrow(
      /run tb_loans_review first/,
    );
  });

  it("refuses an outPath that resolves onto the source workbook itself", async () => {
    const { dir, sourcePath, source } = withSource();
    const session = await sessionWithCache();
    await expect(
      session.write3cdLoans({ sourcePath, outPath: sourcePath }),
    ).rejects.toThrow(/resolves to the source workbook/);
    // A dot-dotted, spelt-differently alias of the same target refuses too.
    await expect(
      session.write3cdLoans({ sourcePath, outPath: join(dir, ".", "Loans Deposits 269SS & 269T.xlsm") }),
    ).rejects.toThrow(/resolves to the source workbook/);
    // The template survives both refusals byte-identical.
    expect(readFileSync(sourcePath).equals(source)).toBe(true);
  });

  it("refuses a workbook that carries none of the clause-31 sheets", async () => {
    const { dir, sourcePath } = withSource();
    const session = await sessionWithCache();
    // The P.F./E.S.I. fixture passes the INTER handshake but carries no
    // Sec.269SS/269T/269ST sheet: a silent untouched copy must never be
    // written under a "filled" name.
    const pfPath = join(dir, "PF ESI funds.xlsm");
    writeFileSync(pfPath, makeWinmanFixture());
    await expect(session.write3cdLoans({ sourcePath: pfPath, outPath: dir })).rejects.toThrow(
      /none of the Sec\.269SS\/269T\/269ST sheets/,
    );
  });

  it("refuses a clause-31 sheet whose form id is not the loans form", async () => {
    // Cheap corruption path: the fixture builder swaps shared string 0 (the
    // A1 form id every data sheet references) without re-zipping sheet XML.
    // The P.F. form id is the real wrong-form value the PF/ESI writer pins.
    const { dir, sourcePath } = withSource({ formId: "EmployeePFESIfunds" });
    const session = await sessionWithCache();
    // Sheet 1 has cached rows, so the formId assert fires before any write.
    await expect(session.write3cdLoans({ sourcePath, outPath: dir })).rejects.toThrow(
      /Sec\.269SS Loans & Deposits belongs to form "EmployeePFESIfunds": this tool fills the Winman 269SS\/269T\/269ST loans workbook/,
    );
  });

  it("warns on stderr for every non-empty cached sheet the workbook lacks", async () => {
    const { dir, sourcePath, source } = withSource();
    const session = await sessionWithCache();
    const stderr: string[] = [];
    const err = console.error;
    console.error = (msg: string) => stderr.push(msg);
    try {
      await session.write3cdLoans({ sourcePath, outPath: dir });
    } finally {
      console.error = err;
    }
    // Sheet 3 ("sec.269T") is absent from the fixture and carries the
    // Cash-breach-declared repayment row: skipped with a warning, loudly.
    const warned = stderr.filter((m) => m.includes("sec.269T"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(
      "tally-agent: loans sheet sec.269T not found in the source workbook — 1 cached rows not written",
    );
    // The fill still completed for the sheets the workbook does carry, and
    // the source stayed byte-identical.
    expect(readFileSync(sourcePath).equals(source)).toBe(true);
  });
});
