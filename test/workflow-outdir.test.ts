import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_TDS_OPERATOR } from "../src/tds-file.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { buildAs26Fixture } from "./as26-fixture.js";
import type { Downstream } from "../src/downstream.js";

function harness(downstream?: Downstream) {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _desc, _schema, handler) => {
    tools.set(name, handler);
  };
  const session = createSession(downstream ?? fakeDownstream(), EMPTY_OVERRIDES);
  const cfg = { reportDir: mkdtempSync(join(tmpdir(), "tally-agent-")) };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  return { tools, cfg };
}

/** A directory that does not exist yet, like a workflow's to-fill/ folder. */
const freshOutDir = (): string => join(mkdtempSync(join(tmpdir(), "wf-outdir-")), "to-fill");

const allPaths = (parsed: Record<string, unknown>): string[] =>
  Object.values(parsed).filter((v): v is string => typeof v === "string" && v.includes("/"));

describe("outDir plumbing for the workflow (M1)", () => {
  it("tb_write_tds_template writes into outDir, creating it when missing", async () => {
    const { tools } = harness();
    const dir = freshOutDir();
    const parsed = JSON.parse(await tools.get("tb_write_tds_template")!({ outDir: dir }));
    expect(parsed.templatePath.startsWith(dir)).toBe(true);
    expect(existsSync(parsed.templatePath)).toBe(true);
  });

  it("tb_write_tds_report writes the trio into outDir", async () => {
    const { tools } = harness();
    const input = mkdtempSync(join(tmpdir(), "wf-tds-in-"));
    const operatorPath = join(input, "operator.json");
    const dayBookPath = join(input, "daybook.json");
    writeFileSync(operatorPath, JSON.stringify(EMPTY_TDS_OPERATOR), "utf8");
    writeFileSync(
      dayBookPath,
      JSON.stringify([
        {
          date: "20250510", voucherType: "Purchase", voucherNumber: "PU/0012",
          partyLedgerName: "Acme Contracting",
          entries: [
            { LEDGERNAME: "Site Expenses", AMOUNT: -25000 },
            { LEDGERNAME: "Acme Contracting", AMOUNT: 25000 },
          ],
        },
      ]),
      "utf8",
    );
    await tools.get("tb_tds_review")!({
      fromDate: "20250401", toDate: "20260331", asOnDate: "20260331",
      tdsFilePath: operatorPath, dayBookPath,
    });
    const dir = freshOutDir();
    const parsed = JSON.parse(
      await tools.get("tb_write_tds_report")!({
        company: "Demo Traders Pvt Ltd",
        fromDate: "20250401",
        toDate: "20260331",
        markdown: "# TDS review",
        outDir: dir,
      }),
    );
    const paths = allPaths(parsed);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith(dir), p).toBe(true);
      expect(existsSync(p), p).toBe(true);
    }
  });

  it("tb_write_26as_template writes into outDir", async () => {
    const { tools } = harness();
    const as26Path = join(mkdtempSync(join(tmpdir(), "wf-as26-")), "26as.xlsm");
    writeFileSync(as26Path, buildAs26Fixture());
    const dir = freshOutDir();
    const parsed = JSON.parse(await tools.get("tb_write_26as_template")!({ as26Path, outDir: dir }));
    expect(parsed.templatePath.startsWith(dir)).toBe(true);
    expect(existsSync(parsed.templatePath)).toBe(true);
  });
});

/** The 26AS report needs a books side: the as26-report.test.ts demo books. */
function as26Downstream(): Downstream {
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
  ];
  const receivableRows = [
    { date: "20250612", voucherType: "Journal", voucherNumber: "JV/1", reference: "", counterparty: "Anand Buildmart Pvt Ltd", amount: 115000, matchStatus: "matched", tax: null },
  ];
  return {
    groups: async () => groups,
    ledgersTax: async () => masters as never,
    ledgerVoucherRows: async (_c: unknown, ledger: string, from: string, to: string) => ({
      rows: ledger === "TDS Receivable"
        ? receivableRows.filter((r) => r.date >= from && r.date <= to)
        : [],
      dropped: 0,
    }),
    vouchers: async () => [] as never,
    callRaw: async () => { throw new Error("not used"); },
    listCompanies: async () => ["Demo Traders Pvt Ltd"],
    trialBalance: async () => { throw new Error("not used"); },
    ledgers: async () => [] as never,
    ledgerVouchers: async () => [] as never,
    close: async () => {},
  } as never;
}

describe("outDir plumbing for the workflow: 26AS report", () => {
  it("tb_write_26as_report writes md + workbook into outDir", async () => {
    const { tools } = harness(as26Downstream());
    const input = mkdtempSync(join(tmpdir(), "wf-as26-in-"));
    const as26Path = join(input, "export.xlsm");
    writeFileSync(as26Path, buildAs26Fixture());
    const mapPath = join(input, "as26-map.json");
    writeFileSync(mapPath, JSON.stringify({ mappings: [
      { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" },
    ]}));
    const dayBookPath = join(input, "daybook.json");
    writeFileSync(
      dayBookPath,
      JSON.stringify({
        company: "Demo Traders Pvt Ltd",
        groups: [
          { name: "Current Assets", parent: "" },
          { name: "Sundry Debtors", parent: "Current Assets" },
          { name: "Sales Accounts", parent: "" },
        ],
        ledgers: [
          { name: "TDS Receivable", parent: "Current Assets" },
          { name: "Anand Buildmart Pvt Ltd", parent: "Sundry Debtors" },
        ],
        vouchers: [
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
    await tools.get("tb_26as_review")!({
      fromDate: "20250401", toDate: "20260331", as26Path, as26MapPath: mapPath,
      company: "Demo Traders Pvt Ltd", dayBookPath,
    });
    const dir = freshOutDir();
    const parsed = JSON.parse(
      await tools.get("tb_write_26as_report")!({
        company: "Demo Traders Pvt Ltd",
        fromDate: "20250401",
        toDate: "20260331",
        markdown: "# 26AS reconciliation",
        outDir: dir,
      }),
    );
    const paths = allPaths(parsed);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith(dir), p).toBe(true);
      expect(existsSync(p), p).toBe(true);
    }
  });
});

describe("outDir plumbing for the workflow: GST44 report", () => {
  it("tb_write_gst44_report writes the workbook into outDir", async () => {
    const { tools } = harness();
    const dayBookPath = join(mkdtempSync(join(tmpdir(), "wf-gst44-")), "daybook.json");
    writeFileSync(
      dayBookPath,
      JSON.stringify({
        company: "Demo Traders Pvt Ltd",
        groups: [{ name: "Purchase Accounts", parent: "" }],
        ledgers: [{ name: "Site Materials", parent: "Purchase Accounts" }],
        vouchers: [
          {
            date: "20250510", voucherType: "Purchase", voucherNumber: "P1",
            partyLedgerName: "", isCancelled: false,
            entries: [
              { LEDGERNAME: "Site Materials", AMOUNT: -900 },
            ],
          },
        ],
      }),
      "utf8",
    );
    await tools.get("tb_gst44_review")!({
      fromDate: "20250401", toDate: "20260331", dayBookPath, company: "Demo Traders Pvt Ltd",
    });
    const dir = freshOutDir();
    const parsed = JSON.parse(await tools.get("tb_write_gst44_report")!({ outDir: dir }));
    const paths = allPaths(parsed);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith(dir), p).toBe(true);
      expect(existsSync(p), p).toBe(true);
    }
  });
});

describe("outDir plumbing for the workflow: PF/ESI report", () => {
  it("tb_write_pf_esi_report writes the workbook into outDir", async () => {
    const pfLedger = "Staff PF Payable";
    const salaryLedger = "Staff Wages";
    const down = Object.assign(fakeDownstream(), {
      groups: async () => [
        { name: "Current Liabilities", parent: "\u0004 Primary" },
        { name: "Indirect Expenses", parent: "\u0004 Primary" },
      ],
      ledgers: async () => [
        { name: pfLedger, parent: "Current Liabilities", openingBalance: 0, closingBalance: -1000 },
        { name: salaryLedger, parent: "Indirect Expenses", openingBalance: 0, closingBalance: 1000 },
      ],
      vouchers: async () => [
        {
          date: "20250430", voucherType: "Jrnl", voucherNumber: "J-1", partyLedgerName: "", cancelled: false,
          entries: [
            { ledger: salaryLedger, amount: 2000 },
            { ledger: pfLedger, amount: -2000 },
          ],
        },
      ],
    } as never);
    const { tools } = harness(down);
    await tools.get("tb_pf_esi_review")!({ fromDate: "20250401", toDate: "20260331" });
    const dir = freshOutDir();
    const parsed = JSON.parse(await tools.get("tb_write_pf_esi_report")!({ outDir: dir }));
    const paths = allPaths(parsed);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith(dir), p).toBe(true);
      expect(existsSync(p), p).toBe(true);
    }
  });
});

describe("outDir plumbing for the workflow: depreciation and fixed asset reports", () => {
  it("tb_write_depreciation_report writes the trio into outDir", async () => {
    const { tools } = harness();
    await tools.get("tb_depreciation_review")!({ fromDate: "20250401", toDate: "20260331" });
    const dir = freshOutDir();
    const parsed = JSON.parse(
      await tools.get("tb_write_depreciation_report")!({
        company: "Demo Traders Pvt Ltd",
        fromDate: "20250401",
        toDate: "20260331",
        outDir: dir,
      }),
    );
    const paths = allPaths(parsed);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith(dir), p).toBe(true);
      expect(existsSync(p), p).toBe(true);
    }
  });

  it("tb_write_fixed_asset_report writes the trio into outDir", async () => {
    const { tools } = harness();
    await tools.get("tb_fixed_asset_register")!({
      company: "Demo Traders Pvt Ltd", fromDate: "20250401", toDate: "20260331",
    });
    const dir = freshOutDir();
    const parsed = JSON.parse(
      await tools.get("tb_write_fixed_asset_report")!({
        company: "Demo Traders Pvt Ltd",
        fromDate: "20250401",
        toDate: "20260331",
        outDir: dir,
      }),
    );
    const paths = allPaths(parsed);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith(dir), p).toBe(true);
      expect(existsSync(p), p).toBe(true);
    }
  });
});
