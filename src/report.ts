import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demaskText } from "./mask.js";
import type { Finding } from "./types.js";
import type { Vault } from "./vault.js";

export interface WriteReportOptions {
  reportDir: string;
  company: string;
  asOnDate: string;
  markdown: string;
  findings: Finding[];
  vault: Vault;
}

export interface AuditEntry {
  at: string;
  tool: string;
  args: Record<string, unknown>;
  rows: number;
  masked: number;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const csvField = (v: unknown): string => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function findingsCsv(findings: Finding[], vault: Vault): string {
  const header = "id,check,severity,ledger,group,amount,side,expected,detail";
  const rows = findings.map((f) =>
    [
      f.id,
      f.check,
      f.severity,
      demaskText(f.ledger, vault),
      f.group,
      f.amount.toFixed(2),
      f.side ?? "",
      f.expected ?? "",
      demaskText(f.detail, vault),
    ]
      .map(csvField)
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export async function writeReport(
  opts: WriteReportOptions,
): Promise<{ markdownPath: string; csvPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${opts.asOnDate}`;
  const markdownPath = join(opts.reportDir, `trial-balance-review-${stem}.md`);
  const csvPath = join(opts.reportDir, `findings-${stem}.csv`);

  await writeFile(markdownPath, demaskText(opts.markdown, opts.vault), "utf8");
  await writeFile(csvPath, findingsCsv(opts.findings, opts.vault), "utf8");

  return { markdownPath, csvPath };
}

export async function appendAudit(
  reportDir: string,
  sessionId: string,
  entry: AuditEntry,
): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  await appendFile(
    join(reportDir, `session-${sessionId}.jsonl`),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}

/**
 * The vault mapping reverses every other protection, so this is written only
 * when TALLY_AGENT_DUMP_VAULT=1 — see the design document, section 7.
 */
export async function writeVaultDump(
  reportDir: string,
  sessionId: string,
  vault: Vault,
): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const path = join(reportDir, `vault-${sessionId}.json`);
  await writeFile(path, JSON.stringify(vault.entries(), null, 2), "utf8");
  return path;
}
