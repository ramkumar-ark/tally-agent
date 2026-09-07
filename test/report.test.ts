import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit, findingsCsv, writeReport, writeVaultDump } from "../src/report.js";
import { createVault } from "../src/vault.js";
import type { Finding } from "../src/types.js";

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
