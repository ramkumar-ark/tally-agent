import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demaskText } from "./mask.js";
import type { Finding, Severity } from "./types.js";
import { count, money, displayDate } from "./format.js";
import { round2, type BlockResult, type AssetRow, type MovementRow, type ExcludedRow } from "./depreciation.js";
import type { TdsMaskedFinding as TdsCsvFinding, DepMaskedFinding, PfEsiMaskedFinding, As26ReviewResult } from "./review.js";
import type { Clause20bRow } from "./pf-esi.js";
import type { Vault } from "./vault.js";
import { LOANS_SHEET_LABELS, LOANS_SHEET_NAMES, type LoansSheetName, type LoansSheetRow } from "./loans.js";

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
  booksSource: "live" | "daybook-file";
  books?: {
    vouchers: number;
    ledgersProjected: number;
    fromObserved: string;
    toObserved: string;
    rejected: number;
    mastersSource: string;
    bytes: number;
    digest: string;
  };
}): Promise<{ markdownPath: string; csvPath: string; interestCsvPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${opts.fromDate}-${opts.toDate}`;
  const markdownPath = join(opts.reportDir, `tds-review-${stem}.md`);
  const csvPath = join(opts.reportDir, `tds-findings-${stem}.csv`);
  const interestCsvPath = join(opts.reportDir, `tds-interest-schedule-${stem}.csv`);

  const provenance = () =>
    opts.booksSource === "live" || !opts.books
      ? "> **Books source: live Tally** — per-ledger Ledger-Vouchers reports read at review time.\n\n"
      : [
          "> **Books source: operator day-book file** — this review did not read the books from Tally.",
          `> ${count(opts.books.vouchers)} vouchers over ${count(opts.books.ledgersProjected)} ledgers, ${displayDate(
            opts.books.fromObserved,
          )} to ${displayDate(opts.books.toObserved)}, ${
            opts.books.rejected === 0 ? "no rows rejected" : `${count(opts.books.rejected)} rows rejected`
          }.`,
          `> Ledger masters: ${opts.books.mastersSource}. File: ${(opts.books.bytes / 1_048_576).toFixed(1)} MB, sha256 ${opts.books.digest}.`,
          "",
          "",
        ].join("\n");

  const header = "id,check,severity,deductee,group,section,amount,detail,books_source";
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
      opts.booksSource,
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
          opts.booksSource,
        ]
          .map(csvField)
          .join(","),
      );
    }
  }

  await writeFile(markdownPath, provenance() + demaskText(opts.markdown, opts.vault), "utf8");
  await writeFile(csvPath, [header, ...rows].join("\n"), "utf8");
  await writeFile(
    interestCsvPath,
    ["id,check,deductee,section,kind,amount,from,to,basis,books_source", ...schedule].join("\n"),
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

export interface MaskedFaResult {
  company?: string;
  fromDate?: string;
  toDate?: string;
  counts: Record<string, number>;
  purchases: Array<{
    date: string; asset: string; block: string; rate: number | null;
    counterparty: string; vendor: string; amount: number;
    voucherType: string; voucherNumber: string; reference: string;
    acquisitionDate: string; instalment: number; instalments: number;
    acquisitionCost: number; netted: number; rule: string;
    isVehicle: boolean; incidentalSummary: string;
  }>;
  disposals: Array<{
    date: string; asset: string; block: string; counterparty: string; amount: number;
    voucherType: string; voucherNumber: string; reference: string;
    kind: string; rule: string; note: string;
  }>;
  vehicleCosts: Array<{
    vehicle: string; block: string; firstUse: string; costType: string; status: string;
    amount: number; date: string | null; where: string;
    voucherType: string; voucherNumber: string; reference: string;
    ambiguous: boolean; findingId: string;
  }>;
  vendors: Array<{
    vendor: string; vehicles: string[]; acquisitionsTotal: number;
    closingBalance: number; side: string | null; squaredOff: boolean; findingId: string;
  }>;
  findings: Array<{
    id: string; check: string; severity: string; ledger: string; block: string;
    amount: number; detail: string;
  }>;
  assetLedgers: number;
}

/**
 * The fixed asset register workbook, six sheets (D2). Masked in, masked out:
 * `writeWorkbook` de-masks. Cell formatting — dd-mmm-yyyy dates and
 * Indian-grouped money — is applied by the workbook's column formats.
 */
export function fixedAssetSheets(result: MaskedFaResult): Sheet[] {
  const creditDisposals = result.disposals.filter((d) => d.kind !== "disposal-signal");
  const signals = result.disposals.filter((d) => d.kind === "disposal-signal");
  const vehicleFirsts = result.purchases.filter((p) => p.isVehicle && p.instalment === 1);
  const unsettled = result.vendors.filter((v) => !v.squaredOff);

  const summary: Sheet = {
    name: "Summary",
    title: [
      `Fixed asset purchase & sale register, ${displayDate(result.fromDate ?? "")} to ${displayDate(result.toDate ?? "")}`,
      `Asset ledgers: ${result.assetLedgers}; acquisition debits: ${result.purchases.filter((p) => p.rule === "acquisition").length}; ` +
        `rule-3 debits: ${result.purchases.filter((p) => p.rule === "R3").length}; disposal credits: ${creditDisposals.length}; ` +
        `disposal signals: ${signals.length}; vehicle acquisitions: ${vehicleFirsts.length}; vendors: ${result.vendors.length}; findings: ${result.findings.length}`,
      "One row per acquisition debit. Depreciation charges, opening balances and unattributed discounts are outside this register (depreciation review owns them).",
    ],
    columns: [textCol("Figure", 44), moneyCol("Amount")],
    rows: [
      ["Purchases (all debits listed)", round2(result.purchases.reduce((a, p) => a + p.amount, 0))],
      ["Disposal credits (sale + write-off)", round2(creditDisposals.reduce((a, d) => a + d.amount, 0))],
      ["Vehicle acquisitions", round2(vehicleFirsts.reduce((a, p) => a + p.acquisitionCost, 0))],
      ["Vendors not squared off", unsettled.length],
      ["Findings", result.findings.length],
    ],
  };

  const purchases: Sheet = {
    name: "Purchases",
    columns: [
      dateCol("Date"),
      textCol("Asset", 28),
      textCol("Block", 22),
      { header: "Rate %", width: 8, format: "text" },
      textCol("Counterparty", 28),
      textCol("Vendor", 28),
      moneyCol("Debit"),
      textCol("Voucher type", 12),
      textCol("Voucher no.", 22),
      textCol("Reference", 22),
      dateCol("First use"),
      textCol("Instalment", 12),
      moneyCol("Acquisition cost", 18),
      moneyCol("Discount netted", 16),
      { header: "Rule", width: 10, format: "text" },
      { header: "Vehicle", width: 8, format: "text" },
      textCol("Incidental costs", 40),
    ],
    rows: result.purchases.map((p) => [
      p.date,
      p.asset,
      p.block,
      p.rate === null ? "" : String(p.rate),
      p.counterparty,
      p.vendor,
      p.amount,
      p.voucherType,
      p.voucherNumber,
      p.reference,
      p.acquisitionDate,
      p.instalments ? `${p.instalment} / ${p.instalments}` : "",
      p.acquisitionCost,
      p.netted,
      p.rule,
      p.isVehicle ? "yes" : "no",
      p.incidentalSummary,
    ]),
  };

  const disposals: Sheet = {
    name: "Disposals",
    columns: [
      dateCol("Date"),
      textCol("Asset", 28),
      textCol("Block", 22),
      textCol("Counterparty", 28),
      moneyCol("Amount"),
      textCol("Voucher type", 12),
      textCol("Voucher no.", 22),
      textCol("Reference", 22),
      { header: "Kind", width: 15, format: "text" },
      { header: "Rule", width: 8, format: "text" },
      textCol("Note", 44),
    ],
    rows: result.disposals.map((d) => [
      d.date, d.asset, d.block, d.counterparty, d.amount,
      d.voucherType, d.voucherNumber, d.reference, d.kind, d.rule, d.note,
    ]),
  };

  const vehicleCosts: Sheet = {
    name: "Vehicle costs",
    columns: [
      textCol("Vehicle", 28),
      textCol("Block", 22),
      dateCol("First use"),
      { header: "Cost", width: 12, format: "text" },
      { header: "Status", width: 22, format: "text" },
      moneyCol("Amount"),
      dateCol("Date"),
      textCol("Where", 28),
      textCol("Voucher no.", 22),
      { header: "Ambiguous", width: 10, format: "text" },
      textCol("Finding", 12),
    ],
    rows: result.vehicleCosts.map((v) => [
      v.vehicle, v.block, v.firstUse, v.costType, v.status,
      v.amount, v.date ?? "", v.where, v.voucherNumber,
      v.ambiguous ? "yes" : "no", v.findingId,
    ]),
  };

  const vendors: Sheet = {
    name: "Vendors",
    columns: [
      textCol("Vendor", 28),
      textCol("Vehicles", 40),
      moneyCol("Acquisitions"),
      moneyCol("Closing balance", 16),
      { header: "Side", width: 6, format: "text" },
      { header: "Squared off", width: 12, format: "text" },
      textCol("Finding", 12),
    ],
    rows: result.vendors.map((v) => [
      v.vendor, v.vehicles.join("; "), v.acquisitionsTotal,
      v.closingBalance, v.side ?? "", v.squaredOff ? "yes" : "no", v.findingId,
    ]),
  };

  const findings: Sheet = findingsSheet(
    result.findings.map((f) => ({
      id: f.id, check: f.check, severity: f.severity as Severity,
      ledger: f.ledger, group: f.block, amount: f.amount, detail: f.detail,
    })),
  );
  return [summary, purchases, disposals, vehicleCosts, vendors, findings];
}

/** The markdown half: summary + findings, masked; de-masked on the way to disk. */
function fixedAssetMarkdown(result: MaskedFaResult): string {
  const period = displayDate(result.fromDate ?? "") === "unknown date"
    ? "Fixed asset purchase & sale register"
    : `Fixed asset purchase & sale register, ${displayDate(result.fromDate ?? "")} to ${displayDate(result.toDate ?? "")}`;
  const lines: string[] = [
    `# ${period}`,
    "",
    "One row per acquisition debit. Depreciation charges, opening balances and unattributed discounts are outside this register.",
    "",
    `Acquisition debits ${result.purchases.filter((p) => p.rule === "acquisition").length} · ` +
      `rule-3 debits ${result.purchases.filter((p) => p.rule === "R3").length} · ` +
      `disposals ${result.disposals.filter((d) => d.kind !== "disposal-signal").length} · ` +
      `disposal signals ${result.disposals.filter((d) => d.kind === "disposal-signal").length} · ` +
      `vendors ${result.vendors.length} (unsettled ${result.vendors.filter((v) => !v.squaredOff).length}) · ` +
      `findings ${result.findings.length}.`,
    "",
    "## Findings",
    "",
    "| Id | Check | Severity | Ledger | Amount | Detail |",
    "|---|---|---|---|---:|---|",
  ];
  for (const f of result.findings) {
    lines.push(`| ${f.id} | ${f.check} | ${f.severity} | ${f.ledger} | ${money(f.amount)} | ${f.detail} |`);
  }
  return lines.join("\n");
}

/** The register trio (R-R-4): markdown, de-masked findings CSV, six-sheet workbook. */
export async function writeFaRegisterReport(opts: {
  reportDir: string;
  company: string;
  fromDate: string;
  toDate: string;
  result: MaskedFaResult;
  vault: Vault;
}): Promise<{ markdownPath: string; csvPath: string; workbookPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${opts.fromDate}-${opts.toDate}`;
  const markdownPath = join(opts.reportDir, `fixed-asset-register-${stem}.md`);
  const csvPath = join(opts.reportDir, `fixed-asset-findings-${stem}.csv`);
  const workbookPath = join(opts.reportDir, `fixed-asset-register-${stem}.xlsx`);

  const withPeriod = {
    ...opts.result,
    fromDate: opts.result.fromDate ?? opts.fromDate,
    toDate: opts.result.toDate ?? opts.toDate,
  };
  await writeFile(markdownPath, demaskText(fixedAssetMarkdown(withPeriod), opts.vault), "utf8");

  const header = "id,check,severity,ledger,block,amount,detail";
  const rows = withPeriod.findings.map((f) =>
    [
      f.id,
      f.check,
      f.severity,
      demaskText(f.ledger, opts.vault),
      demaskText(f.block, opts.vault),
      f.amount.toFixed(2),
      demaskText(f.detail, opts.vault),
    ]
      .map(csvField)
      .join(","),
  );
  await writeFile(csvPath, [header, ...rows].join("\n"), "utf8");

  await writeWorkbook({
    reportDir: opts.reportDir,
    fileName: `fixed-asset-register-${stem}.xlsx`,
    sheets: fixedAssetSheets(withPeriod),
    vault: opts.vault,
  });

  return { markdownPath, csvPath, workbookPath };
}

/**
 * Task 9's PF/ESI review as the workbook writer consumes it: the findings
 * already masked (de-masking is writeWorkbook's), and the clause 20(b) rows
 * from the cached review with their raw dates — a date-formatted cell needs
 * the YYYYMMDD form to become an Excel date.
 */
export interface PfEsiReportResult {
  company?: string;
  fromDate?: string;
  toDate?: string;
  findings: PfEsiMaskedFinding[];
  rows: Clause20bRow[];
}

/**
 * The clause 20(b) working paper: the auditor sees the delay and the
 * disallowance Winman will compute for itself, before importing. Masked in,
 * masked out: writeWorkbook de-masks. One row per fund per wage month (C5),
 * date-formatted dates and money-formatted amounts.
 */
export function pfEsiSheets(result: PfEsiReportResult): Sheet[] {
  const findings = findingsSheet(
    result.findings.map((f) => ({
      id: f.id, check: f.check, severity: f.severity,
      ledger: f.ledger, group: f.group, amount: f.amount, detail: f.detail,
    })),
  );
  const clause: Sheet = {
    name: "Clause 20(b)",
    title: [
      `PF/ESI employees' contributions, ${displayDate(result.fromDate ?? "")} to ${displayDate(result.toDate ?? "")}`,
      `Due dates are the strict 15th (C1); a deposit after the due date is disallowed under s.36(1)(va). Rows shown: ${result.rows.length}.`,
      `Wage months: ${new Set(result.rows.map((r) => r.wageMonth)).size}; funds: ${new Set(result.rows.map((r) => r.fund)).size}; disallowed rows: ${result.rows.filter((r) => r.disallowed).length}.`,
    ],
    columns: [
      textCol("Fund", 14),
      textCol("Wage Month", 12),
      moneyCol("Amount Collected", 18),
      dateCol("Due Date"),
      moneyCol("Amount Paid", 14),
      dateCol("Paid On"),
      { header: "Delay (days)", width: 12, format: "text" },
      { header: "Disallowed", width: 11, format: "text" },
    ],
    rows: [...result.rows]
      .sort((a, b) => (a.wageMonth < b.wageMonth ? -1 : a.wageMonth > b.wageMonth ? 1 : a.fund < b.fund ? -1 : 1))
      .map((r) => [
        r.fund,
        r.wageMonth,
        r.amountCollected,
        r.dueDate,
        r.amountPaid,
        r.paidOn ?? "",
        r.delayDays,
        r.disallowed ? "yes" : "no",
      ]),
  };
  return [findings, clause];
}

/**
 * The clause 20(b) workbook (R-R-4): a Findings sheet and the Clause 20(b)
 * working paper, de-masked on the way to disk by writeWorkbook.
 */
export async function writePfEsiReport(opts: {
  reportDir: string;
  result: PfEsiReportResult;
  vault: Vault;
}): Promise<{ workbookPath: string }> {
  const stem = `${slug(opts.result.company ?? "pf-esi")}-${opts.result.fromDate ?? ""}-${opts.result.toDate ?? ""}`;
  const workbookPath = join(opts.reportDir, `pf-esi-review-${stem}.xlsx`);
  await writeWorkbook({
    reportDir: opts.reportDir,
    fileName: `pf-esi-review-${stem}.xlsx`,
    sheets: pfEsiSheets(opts.result),
    vault: opts.vault,
  });
  return { workbookPath };
}

/**
 * Task 9's loans review as the workbook writer consumes it: a masked
 * LoansReviewResult is structurally assignable (its extra mastersSource /
 * sectionSummary fields are ignored), and the production tool path passes the
 * RAW flattened rows from Session.loansRows() instead — both channels work,
 * because the family sheets only assume LoansSheetRow and the de-masking is
 * writeWorkbook's (a raw string demasks to itself).
 */
export interface LoansReportResult {
  company?: string;
  fromDate?: string;
  toDate?: string;
  findings: Finding[];
  rows: LoansSheetRow[];
  sheets: Record<LoansSheetName, number>;
}

/**
 * The three family sheets: sheets 1+2 print as "269SS", 3+4+5 as "269T",
 * 6+7 as "269ST" (C5 family grouping; the per-paragraph detail rides the
 * title's label list). Sheets 2/5 are operator-declared rows the books never
 * invent; an absent engine entry just contributes zero rows.
 */
const LOANS_FAMILIES: Array<{
  name: "269SS" | "269T" | "269ST";
  sheetNames: LoansSheetName[];
}> = [
  { name: "269SS", sheetNames: ["sheet1", "sheet2"] },
  { name: "269T", sheetNames: ["sheet3", "sheet4", "sheet5"] },
  { name: "269ST", sheetNames: ["sheet6", "sheet7"] },
];

/**
 * Both row channels render as the same dd-mmm-yyyy text: the raw cache keeps
 * YYYYMMDD (masked rows already carry displayDate form), and displayDate
 * passes a display-formatted date through only when it looks 8-digit —
 * formatted ones ride untouched. A date column therefore never emits a bare
 * 8-digit string (scrubDigits food).
 */
const loansDateCell = (d: string | undefined): string =>
  d && /^\d{8}$/.test(d) ? displayDate(d) : (d ?? "");

/**
 * The loans working-paper sheets (R-R-4): a Findings sheet plus one sheet per
 * statutory family. Masked in, masked out: writeWorkbook de-masks — a raw cached
 * string simply demasks to itself, so the same builder serves both channels.
 * Amounts stay numeric cells (money column format); the rows/total title line
 * is the only place a total is spelled out (through money(), never bare).
 */
export function loansSheets(result: LoansReportResult): Sheet[] {
  // Rows arrive flattened in LOANS_SHEET_NAMES order; slice them back apart
  // on the review's own per-sheet counts (same contract as the Winman writer).
  const counts = LOANS_SHEET_NAMES.map((n) => result.sheets[n] ?? 0);
  const expected = counts.reduce((a, b) => a + b, 0);
  // Self-defending contract: the re-split is driven by the review's own
  // per-sheet counts; a mismatch means whoever built `rows` disagrees, and
  // silent truncation would quietly lose findings evidence. Fail loudly.
  if (expected !== result.rows.length) {
    throw new Error(
      `loans report: row-count contract violated — sheets sum to ${expected} but ${result.rows.length} flattened rows arrived`,
    );
  }
  const bySheet = new Map<LoansSheetName, LoansSheetRow[]>();
  let at = 0;
  LOANS_SHEET_NAMES.forEach((n, i) => {
    bySheet.set(n, result.rows.slice(at, at + counts[i]!));
    at += counts[i]!;
  });
  const period = result.fromDate && result.toDate
    ? `Loans clause 31 / s.269ST review, ${displayDate(result.fromDate)} to ${displayDate(result.toDate)}`
    : "Loans clause 31 / s.269ST review (period not recorded)";
  const clause23Columns: Column[] = [
    textCol("Party", 28),
    textCol("PAN alias", 14),
    moneyCol("Amount"),
    textCol("Mode", 16),
    textCol("Address", 36),
    textCol("Squared up", 11),
    moneyCol("Max amount"),
    textCol("Non-A/c mode", 13),
  ];
  const sheets: Sheet[] = [
    findingsSheet(result.findings),
  ];
  for (const fam of LOANS_FAMILIES) {
    const rows = fam.sheetNames.flatMap((n) => bySheet.get(n) ?? []);
    sheets.push({
      name: fam.name,
      title: [
        period,
        fam.sheetNames.map((n) => LOANS_SHEET_LABELS[n]).join("; "),
        `Rows: ${count(rows.length)}; total ${money(rows.reduce((s, r) => s + r.amount, 0))}.`,
      ],
      columns: fam.name === "269ST"
        ? [
            textCol("Party", 28),
            moneyCol("Amount"),
            textCol("Type", 10),
            textCol("Date", 12),
            textCol("Nature", 40),
            textCol("Bearer", 8),
          ]
        : clause23Columns,
      rows: rows.map((r) =>
        fam.name === "269ST"
          ? [
              r.party,
              r.amount,
              r.type ?? "",
              loansDateCell(r.date),
              r.nature ?? "",
              r.bearer ?? "",
            ]
          : [
              r.party,
              r.panAlias ?? "",
              r.amount,
              r.mode ?? "",
              r.address ?? "",
              r.squaredUp ?? "",
              r.maxAmount ?? "",
              r.nonAcMode ?? "",
            ],
      ),
    });
  }
  return sheets;
}

/**
 * The clause 31 / 269ST working paper workbook (R-R-4), de-masked on the way
 * to disk by writeWorkbook. Both channels write here: the masked review
 * result's rows (alias-bearing, address dropped) de-mask through the vault,
 * and the raw cached rows pass through unaliased. No explicit mkdir —
 * writeWorkbook does it, as for the other review workbooks.
 */
export async function writeLoansReport(opts: {
  reportDir: string;
  result: LoansReportResult;
  vault: Vault;
}): Promise<{ workbookPath: string }> {
  const stem = opts.result.fromDate && opts.result.toDate
    ? `${slug(opts.result.company ?? "loans")}-${opts.result.fromDate}-${opts.result.toDate}`
    : slug(opts.result.company ?? "loans");
  const workbookPath = join(opts.reportDir, `loans-review-${stem}.xlsx`);
  await writeWorkbook({
    reportDir: opts.reportDir,
    fileName: `loans-review-${stem}.xlsx`,
    sheets: loansSheets(opts.result),
    vault: opts.vault,
  });
  return { workbookPath };
}

/** 26AS recon report (R-R-4): de-masked markdown plus the four-sheet
 * workbook — findings as returned, deductor reconciliation, books evidence
 * and the mapping aid (exact 26AS names the operator may paste into
 * config/as26-map.json; only here on disk, never in chat). */
export async function writeAs26Report(opts: {
  reportDir: string;
  company: string;
  fromDate: string;
  toDate: string;
  markdown: string;
  result: As26ReviewResult;
  vault: Vault;
}): Promise<{ markdownPath: string; workbookPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${opts.fromDate}-${opts.toDate}`;
  const markdownPath = join(opts.reportDir, `as26-review-${stem}.md`);
  const workbookPath = join(opts.reportDir, `as26-review-${stem}.xlsx`);

  const findingsSheet: Sheet = {
    name: "Findings",
    columns: [
      { header: "id", width: 14, format: "text" },
      { header: "check", width: 26, format: "text" },
      { header: "severity", width: 10, format: "text" },
      { header: "party", width: 26, format: "text" },
      { header: "kind", width: 6, format: "text" },
      { header: "section", width: 10, format: "text" },
      { header: "amount", width: 16, format: "money" },
      { header: "detail", width: 70, format: "text" },
    ],
    rows: opts.result.findings.map((f) => [
      f.id, f.check, f.severity, f.party, f.kind, f.section, f.amount, f.detail,
    ]),
  };
  const deductorsSheet: Sheet = {
    name: "Deductors",
    columns: [
      { header: "party", width: 26, format: "text" },
      { header: "kind", width: 6, format: "text" },
      { header: "26AS tax", width: 16, format: "money" },
      { header: "books tax", width: 16, format: "money" },
      { header: "delta", width: 16, format: "money" },
      { header: "gross 26AS", width: 16, format: "money" },
      { header: "taxable", width: 16, format: "money" },
      { header: "gross incl GST", width: 16, format: "money" },
      { header: "delta value", width: 16, format: "money" },
      { header: "paired", width: 8, format: "text" },
      { header: "combination", width: 10, format: "text" },
      { header: "ambiguous", width: 10, format: "text" },
      { header: "unmatched", width: 10, format: "text" },
      { header: "search skipped", width: 12, format: "text" },
    ],
    rows: opts.result.recon.map((r) => [
      r.match.ledgerName, r.match.kind, r.as26Tax, r.booksTax,
      round2(r.booksTax - r.as26Tax),
      r.as26GrossValue ?? null, r.booksTaxableValue ?? null, r.booksGrossValue ?? null,
      r.as26GrossValue !== undefined && r.booksGrossValue !== undefined
        ? round2(r.booksGrossValue - r.as26GrossValue) : null,
      String(r.paired.length), String(r.combinations.length),
      String(r.ambiguous), String(r.unmatchedBooks.length + r.unmatchedAs26.length),
      r.combinationSearchSkipped ? "yes" : "no",
    ]),
  };
  const eventsSheet: Sheet = {
    name: "Books Events",
    columns: [
      { header: "party", width: 26, format: "text" },
      { header: "source", width: 10, format: "text" },
      { header: "date", width: 12, format: "text" },
      { header: "tax", width: 14, format: "money" },
      { header: "voucher type", width: 12, format: "text" },
      { header: "ref", width: 16, format: "text" },
    ],
    rows: opts.result.bookEvents.map((e) => [
      e.party, e.source, e.date, e.tax, e.voucherType, e.ref,
    ]),
  };
  const mappingSheet: Sheet = {
    name: "Mapping",
    columns: [
      { header: "26AS name", width: 30, format: "text" },
      { header: "kind", width: 6, format: "text" },
      { header: "26AS tax", width: 14, format: "money" },
      { header: "mapped ledger", width: 30, format: "text" },
      { header: "source", width: 10, format: "text" },
    ],
    rows: [
      ...opts.result.recon.map((r) => [
        r.match.as26Name, r.match.kind, r.as26Tax, r.match.ledgerName, r.match.source,
      ]),
      ...opts.result.gaps.map((g) => [
        g.name, g.kind, g.tax, g.ledger ?? "", g.reason,
      ]),
    ],
  };

  await writeFile(
    markdownPath,
    demaskText(opts.markdown, opts.vault) + "\n",
    "utf8",
  );
  await writeWorkbook({
    reportDir: opts.reportDir,
    fileName: `as26-review-${stem}.xlsx`,
    sheets: [findingsSheet, deductorsSheet, eventsSheet, mappingSheet],
    vault: opts.vault,
  });
  return { markdownPath, workbookPath };
}
