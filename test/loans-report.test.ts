import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { buildLoansTemplateWorkbook } from "../src/loans-file.js";
import { buildWorkbook } from "../src/xlsx.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { loansSheets, writeLoansReport } from "../src/report.js";
import { createVault } from "../src/vault.js";
import { LOANS_SHEET_NAMES, type LoansReviewResult } from "../src/loans.js";

// Synthetic ledgers and figures only: the real operator's loan ledgers, party
// names, PANs and addresses never appear in the repo (captain ruling).

const LEDGERS = [
  { name: "Metro Finance", parent: "Loans (Liability)" },
  { name: "Neighbour Trust", parent: "Loans (Liability)" },
  { name: "Cash", parent: "Cash-in-Hand" },
  { name: "Axis Bank", parent: "Bank Accounts" },
  { name: "Wholesale Client", parent: "Sundry Debtors" },
];
const GROUPS = [
  { name: "Loans (Liability)", parent: "\u0004 Primary" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Bank Accounts", parent: "Current Assets" },
  { name: "Current Assets", parent: "\u0004 Primary" },
  { name: "Sundry Debtors", parent: "Current Assets" },
];
const VOUCHERS = [
  // Neighbour Trust cash acceptance 25,000 — 269SS breach
  {
    date: "2025-04-15", voucherType: "Journal", voucherNumber: "J-1",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -25000 }, { LEDGERNAME: "Neighbour Trust", AMOUNT: 25000 }],
  },
  // Metro Finance bank repayment 30,000 — no breach, sheet-3 row
  {
    date: "2026-02-15", voucherType: "Payment", voucherNumber: "P-1",
    entries: [{ LEDGERNAME: "Metro Finance", AMOUNT: -30000 }, { LEDGERNAME: "Axis Bank", AMOUNT: 30000 }],
  },
  // Wholesale Client cash receipt 2,05,000 — 269ST receipt register
  {
    date: "2025-07-01", voucherType: "Receipt", voucherNumber: "R-1",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -205000 }, { LEDGERNAME: "Wholesale Client", AMOUNT: 205000 }],
  },
];
const BUNDLE = {
  tallyAgentExport: true,
  company: "Sample Co",
  groups: GROUPS,
  ledgers: LEDGERS,
  vouchers: VOUCHERS,
};
const PHASE = { fromDate: "20250401", toDate: "20260331" };

const REAL_PAN = "AAACM1234E";
const REAL_ADDRESS = "12, Subhash Road, Metropolis";

const rejectWith = (why: string) => async () => {
  throw new Error(why);
};

async function bundlePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loans-report-bundle-"));
  const p = join(dir, "daybook-bundle.json");
  await writeFile(p, JSON.stringify(BUNDLE), "utf8");
  return p;
}

async function templatePath(): Promise<string> {
  const { sheets } = buildLoansTemplateWorkbook(
    LEDGERS.filter((l) => ["Metro Finance", "Neighbour Trust"].includes(l.name)).map((l) => ({ name: l.name })),
    {},
  );
  sheets[0].rows = [["Metro Finance", REAL_PAN, REAL_ADDRESS, "", "A/c payee Cheque", ""]];
  const dir = await mkdtemp(join(tmpdir(), "loans-report-template-"));
  const p = join(dir, "loans-template.xlsx");
  await writeFile(p, buildWorkbook(sheets));
  return p;
}

/** A session whose live calls reject (offline day-book runs). */
function offlineHarness() {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _d, _s, handler) => tools.set(name, handler);
  const stub = Object.assign(fakeDownstream(), {
    groups: rejectWith("no live tally"),
    ledgers: rejectWith("no live tally"),
  } as never);
  const session = createSession(stub, EMPTY_OVERRIDES);
  const cfg = { reportDir: mkdtempSync(join(tmpdir(), "loans-report-")), dayBookMaxBytes: 64 * 1_048_576 };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  return { tools, session, cfg };
}

const values = (name: string, wb: ReturnType<typeof readWorkbook>): string[] =>
  (wb.find((s) => s.name === name)?.rows ?? [])
    .flatMap((r) => [...r.cells.values()].map((c) => String(c.value ?? "")));

const serialized = (x: unknown): string => JSON.stringify(x);

describe("loansSheets", () => {
  it("produces Findings + the three family sheets with the brief's columns", () => {
    const result: LoansReviewResult = {
      company: "Sample Co",
      fromDate: "20250401",
      toDate: "20260331",
      findings: [{
        id: "LS-019-1", check: "loans_cash_acceptance", severity: "critical",
        ledger: "Ledger 1", group: "", amount: 25000, side: null, expected: null,
        detail: "Cash acceptance from Ledger 1 of 25,000.00 breaches s.269SS.",
      }],
      rows: [
        { party: "Ledger 1", panAlias: "TaxId 1", amount: 25000, squaredUp: "No", maxAmount: 25000, mode: "Non-A/c payee modes", nonAcMode: "Cash" },
        { party: "Ledger 2", amount: 30000, squaredUp: "Yes", maxAmount: 30000, mode: "A/c payee Cheque" },
        { party: "Ledger 3", amount: 205000, type: "Receipts", date: "01-Jul-2025", nature: "loan received" },
      ],
      sheets: { sheet1: 1, sheet2: 0, sheet3: 1, sheet4: 0, sheet5: 0, sheet6: 1, sheet7: 0 },
    } as never;
    const sheets = loansSheets(result as never);
    expect(sheets.map((s) => s.name)).toEqual(["Findings", "269SS", "269T", "269ST"]);
    const byName = new Map(sheets.map((s) => [s.name, s]));
    expect((byName.get("269SS")!.columns ?? []).map((c) => c.header)).toEqual(
      ["Party", "PAN alias", "Amount", "Mode", "Address", "Squared up", "Max amount", "Non-A/c mode"],
    );
    expect((byName.get("269T")!.columns ?? []).map((c) => c.header)).toEqual(
      ["Party", "PAN alias", "Amount", "Mode", "Address", "Squared up", "Max amount", "Non-A/c mode"],
    );
    expect((byName.get("269ST")!.columns ?? []).map((c) => c.header)).toEqual(
      ["Party", "Amount", "Type", "Date", "Nature", "Bearer"],
    );
    // Rows split by the sheet counts: 269SS carries sheet1, 269T carries sheet3.
    expect(byName.get("269SS")!.rows).toEqual([
      ["Ledger 1", "TaxId 1", 25000, "Non-A/c payee modes", "", "No", 25000, "Cash"],
    ]);
    expect(byName.get("269T")!.rows).toEqual([
      ["Ledger 2", "", 30000, "A/c payee Cheque", "", "Yes", 30000, ""],
    ]);
    expect(byName.get("269ST")!.rows).toEqual([
      ["Ledger 3", 205000, "Receipts", "01-Jul-2025", "loan received", ""],
    ]);
    // Amount cells stay numbers; no bare 6+-digit string is born here.
    expect(byName.get("269ST")!.rows[0]![1]).toBe(205000);
    expect(serialized(byName.get("Findings")!.rows[0])).toContain("Ledger 1");
    // Titles: period line, sheet labels, rows/total line.
    const title = byName.get("269SS")!.title ?? [];
    expect(title[0]).toContain("01-Apr-2025 to 31-Mar-2026");
    expect(title[1]).toContain("s.269SS");
    expect(title[2]).toContain("Rows: 1");
  });

  it("degrades without a period", () => {
    const sheets = loansSheets({
      findings: [], rows: [],
      sheets: { sheet1: 0, sheet2: 0, sheet3: 0, sheet4: 0, sheet5: 0, sheet6: 0, sheet7: 0 },
    } as never);
    expect(sheets).toHaveLength(4);
    expect((sheets[1]!.title ?? [])[0]).toContain("269ST review");
  });
});

describe("writeLoansReport — masked channel de-masks via the vault", () => {
  it("the on-disk workbook carries real names, PAN and dates", async () => {
    const vault = createVault();
    const ledgerN = vault.pseudonym("Metro Finance", "ledger");
    const taxIdN = vault.pseudonym(REAL_PAN, "tax_id");
    const masked: LoansReviewResult = {
      company: "Sample Co",
      fromDate: "20250401",
      toDate: "20260331",
      findings: [],
      rows: [
        { party: ledgerN, panAlias: taxIdN, amount: 25000, squaredUp: "No", maxAmount: 25000, mode: "Non-A/c payee modes", nonAcMode: "Cash" },
        { party: "Ledger 3", amount: 205000, type: "Receipts", date: "01-Jul-2025", nature: "loan received" },
      ],
      sheets: { sheet1: 1, sheet2: 0, sheet3: 0, sheet4: 0, sheet5: 0, sheet6: 1, sheet7: 0 },
    } as never;
    const reportDir = mkdtempSync(join(tmpdir(), "loans-report-write-"));
    const { workbookPath } = await writeLoansReport({
      reportDir, result: masked as never, vault: vault as never,
    });
    expect(workbookPath).toMatch(/loans-review-sample-co-20250401-20260331\.xlsx$/);
    expect(existsSync(workbookPath)).toBe(true);
    const wb = readWorkbook(await readFile(workbookPath));
    // The masked party and the PAN alias read back real on disk.
    expect(values("269SS", wb)).toContain("Metro Finance");
    expect(values("269SS", wb)).toContain(REAL_PAN);
    expect(values("269SS", wb).join("\n")).not.toContain("TaxId ");
    expect(values("269ST", wb)).toContain("01-Jul-2025");
  });
});

describe("tb_write_loans_report — raw-row channel", () => {
  it("writes loans-review-<company>-<from>-<to>.xlsx with real names, PAN and address", async () => {
    const h = offlineHarness();
    await h.tools.get("tb_loans_review")!({
      company: "Sample Co",
      ...PHASE,
      dayBookPath: await bundlePath(),
      templatePath: await templatePath(),
    });
    const out = await h.tools.get("tb_write_loans_report")!({ company: "Sample Co" });
    const paths = JSON.parse(out);
    expect(paths.workbookPath).toMatch(/loans-review-sample-co-20250401-20260331\.xlsx$/);
    expect(existsSync(paths.workbookPath)).toBe(true);
    const wb = readWorkbook(await readFile(paths.workbookPath));
    // The raw cached rows carry the operator file's PAN and address, written
    // to disk exactly as they arrive (nothing here was ever masked). With
    // this fixture's vouchers the Metro PAN/address ride the sheet-3 (269T)
    // repayment row.
    expect(values("269T", wb)).toContain(REAL_PAN);
    expect(values("269T", wb)).toContain(REAL_ADDRESS);
    // The chat-side return carries paths only, never names.
    expect(out).not.toContain("Metro Finance");
  });
});

// Guard against accidental import drift: the sheet names contract is loans.ts's.
expect(LOANS_SHEET_NAMES).toHaveLength(7);
