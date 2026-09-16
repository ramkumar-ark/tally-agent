import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demaskText } from "./mask.js";
import type { Finding, Severity } from "./types.js";
import { money, displayDate } from "./format.js";
import { round2, type BlockResult, type AssetRow, type MovementRow, type ExcludedRow } from "./depreciation.js";
import type { TdsMaskedFinding as TdsCsvFinding, DepMaskedFinding } from "./review.js";
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

import { buildWorkbook, type CellValue, type Column, type Sheet } from "./xlsx.js";
export type { CellValue, Column, Sheet } from "./xlsx.js";

/**
 * The shared workbook writer (R-X-1, R-X-3). Callers build MASKED sheets;
 * this is the only place a workbook's strings are de-masked, and it happens
 * on the way to disk — the same boundary rule as `writeReport` (R-P-5).
 * Later reports reuse this; they do not grow their own de-masking.
 */
export async function writeWorkbook(opts: {
  reportDir: string;
  fileName: string;
  sheets: Sheet[];
  vault: Vault;
}): Promise<string> {
  await mkdir(opts.reportDir, { recursive: true });
  const path = join(opts.reportDir, opts.fileName);
  const demasked: Sheet[] = opts.sheets.map((s) => ({
    name: s.name,
    title: s.title?.map((t) => demaskText(t, opts.vault)),
    columns: s.columns,
    rows: s.rows.map((row) =>
      row.map((cell): CellValue => (typeof cell === "string" ? demaskText(cell, opts.vault) : cell)),
    ),
  }));
  await writeFile(path, buildWorkbook(demasked));
  return path;
}

/**
 * The adapter that lets any existing findings list become a workbook sheet
 * without rewriting its writer. Masked in, masked out: `writeWorkbook` does
 * the de-masking. Columns mirror `findingsCsv`'s header exactly.
 */
export function findingsSheet(findings: CsvFinding[]): Sheet {
  return {
    name: "Findings",
    columns: [
      { header: "id", width: 16, format: "text" },
      { header: "check", width: 30, format: "text" },
      { header: "severity", width: 10, format: "text" },
      { header: "ledger", width: 28, format: "text" },
      { header: "group", width: 18, format: "text" },
      { header: "amount", width: 16, format: "money" },
      { header: "side", width: 8, format: "text" },
      { header: "expected", width: 12, format: "text" },
      { header: "detail", width: 70, format: "text" },
    ],
    rows: findings.map((f) => [
      f.id, f.check, f.severity, f.ledger, f.group, f.amount,
      f.side ?? null, f.expected ?? null, f.detail,
    ]),
  };
}

/**
 * Task 9's DepResult as tb_depreciation_review actually returns it: every
 * ledger and block name already a pseudonym. Adapted from the plan's sketch —
 * `findings` is `DepMaskedFinding[]` (review.ts), which carries `block`, not
 * the plan's `CsvFinding`; the period dates ride along, as the review result
 * carries them.
 */
export interface MaskedDepResult {
  company?: string;
  fromDate?: string;
  toDate?: string;
  blocks: BlockResult[];
  assets: AssetRow[];
  movements: MovementRow[];
  excluded: ExcludedRow[];
  findings: DepMaskedFinding[];
  bookCharge: number;
  seedSource: "operator" | "book-seed";
}

const moneyCol = (header: string, width = 16): Column => ({ header, width, format: "money" });
const textCol = (header: string, width?: number): Column => ({ header, width, format: "text" });
const dateCol = (header: string, width = 12): Column => ({ header, width, format: "date" });

/** Block-aggregated discounts, read off the Movements audit trail. */
const blockDiscounts = (result: MaskedDepResult): Map<string, number> => {
  const out = new Map<string, number>();
  for (const m of result.movements) {
    if (m.kind !== "discount" || !m.nettedAgainst) continue;
    const block = result.assets.find((a) => a.ledger === m.ledger)?.block;
    if (!block) continue;
    out.set(block, round2((out.get(block) ?? 0) + m.amount));
  }
  return out;
};

const blockBookCharge = (result: MaskedDepResult): Map<string, number> => {
  const out = new Map<string, number>();
  for (const a of result.assets) {
    out.set(a.block, round2((out.get(a.block) ?? 0) + a.bookCharge));
  }
  return out;
};

/** The Excluded stanza is verified by the operator file, never by the report. */
const stanzaOf = (e: ExcludedRow): string => {
  if (e.rule === "C2" && /ties to no acquisition/.test(e.missing)) {
    return "none — the books must show the tie or correct the entry";
  }
  if (e.rule === "C5") {
    return `creditClassifications: { ledger: ${e.ledger}, date: ${e.date}, amount: ${e.amount}, kind: "transfer", block: <block> }`;
  }
  return `creditClassifications: { ledger: ${e.ledger}, date: ${e.date}, amount: ${e.amount}, kind: sale|discount|writeoff|depreciation }`;
};

/**
 * §15's five statuses: the statutory outcome first, else the data-quality
 * caveats — flagged entries excluded, then the unverified book seed.
 */
const blockStatus = (
  b: BlockResult, result: MaskedDepResult, flagged: Set<string>,
): string => {
  if (b.status !== "ok") return b.status;
  if (flagged.has(b.block)) return "incomplete — flagged entries excluded";
  if (result.seedSource === "book-seed") return "unverified-seed";
  return "ok";
};

/**
 * The depreciation workbook, six sheets in §15's order. Masked in, masked
 * out: `writeWorkbook` de-masks. Block-level book charge, difference and
 * discounts-netted are derived here from the audit trail, the same
 * aggregation the engine's block-charge check performs.
 */
export function depreciationSheets(result: MaskedDepResult): Sheet[] {
  const discounts = blockDiscounts(result);
  const bookByBlock = blockBookCharge(result);
  const flaggedBlocks = new Set(
    result.excluded
      .map((e) => result.assets.find((a) => a.ledger === e.ledger)?.block)
      .filter((b): b is string => Boolean(b)),
  );

  const actTotal = round2(result.blocks.reduce((a, b) => a + b.totalDepreciation, 0));
  const addlTotal = round2(result.blocks.reduce((a, b) => a + b.additionalDepreciation, 0));
  const gainTotal = round2(result.blocks.reduce((a, b) => a + b.shortTermGain, 0));
  const lossTotal = round2(result.blocks.reduce((a, b) => a + b.shortTermLoss, 0));
  const differenceTotal = round2(actTotal - result.bookCharge);

  const summary: Sheet = {
    name: "Summary",
    title: [
      `Depreciation review, ${displayDate(result.fromDate ?? "")} to ${displayDate(result.toDate ?? "")}`,
      SEED_BANNER[result.seedSource],
      `Blocks: ${result.blocks.length}; asset ledgers: ${result.assets.length}; excluded entries: ${result.excluded.length}; findings: ${result.findings.length}`,
    ],
    columns: [textCol("Figure", 42), moneyCol("Amount")],
    rows: [
      ["Act depreciation", actTotal],
      ["Additional depreciation", addlTotal],
      ["Book charge", result.bookCharge],
      ["Difference", differenceTotal],
      ["s.50 short-term capital gain", gainTotal],
      ["s.50 short-term capital loss", lossTotal],
      ["Excluded entries", result.excluded.length],
      ["Findings", result.findings.length],
    ],
  };

  const blocks: Sheet = {
    name: "Blocks",
    columns: [
      textCol("Block", 24),
      { header: "Rate %", width: 8, format: "text" },
      moneyCol("Opening WDV", 16),
      moneyCol("Additions ≥ 180 days", 20),
      moneyCol("Additions < 180 days", 20),
      moneyCol("Discounts netted", 16),
      moneyCol("Deductions (moneys payable)", 24),
      moneyCol("WDV before depreciation", 20),
      moneyCol("Normal depreciation", 18),
      moneyCol("Additional depreciation", 20),
      moneyCol("Total Act depreciation", 20),
      moneyCol("Closing WDV", 16),
      moneyCol("Book charge", 16),
      moneyCol("Difference", 14),
      textCol("Status", 36),
    ],
    rows: result.blocks.map((b) => [
      b.block, b.rate, b.openingWdv, b.additionsFull, b.additionsHalf,
      discounts.get(b.block) ?? 0, b.deductions, b.wdvBeforeDep,
      b.normalDepreciation, b.additionalDepreciation, b.totalDepreciation,
      b.closingWdv, bookByBlock.get(b.block) ?? 0,
      round2(b.totalDepreciation - (bookByBlock.get(b.block) ?? 0)),
      blockStatus(b, result, flaggedBlocks),
    ]),
  };

  const assets: Sheet = {
    name: "Assets",
    title: [
      "The block figure is the statutory one; the asset split is an allocation.",
      "Per-asset Act depreciation is apportioned pro-rata so the column sums exactly to the block total.",
    ],
    columns: [
      textCol("Block", 24),
      { header: "Rate %", width: 8, format: "text" },
      textCol("Asset", 32),
      moneyCol("Opening (book seed)", 18),
      moneyCol("Additions (net)", 16),
      dateCol("First-use date"),
      textCol("Under 180 days", 14),
      moneyCol("Act depreciation (allocated)", 24),
      moneyCol("Book charge", 16),
      moneyCol("Difference", 14),
      textCol("Notes", 50),
    ],
    rows: result.assets.map((a) => [
      a.block, a.rate, a.ledger, a.opening, a.additionsNet, a.firstUse ?? null,
      a.shortPeriod ? "Yes" : "No", a.actDepreciation, a.bookCharge, a.difference, a.notes,
    ]),
  };

  const movements: Sheet = {
    name: "Movements",
    columns: [
      dateCol("Date"),
      textCol("Asset", 32),
      textCol("Counterparty", 32),
      textCol("Classification", 16),
      textCol("Rule", 10),
      moneyCol("Amount"),
      textCol("Netted against", 16),
    ],
    rows: result.movements.map((m) => [
      m.date, m.ledger, m.counterparty, m.kind, m.rule, m.amount, m.nettedAgainst,
    ]),
  };

  const excluded: Sheet = {
    name: "Excluded",
    columns: [
      textCol("Asset", 32),
      dateCol("Date"),
      moneyCol("Amount"),
      textCol("Closest rule", 14),
      textCol("What is missing", 50),
      textCol("Operator file stanza", 60),
    ],
    rows: result.excluded.map((e) => [
      e.ledger, e.date, e.amount, e.rule, e.missing, stanzaOf(e),
    ]),
  };

  return [
    summary,
    blocks,
    assets,
    movements,
    excluded,
    findingsSheet(result.findings.map((f) => ({
      id: f.id, check: f.check, severity: f.severity, ledger: f.ledger,
      group: f.block, amount: f.amount, detail: f.detail,
    }))),
  ];
}

const SEED_BANNER: Record<MaskedDepResult["seedSource"], string> = {
  operator: "Opening written-down values come from the operator file.",
  "book-seed": "UNVERIFIED BOOK SEED — every opening written-down value is the ledger's book balance",
};

/** Fill the story's period from the writer's own dates when absent. */
const withPeriod = (result: MaskedDepResult, opts: { fromDate: string; toDate: string }): MaskedDepResult => ({
  ...result,
  fromDate: result.fromDate ?? opts.fromDate,
  toDate: result.toDate ?? opts.toDate,
});

/** The markdown half of the trio: built masked, de-masked on the way to disk. */
function depreciationMarkdown(result: MaskedDepResult): string {
  const period = displayDate(result.fromDate ?? "") === "unknown date"
    ? "Depreciation review"
    : `Depreciation review, ${displayDate(result.fromDate ?? "")} to ${displayDate(result.toDate ?? "")}`;
  const lines: string[] = [
    `# ${period}`,
    "",
    `> **${SEED_BANNER[result.seedSource]}**`,
    "",
    "The block figure is the statutory one; the asset split is an allocation.",
    "",
    "## Blocks",
    "",
    "| Block | Rate % | Opening WDV | Additions ≥ 180 days | Additions < 180 days | Deductions (moneys payable) | Total Act depreciation | Book charge | Difference | Status |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  const bookByBlock = blockBookCharge(result);
  for (const b of result.blocks) {
    const book = bookByBlock.get(b.block) ?? 0;
    lines.push(
      `| ${b.block} | ${b.rate} | ${money(b.openingWdv)} | ${money(b.additionsFull)} | ${money(b.additionsHalf)} | ${money(b.deductions)} | ${money(b.totalDepreciation)} | ${money(book)} | ${money(b.totalDepreciation - book)} | ${b.status} |`,
    );
  }
  lines.push(
    "",
    `**Totals:** Act depreciation ${money(result.blocks.reduce((a, b) => a + b.totalDepreciation, 0))} · additional depreciation ${money(result.blocks.reduce((a, b) => a + b.additionalDepreciation, 0))} · book charge ${money(result.bookCharge)} · s.50 gain ${money(result.blocks.reduce((a, b) => a + b.shortTermGain, 0))} · s.50 loss ${money(result.blocks.reduce((a, b) => a + b.shortTermLoss, 0))} · excluded entries ${result.excluded.length}.`,
    "",
    "## Assets",
    "",
    "| Asset | Block | First-use date | Under 180 days | Act depreciation (allocated) | Book charge | Difference | Notes |",
    "|---|---|---|---|---:|---:|---:|---|",
  );
  for (const a of result.assets) {
    lines.push(
      `| ${a.ledger} | ${a.block} | ${a.firstUse === null ? "" : displayDate(a.firstUse)} | ${a.shortPeriod ? "Yes" : "No"} | ${money(a.actDepreciation)} | ${money(a.bookCharge)} | ${money(a.difference)} | ${a.notes} |`,
    );
  }
  return lines.join("\n");
}

/**
 * The depreciation artifact trio (R-R-4): markdown, de-masked findings CSV
 * and the six-sheet workbook — the writer only de-masks (R-P-5), exactly as
 * `writeTdsReport` does.
 */
export async function writeDepreciationReport(opts: {
  reportDir: string;
  company: string;
  fromDate: string;
  toDate: string;
  result: MaskedDepResult;
  vault: Vault;
}): Promise<{ markdownPath: string; csvPath: string; workbookPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${opts.fromDate}-${opts.toDate}`;
  const markdownPath = join(opts.reportDir, `depreciation-review-${stem}.md`);
  const csvPath = join(opts.reportDir, `depreciation-findings-${stem}.csv`);
  const workbookPath = join(opts.reportDir, `depreciation-review-${stem}.xlsx`);

  await writeFile(
    markdownPath,
    demaskText(depreciationMarkdown(withPeriod(opts.result, opts)), opts.vault),
    "utf8",
  );

  const header = "id,check,severity,ledger,block,amount,detail";
  const rows = opts.result.findings.map((f) =>
    [
      f.id,
      f.check,
      f.severity,
      demaskText(f.ledger, opts.vault),
      f.block,
      f.amount.toFixed(2),
      demaskText(f.detail, opts.vault),
    ]
      .map(csvField)
      .join(","),
  );
  await writeFile(csvPath, [header, ...rows].join("\n"), "utf8");

  await writeWorkbook({
    reportDir: opts.reportDir,
    fileName: `depreciation-review-${stem}.xlsx`,
    sheets: depreciationSheets(withPeriod(opts.result, opts)),
    vault: opts.vault,
  });

  return { markdownPath, csvPath, workbookPath };
}
