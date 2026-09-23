import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { parseAs26Export } from "../src/as26-file.js";
import { buildAs26Fixture } from "./as26-fixture.js";
import { readWorkbook } from "../src/xlsx-read.js";
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
    expect(names).toEqual(["Findings", "Deductors", "Books Events", "Mapping"]);
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
});
