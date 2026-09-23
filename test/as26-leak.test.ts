import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { parseAs26Export } from "../src/as26-file.js";
import { loadAs26Map } from "../src/as26.js";
import { buildAs26Fixture, defaultAs26Fixture, type As26FixtureOpts } from "./as26-fixture.js";
import { readWorkbook } from "../src/xlsx-read.js";
import type { Downstream } from "../src/downstream.js";

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d;
};
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Planted identifiers, all invented (§11 shapes). The TANs already ride in
 * the default fixture's never-bound cells; the PAN is planted in an unused
 * summary column, so the absence assertions below are never vacuous. */
const TANS = ["MUMA01234E", "PUNB05678F", "BLRA09876D"];
const PAN = "AAAPZ1234F";
const planted = [...TANS, PAN];

const optsWithPan = (): As26FixtureOpts => {
  const base = defaultAs26Fixture();
  base.tdsSummary[4] = ["Name of Deductor", "TAN", "TDS Deducted (Rs.)", PAN];
  return base;
};

const groups = [
  { name: "Current Assets", parent: "" },
  { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Works Contract Service", parent: "Sales Accounts" },
  { name: "Sales Accounts", parent: "" },
];
const masters = [
  { name: "TDS Receivable", parent: "Current Assets", gstin: null, state: "", pan: null, isTdsApplicable: false, tdsDeducteeType: "", natureOfPayment: null },
  { name: "Anand Buildmart Pvt Ltd", parent: "Sundry Debtors", gstin: null, state: "", pan: PAN, isTdsApplicable: true, tdsDeducteeType: "", natureOfPayment: null },
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

const allStrings = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(allStrings);
  }
  return [];
};

describe("26AS leak doors", () => {
  it("planted tax ids never reach the review result, the audit or the written artifacts", async () => {
    const tools = new Map<string, (args: any) => Promise<string>>();
    const registrar: ToolRegistrar = (name, _d, _s, h) => { tools.set(name, h); };
    const session = createSession(fakeDown(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const reportDir = tempDir("as26-leak-");
    registerTools(registrar, session, { reportDir, dayBookMaxBytes: 64 * 1_048_576 }, "20260331T100000Z");

    const as26Path = join(tempDir("as26-leak-in-"), "export.xlsm");
    writeFileSync(as26Path, buildAs26Fixture(optsWithPan()));
    const mapPath = join(tempDir("as26-leak-map-"), "as26-map.json");
    writeFileSync(mapPath, JSON.stringify({ mappings: [
      { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" },
    ]}));

    const out = await tools.get("tb_26as_review")!({
      fromDate: "20250401", toDate: "20260331", as26Path, as26MapPath: mapPath, company: "Demo Traders Pvt Ltd",
    });
    expect(allStrings(JSON.parse(out)).some((s) => planted.concat(["AAAPZ"]).some((p) => s.includes(p)))).toBe(false);
    // the terse pseudo-form (scrubbed digits) must not carry the TAN prefix either
    expect(out).not.toMatch(/MUMA|PUNB|BLRA|AAAPZ/);

    const auditText = readFileSync(join(reportDir, "session-20260331T100000Z.jsonl"), "utf8");
    for (const line of auditText.trim().split("\n")) {
      expect(line).not.toMatch(/MUMA|PUNB|BLRA|AAAPZ/);
    }

    const writeOut = await tools.get("tb_write_26as_report")!({
      company: "Demo Traders Pvt Ltd", fromDate: "20250401", toDate: "20260331",
      markdown: "Narrative, masked terms only.",
    });
    const paths = JSON.parse(writeOut);
    expect(readFileSync(paths.markdownPath, "utf8")).not.toMatch(/MUMA|PUNB|BLRA|AAAPZ/);
    const wb = readWorkbook(readFileSync(paths.workbookPath));
    for (const sheet of wb) {
      for (const r of sheet.rows.values()) {
        for (const c of r.cells.values()) expect(String(c.value)).not.toMatch(/MUMA|PUNB|BLRA|AAAPZ/);
      }
    }
  });

  it("operator-map errors cite entry indexes only, never values", () => {
    const dir = tempDir("as26-leak-err-");
    const dup = join(dir, "a.json");
    writeFileSync(dup, JSON.stringify({ mappings: [
      { ledger: TANS[0], as26Name: TANS[1] },
      { ledger: TANS[0], as26Name: TANS[2] },
    ]}));
    let msg = "";
    try { loadAs26Map(dup); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^as26-map entry 2: /);
    expect(msg).not.toMatch(/MUMA|PUNB|BLRA/);

    const blank = join(dir, "b.json");
    writeFileSync(blank, JSON.stringify({ mappings: [{ ledger: "  ", as26Name: TANS[0] }] }));
    msg = "";
    try { loadAs26Map(blank); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^as26-map entry 1: /);
    expect(msg).not.toMatch(/MUMA|PUNB|BLRA/);
  });

  it("parser sheet errors cite sheet names only, never cell contents", () => {
    // Drop the header row entirely: the error names the sheet, not cells.
    let msg = "";
    try { parseAs26Export(buildAs26Fixture({ ...optsWithPan(), tdsDetail: [] })); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/TDS_Detailed/);
    expect(msg).not.toMatch(/MUMA|PUNB|BLRA|AAAPZ/);

    // Keep the header row but lose a required column: the error lists what
    // was found (headers), never any data cell.
    const base = optsWithPan();
    base.tdsDetail = [
      base.tdsDetail[0],
      base.tdsDetail[1],
      ["Name of Deductor", "Transaction Date", "Tax Deducted(Rs.)", "Section"],
      ["NAGAR PALIKA NAGAR BHAVAN", "14-Apr-2025", 6000, TANS[0]],
    ];
    msg = "";
    try { parseAs26Export(buildAs26Fixture(base)); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/required column/);
    expect(msg).not.toMatch(/MUMA|PUNB|BLRA|AAAPZ/);
  });
});
