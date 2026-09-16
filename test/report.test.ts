import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit, findingsCsv, findingsSheet, writeLedgerReport, writeReport, writeTdsReport, writeVaultDump, writeWorkbook } from "../src/report.js";
import type { TdsMaskedFinding } from "../src/review.js";
import { createVault } from "../src/vault.js";
import type { Finding } from "../src/types.js";
import { entry } from "./xlsx.test.js";

function fixture() {
  const vault = createVault();
  const alias = vault.pseudonym("Acme Traders", "creditor");
  const findings: Finding[] = [
    {
      id: "TB-004-1",
      check: "wrong_side_balance",
      severity: "warning",
      ledger: alias,
      group: "Sundry Creditors",
      amount: 41250,
      side: "Dr",
      expected: "Cr",
      detail: `${alias} carries a debit balance`,
    },
  ];
  return { vault, findings, alias };
}

describe("findingsCsv", () => {
  it("writes real names, not aliases", () => {
    const { vault, findings } = fixture();
    const csv = findingsCsv(findings, vault);
    expect(csv).toContain("Acme Traders");
    expect(csv).not.toContain("Creditor 1");
  });

  it("quotes fields containing commas", () => {
    const { vault, findings } = fixture();
    findings[0].detail = "one, two";
    expect(findingsCsv(findings, vault)).toContain('"one, two"');
  });

  it("starts with a header row", () => {
    const { vault, findings } = fixture();
    expect(findingsCsv(findings, vault).split("\n")[0]).toBe(
      "id,check,severity,ledger,group,amount,side,expected,detail",
    );
  });

  it("carries a group nature in the expected column for a wrong-group finding", () => {
    const vault = createVault();
    const alias = vault.pseudonym("Orchid Medical Expenses", "capital");
    const csv = findingsCsv(
      [
        {
          id: "TB-008-1",
          check: "ledger_in_wrong_group",
          severity: "warning",
          ledger: alias,
          group: "Capital Account",
          amount: 18000,
          side: "Dr",
          expected: "expense",
          detail: `${alias} reads as an expense ledger`,
        },
      ],
      vault,
    );
    expect(csv.split("\n")[1]).toBe(
      "TB-008-1,ledger_in_wrong_group,warning,Orchid Medical Expenses,Capital Account,18000.00,Dr,expense," +
        "Orchid Medical Expenses reads as an expense ledger",
    );
  });
});

describe("writeReport", () => {
  it("de-masks the narrative on the way to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault, findings, alias } = fixture();
    const { markdownPath } = await writeReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      asOnDate: "20260331",
      markdown: `# Review\n\n${alias} needs attention.`,
      findings,
      vault,
    });
    const body = readFileSync(markdownPath, "utf8");
    expect(body).toContain("Acme Traders needs attention.");
    expect(body).not.toContain("Creditor 1");
  });

  it("returns both artifact paths and names them by company and date", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault, findings } = fixture();
    const paths = await writeReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      asOnDate: "20260331",
      markdown: "# Review",
      findings,
      vault,
    });
    expect(paths.markdownPath).toMatch(/trial-balance-review-demo-traders-pvt-ltd-20260331\.md$/);
    expect(paths.csvPath).toMatch(/findings-demo-traders-pvt-ltd-20260331\.csv$/);
  });
});

describe("appendAudit", () => {
  it("appends one JSON line per call, into this session's own file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    await appendAudit(dir, "20260331T100000Z", { at: "2026-03-31T10:00:00Z", tool: "tb_review", args: {}, rows: 5, masked: 2 });
    await appendAudit(dir, "20260331T100000Z", { at: "2026-03-31T10:00:05Z", tool: "tb_write_report", args: {}, rows: 0, masked: 0 });
    const lines = readFileSync(join(dir, "session-20260331T100000Z.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe("tb_review");
  });
});

describe("writeVaultDump", () => {
  it("writes the mapping only when asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault } = fixture();
    const path = await writeVaultDump(dir, "20260331T100000Z", vault);
    const dump = JSON.parse(readFileSync(path, "utf8")) as Array<{ real: string; alias: string }>;
    expect(dump).toEqual([{ real: "Acme Traders", alias: "Creditor 1" }]);
  });
});

describe("writeLedgerReport", () => {
  it("names both artifacts by the opaque scrutiny id and de-masks on disk", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Acme Traders", "creditor");
    const reportDir = mkdtempSync(join(tmpdir(), "tally-agent-ledger-"));
    const paths = await writeLedgerReport({
      reportDir,
      company: "Demo Traders Pvt Ltd",
      scrutinyId: "L1",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: `# ${alias}`,
      findings: [
        {
          id: "LS-1-002-1",
          check: "ls_wrong_side_during_period",
          severity: "warning",
          ledger: alias,
          group: "Sundry Creditors",
          amount: 82500,
          side: "Dr",
          expected: "Cr",
          detail: `${alias} stood on the debit side`,
        },
      ],
      vault,
    });
    expect(paths.markdownPath).toBe(join(reportDir, "ledger-scrutiny-demo-traders-pvt-ltd-l1-20250401-20260331.md"));
    expect(paths.csvPath).toBe(join(reportDir, "ledger-findings-demo-traders-pvt-ltd-l1-20250401-20260331.csv"));
    expect(readFileSync(paths.markdownPath, "utf8")).toBe("# Acme Traders");
    expect(readFileSync(paths.csvPath, "utf8")).toContain(
      "LS-1-002-1,ls_wrong_side_during_period,warning,Acme Traders,Sundry Creditors,82500.00,Dr,Cr,Acme Traders stood on the debit side",
    );
  });
});

describe("writeTdsReport", () => {
  it("writes the report trio with de-masked names and the interest schedule", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Sample Builders LLP", "creditor");
    const findings: TdsMaskedFinding[] = [
      {
        id: "TDS-001-1",
        check: "tds_not_deducted",
        severity: "critical",
        deductee: alias,
        group: "Sundry Creditors",
        section: "194C",
        amount: 5000,
        detail: `${alias} booking 2,50,000.00 on 10-May-2025: no duty credit found`,
        schedule: [{ kind: "i", amount: 100, from: "20250510", to: "20250628", basis: "1% of 2 month(s)" }],
      },
    ];
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-tds-"));
    const paths = await writeTdsReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: `# TDS review\n\n${alias} is a pseudonym.`,
      findings,
      vault,
    });
    const md = readFileSync(paths.markdownPath, "utf8");
    const csv = readFileSync(paths.csvPath, "utf8");
    const isched = readFileSync(paths.interestCsvPath, "utf8");
    expect(md).toContain("Sample Builders LLP");
    expect(csv).toContain("Sample Builders LLP");
    expect(csv.split("\n")[0]).toBe("id,check,severity,deductee,group,section,amount,detail");
    expect(isched.split("\n")[0]).toBe("id,check,deductee,section,kind,amount,from,to,basis");
    expect(isched).toContain("Sample Builders LLP");
    expect(isched).toContain("1% of 2 month(s)");
  });
});

describe("writeWorkbook", () => {
  it("de-masks every string cell on the way to disk and leaves numbers alone", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Sundry Machinery Supplier", "creditor");
    const dir = await mkdtemp(join(tmpdir(), "dep-wb-"));

    const path = await writeWorkbook({
      reportDir: dir,
      fileName: "wb.xlsx",
      vault,
      sheets: [{
        name: "S",
        columns: [{ header: "Party", format: "text" }, { header: "Amount", format: "money" }],
        rows: [[alias, 1234.5]],
      }],
    });

    const xml = entry(await readFile(path), "xl/worksheets/sheet1.xml");
    expect(xml).toContain("Sundry Machinery Supplier");
    expect(xml).not.toContain(alias);
    expect(xml).toContain("<v>1234.5</v>");
    expect(path.startsWith(dir)).toBe(true);
  });

  it("builds a findings sheet whose columns match findingsCsv's header", () => {
    const sheet = findingsSheet([{
      id: "DEP-005-1", check: "dep_credit_unclassified", severity: "critical",
      ledger: "Ledger 7", group: "Block 15%", amount: 962000,
      side: null, expected: null, detail: "counter ledger not resolvable",
    }]);
    expect(sheet.columns.map((c) => c.header)).toEqual([
      "id", "check", "severity", "ledger", "group", "amount", "side", "expected", "detail",
    ]);
    expect(sheet.rows[0][0]).toBe("DEP-005-1");
    expect(sheet.rows[0][5]).toBe(962000);
  });
});
