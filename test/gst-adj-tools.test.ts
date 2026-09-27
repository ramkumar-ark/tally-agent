import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerTools } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { readDayBook } from "../src/tds-daybook.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { make3bWorkbook } from "./helpers/gst-adj-3b.js";
import { make2bWorkbook } from "./helpers/gst-adj-2b.js";

function harness() {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _desc, _schema, handler) => {
    tools.set(name, handler);
  };
  const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
  const cfg = { reportDir: mkdtempSync(join(tmpdir(), "tally-agent-")) };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  return { tools, session, cfg };
}

describe("tb_gst_adj_review", () => {
  it("returns masked findings with no company/GSTIN and no bare 6+ digit runs", async () => {
    const { tools } = harness();
    const dir = mkdtempSync(join(tmpdir(), "gst-adj-"));
    const threeBPath = join(dir, "gst-adjustments-2025.xlsx");
    writeFileSync(threeBPath, make3bWorkbook({}));

    const dayBookPath = join(dir, "daybook.json");
    const dayBook = readDayBook(
      JSON.stringify({
        tallyAgentExport: 1,
        company: "Test Constructions",
        fromDate: "20250401",
        toDate: "20260331",
        groups: [{ name: "Indirect Expenses", parent: "" }],
        ledgers: [
          { name: "Input CGST A/c", parent: "Indirect Expenses" },
          { name: "Output CGST A/c", parent: "Indirect Expenses" },
        ],
        vouchers: [
          {
            date: "20250501",
            voucherType: "Journal",
            voucherNumber: "1",
            partyLedgerName: "",
            entries: [
              { ledger: "Input CGST A/c", amount: -100 },
              { ledger: "Output CGST A/c", amount: 400 },
            ],
          },
        ],
      }),
      { fromDate: "20250401", toDate: "20260331" },
    );
    writeFileSync(dayBookPath, JSON.stringify(dayBook, null, 2));

    const out = await tools.get("tb_gst_adj_review")!({
      threeBPath,
      dayBookPath,
      fromDate: "20250401",
      toDate: "20260331",
    });

    expect(out).not.toContain("Test Constructions");
    expect(out).not.toContain("33AAAAA0000A0Z0");
    expect(out).not.toMatch(/\d{6,}/);
  });

  it("accepts itc2bPath as a folder of monthly workbooks", async () => {
    const { tools } = harness();
    const dir = mkdtempSync(join(tmpdir(), "gst-adj-"));
    const threeBPath = join(dir, "gst-adjustments-2025.xlsx");
    writeFileSync(threeBPath, make3bWorkbook({ months: ["April ", "May"], rows: [
      { label: "Sales summary", values: [1000, 1000] },
      { label: "Tax on outward supply", values: [0, 0] },
      { label: "IGST on outward supply", values: [0, 309.09] },
      { label: "CGST on outward supply", values: [0, 303.03] },
      { label: "SGST on outward supply", values: [0, 303.03] },
      { label: "Cess on outward supply", values: [0, 0] },
      { label: "Net ITC available (a-b)", values: [0, 0] },
      { label: "IGST net ITC", values: [0, 0] },
      { label: "CGST net ITC", values: [0, 0] },
      { label: "SGST net ITC", values: [0, 0] },
      { label: "Cess net ITC", values: [0, 0] },
      { label: "Table 12", values: [0, 0] },
    ] }));

    const itc2bPath = mkdtempSync(join(tmpdir(), "gst-adj-2b-"));
    writeFileSync(
      join(itc2bPath, "apr.xlsx"),
      make2bWorkbook({ period: "1-Apr-25 to 30-Apr-25", layout: "v2", sheetName: "Not Reflected", rows: [{ date: 45741, party: "P1", igst: 50, cgst: 25, sgst: 25, cess: 0 }] }),
    );

    const dayBookPath = join(dir, "daybook.json");
    const dayBook = readDayBook(
      JSON.stringify({
        tallyAgentExport: 1,
        company: "Test Constructions",
        fromDate: "20250401",
        toDate: "20260331",
        groups: [{ name: "Indirect Expenses", parent: "" }],
        ledgers: [
          { name: "Input CGST A/c", parent: "Indirect Expenses" },
          { name: "Output CGST A/c", parent: "Indirect Expenses" },
        ],
        vouchers: [
          {
            date: "20250501",
            voucherType: "Journal",
            voucherNumber: "1",
            partyLedgerName: "",
            entries: [
              { ledger: "Input CGST A/c", amount: -100 },
              { ledger: "Output CGST A/c", amount: 400 },
            ],
          },
        ],
      }),
      { fromDate: "20250401", toDate: "20260331" },
    );
    writeFileSync(dayBookPath, JSON.stringify(dayBook, null, 2));

    const out = await tools.get("tb_gst_adj_review")!({
      threeBPath,
      itc2bPath,
      dayBookPath,
      fromDate: "20250401",
      toDate: "20260331",
    });
    const parsed = JSON.parse(out);
    expect(parsed.fy).toBe("2025");
    expect(out).not.toContain("Test Constructions");
    expect(out).not.toContain("33AAAAA0000A0Z0");
    expect(out).not.toMatch(/\d{6,}/);
  });
});

describe("tb_write_gst_adj_file", () => {
  it("throws when no review has been run", async () => {
    const { tools } = harness();
    await expect(tools.get("tb_write_gst_adj_file")!({})).rejects.toThrow(
      /run tb_gst_adj_review first/,
    );
  });

  it("returns the import path and envelope stats after review", async () => {
    const { tools, cfg } = harness();
    const dir = mkdtempSync(join(tmpdir(), "gst-adj-"));
    const threeBPath = join(dir, "gst-adjustments-2025.xlsx");
    writeFileSync(threeBPath, make3bWorkbook({}));

    const dayBookPath = join(dir, "daybook.json");
    const dayBook = readDayBook(
      JSON.stringify({
        tallyAgentExport: 1,
        company: "Test Constructions",
        fromDate: "20250401",
        toDate: "20260331",
        groups: [{ name: "Indirect Expenses", parent: "" }],
        ledgers: [
          { name: "Input CGST A/c", parent: "Indirect Expenses" },
          { name: "Output CGST A/c", parent: "Indirect Expenses" },
        ],
        vouchers: [
          {
            date: "20250501",
            voucherType: "Journal",
            voucherNumber: "1",
            partyLedgerName: "",
            entries: [
              { ledger: "Input CGST A/c", amount: -100 },
              { ledger: "Output CGST A/c", amount: 400 },
            ],
          },
        ],
      }),
      { fromDate: "20250401", toDate: "20260331" },
    );
    writeFileSync(dayBookPath, JSON.stringify(dayBook, null, 2));

    await tools.get("tb_gst_adj_review")!({
      threeBPath,
      dayBookPath,
      fromDate: "20250401",
      toDate: "20260331",
    });
    const out = await tools.get("tb_write_gst_adj_file")!({});
    const parsed = JSON.parse(out);
    expect(parsed.importPath).toMatch(/gst-adjustments-.*\.json$/);
    expect(parsed.envelopeStats).toBeDefined();
    expect(existsSync(parsed.importPath)).toBe(true);
  });
});
