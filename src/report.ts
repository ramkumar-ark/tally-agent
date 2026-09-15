import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demaskText } from "./mask.js";
import type { Finding, Severity } from "./types.js";
import type { TdsMaskedFinding as TdsCsvFinding } from "./review.js";
import type { Vault } from "./vault.js";

/**
 * Structural shape both the trial-balance and the GST findings CSV need. GST
 * findings carry no side/expected and extra fields are not written.
 */
export interface CsvFinding {
  id: string;
  check: string;
  severity: Severity;
  ledger: string;
  group: string;
  amount: number;
  side?: string | null;
  expected?: string | null;
  detail: string;
}

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

export function findingsCsv(findings: CsvFinding[], vault: Vault): string {
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

/**
 * The M2 GST artifact pair: the same writer contract and report-directory
 * boundary as `writeReport` (R-R-4), with from/to dates instead of an as-on
 * date naming the file stem. De-masking on the way to disk restores party
 * names and tax-ID aliases (TaxId N -> real GSTIN) alike.
 */
export async function writeGstReport(opts: {
  reportDir: string;
  company: string;
  fromDate: string;
  toDate: string;
  markdown: string;
  findings: CsvFinding[];
  vault: Vault;
}): Promise<{ markdownPath: string; csvPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${opts.fromDate}-${opts.toDate}`;
  const markdownPath = join(opts.reportDir, `gst-review-${stem}.md`);
  const csvPath = join(opts.reportDir, `gst-findings-${stem}.csv`);

  await writeFile(markdownPath, demaskText(opts.markdown, opts.vault), "utf8");
  await writeFile(csvPath, findingsCsv(opts.findings, opts.vault), "utf8");

  return { markdownPath, csvPath };
}

/**
 * The M3 ledger scrutiny artifact pair: the same writer contract and
 * report-directory boundary (R-R-4). The file stem names the ledger by its
 * opaque scrutiny id ("L1"), never by name: the returned paths go back to
 * the model.
 */
export async function writeLedgerReport(opts: {
  reportDir: string;
  company: string;
  scrutinyId: string;
  fromDate: string;
  toDate: string;
  markdown: string;
  findings: CsvFinding[];
  vault: Vault;
}): Promise<{ markdownPath: string; csvPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${slug(opts.scrutinyId)}-${opts.fromDate}-${opts.toDate}`;
  const markdownPath = join(opts.reportDir, `ledger-scrutiny-${stem}.md`);
  const csvPath = join(opts.reportDir, `ledger-findings-${stem}.csv`);

  await writeFile(markdownPath, demaskText(opts.markdown, opts.vault), "utf8");
  await writeFile(csvPath, findingsCsv(opts.findings, opts.vault), "utf8");

  return { markdownPath, csvPath };
}

/**
 * The TDS artifact trio: the same writer contract and report-directory
 * boundary (R-R-4). Two findings carry the same CSV shape; the interest
 * schedule is an extra de-masked artifact, TANs and PAN paths never carry
 * alias keys to demask (nos PANs land in findings at all).
 */
export async function writeTdsReport(opts: {
  reportDir: string;
  company: string;
  fromDate: string;
  toDate: string;
  markdown: string;
  findings: TdsCsvFinding[];
  vault: Vault;
}): Promise<{ markdownPath: string; csvPath: string; interestCsvPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${opts.fromDate}-${opts.toDate}`;
  const markdownPath = join(opts.reportDir, `tds-review-${stem}.md`);
  const csvPath = join(opts.reportDir, `tds-findings-${stem}.csv`);
  const interestCsvPath = join(opts.reportDir, `tds-interest-schedule-${stem}.csv`);

  const header = "id,check,severity,deductee,group,section,amount,detail";
  const rows = opts.findings.map((f) =>
    [
      f.id,
      f.check,
      f.severity,
      demaskText(f.deductee, opts.vault),
      f.group,
      f.section ?? "",
      f.amount.toFixed(2),
      demaskText(f.detail, opts.vault),
    ]
      .map(csvField)
      .join(","),
  );

  const schedule = [];
  for (const f of opts.findings) {
    for (const s of f.schedule ?? []) {
      schedule.push(
        [
          f.id,
          f.check,
          demaskText(f.deductee, opts.vault),
          f.section ?? "",
          s.kind,
          s.amount.toFixed(2),
          s.from,
          s.to,
          demaskText(s.basis, opts.vault),
        ]
          .map(csvField)
          .join(","),
      );
    }
  }

  await writeFile(markdownPath, demaskText(opts.markdown, opts.vault), "utf8");
  await writeFile(csvPath, [header, ...rows].join("\n"), "utf8");
  await writeFile(
    interestCsvPath,
    ["id,check,deductee,section,kind,amount,from,to,basis", ...schedule].join("\n"),
    "utf8",
  );

  return { markdownPath, csvPath, interestCsvPath };
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
