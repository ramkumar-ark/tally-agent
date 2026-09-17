#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildTemplateWorkbook, templateFileName } from "./tds-template.js";
import { parseOperatorFile, parseOperatorTemplate, parseWinmanExport } from "./tds-file.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import { connectDownstream } from "./downstream.js";
import { loadOverrides, loadWrongGroup } from "./overrides.js";
import {
  appendAudit,
  writeDepreciationReport,
  writeFaRegisterReport,
  writeGstReport,
  writeLedgerReport,
  writeReport,
  writeTdsReport,
  writeVaultDump,
} from "./report.js";
import {
  createSession,
  type DepReviewResult,
  type FaReviewResult,
  type GstMismatchResult,
  type LedgerScrutinyResult,
  type ReviewResult,
  type Session,
  type TdsReviewResult,
} from "./review.js";

export type ToolRegistrar = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<string>,
) => void;

export type ToolsConfig = Pick<GatewayConfig, "reportDir"> &
  Partial<Pick<GatewayConfig, "defaultCompany" | "dumpVault">>;

/**
 * True when this module is the file node was asked to run.
 *
 * Compared as resolved filesystem paths, never as raw strings: a file URL
 * percent-encodes a space and `process.argv[1]` does not, so a string
 * comparison is false for every install path containing a space — and then
 * main() never runs and the gateway exits 0 in silence, which an MCP client
 * reports only as a server that would not start.
 */
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  let self: string;
  try {
    self = resolve(fileURLToPath(metaUrl));
  } catch {
    return false; // Not a file: URL — nothing was run from disk.
  }
  const invoked = resolve(argv1);
  return process.platform === "win32"
    ? self.toLowerCase() === invoked.toLowerCase()
    : self === invoked;
}

/**
 * The overrides file sits next to the build, not in the working directory.
 * Resolved with fileURLToPath rather than `URL.pathname`, which yields
 * "/C:/..." on Windows — a path fs rejects with ENOENT on every Windows
 * install, spaces or not, which loadOverrides then swallows into "no
 * overrides configured". Overrides are the documented escape hatch for a
 * group name the classifier has not seen, so failing open in silence is a
 * masking hazard.
 */
export function overridesPath(metaUrl: string): string {
  return fileURLToPath(new URL("../config/overrides.json", metaUrl));
}

/** One id per gateway process, naming this session's audit and vault files. */
export function newSessionId(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function registerTools(
  register: ToolRegistrar,
  session: Session,
  cfg: ToolsConfig,
  sessionId: string = newSessionId(),
): void {
  let last: ReviewResult | undefined;
  let lastGst: GstMismatchResult | undefined;
  let lastTds: TdsReviewResult | undefined;
  let lastDep: DepReviewResult | undefined;
  let lastFa: FaReviewResult | undefined;
  /** scrutinyId -> the latest scrutiny of that ledger; a re-run replaces it. */
  const scrutinies = new Map<string, LedgerScrutinyResult>();

  const audit = (tool: string, args: Record<string, unknown>, rows: number, masked: number) =>
    appendAudit(cfg.reportDir, sessionId, {
      at: new Date().toISOString(),
      tool,
      args,
      rows,
      masked,
    });

  register(
    "tb_list_companies",
    "List the companies open in Tally.",
    {},
    async () => {
      const names = await sessionCompanies(session);
      await audit("tb_list_companies", {}, names.length, 0);
      return JSON.stringify({ companies: names }, null, 2);
    },
  );

  register(
    "tb_review",
    "Run the eight trial balance sanity checks as of a date and return masked findings. " +
      "Party ledgers appear as pseudonyms such as 'Creditor 3'; nominal accounts appear by name. " +
      "Drill into a finding with tb_ledger_activity using its id.",
    {
      asOnDate: z.string().describe("As-on date, YYYYMMDD"),
      company: z.string().optional(),
    },
    async (args) => {
      const result = await session.review(args.company ?? cfg.defaultCompany, args.asOnDate);
      last = result;
      const masked = result.findings.filter((f) => /^\w+ \d+$/.test(f.ledger)).length;
      await audit("tb_review", args, result.findings.length, masked);
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_ledger_activity",
    "Voucher-level context for one finding, by finding id. Returns masked rows.",
    {
      findingId: z.string(),
      fromDate: z.string().describe("YYYYMMDD"),
      toDate: z.string().describe("YYYYMMDD"),
    },
    async (args) => {
      const rows = await session.ledgerActivity(args.findingId, args.fromDate, args.toDate);
      await audit("tb_ledger_activity", args, rows.length, rows.length);
      return JSON.stringify(rows, null, 2);
    },
  );

  register(
    "tb_ledger_scrutiny",
    "Scrutinise one ledger over a period, by finding id (from tb_review, tb_gst_mismatch or an " +
      "earlier scrutiny) - never by ledger name. Reconciles opening to closing, tracks the running " +
      "balance side, flags duplicate entries and bill references, unusually large entries, " +
      "round-sum journals, monthly movement spikes and gaps, join gaps, and GST rate anomalies. " +
      "Returns the monthly movement and masked findings with a scrutinyId for tb_write_ledger_report.",
    {
      findingId: z.string(),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
    },
    async (args) => {
      const result = await session.ledgerScrutiny(args.findingId, args.fromDate, args.toDate);
      scrutinies.set(result.scrutinyId, result);
      await audit("tb_ledger_scrutiny", args, result.rowsScanned, maskedCount(result.findings));
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_ledger_report",
    "Write a ledger scrutiny report and findings sheet to disk for one scrutinyId. Real names and " +
      "tax IDs are restored on write; compose the narrative with the pseudonyms you were given.",
    {
      company: z.string(),
      scrutinyId: z.string().describe("The scrutinyId a tb_ledger_scrutiny result returned, e.g. L1"),
      markdown: z.string().describe("The narrative report, in masked terms"),
    },
    async (args) => {
      const s = scrutinies.get(args.scrutinyId);
      if (!s) {
        throw new Error(`run tb_ledger_scrutiny first: there is no scrutiny result for ${args.scrutinyId}`);
      }
      const paths = await writeLedgerReport({
        reportDir: cfg.reportDir,
        company: args.company,
        scrutinyId: s.scrutinyId,
        fromDate: s.fromDate,
        toDate: s.toDate,
        markdown: args.markdown,
        findings: s.findings,
        vault: session.vault,
      });
      await audit(
        "tb_write_ledger_report",
        { company: args.company, scrutinyId: s.scrutinyId },
        s.findings.length,
        0,
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_write_report",
    "Write the review report and findings sheet to disk. Real names are restored on write; " +
      "compose the narrative using the pseudonyms you were given.",
    {
      company: z.string(),
      asOnDate: z.string().describe("YYYYMMDD"),
      markdown: z.string().describe("The narrative report, in masked terms"),
    },
    async (args) => {
      if (!last) throw new Error("run tb_review first: there are no findings to write");
      const paths = await writeReport({
        reportDir: cfg.reportDir,
        company: args.company,
        asOnDate: args.asOnDate,
        markdown: args.markdown,
        findings: last.findings,
        vault: session.vault,
      });
      await audit("tb_write_report", { company: args.company, asOnDate: args.asOnDate }, last.findings.length, 0);
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_gst_summary",
    "Period GST liability per tax head (CGST, SGST/UTGST, IGST, CESS, GST-other): output tax, " +
      "input tax credit, net. Aggregate only - no party data. The first call may be slow; " +
      "the day book fetch is cached for five minutes.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      company: z.string().optional(),
    },
    async (args) => {
      const summary = await session.gstSummary(args.company ?? cfg.defaultCompany, args.fromDate, args.toDate);
      const rows = summary.heads.filter((h) => h.output || h.input).length + summary.taxLedgers.length;
      await audit("tb_gst_summary", { company: args.company, fromDate: args.fromDate, toDate: args.toDate }, rows, 0);
      return JSON.stringify(summary, null, 2);
    },
  );

  register(
    "tb_gst_mismatch",
    "Compare filed GST returns against the books, matched by tax identity in code. " +
      "Pass the PAGE PATH of an operator-prepared JSON returns file - never paste return rows " +
      "into chat, they carry tax IDs. Parties appear as pseudonyms ('Creditor 3', 'TaxId 2'); " +
      "drill into book-party findings with tb_ledger_activity using the finding id.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      returnsPath: z.string().describe("Path to the JSON returns file; its contents are read inside the gateway"),
      company: z.string().optional(),
    },
    async (args) => {
      const text = await readFile(args.returnsPath, "utf8");
      const result = await session.gstMismatch(
        args.company ?? cfg.defaultCompany,
        args.fromDate,
        args.toDate,
        text,
      );
      lastGst = result;
      // The file's path is audited, never its contents: it is the one
      // tax-ID-dense artifact of this milestone.
      await audit("tb_gst_mismatch", { company: args.company, fromDate: args.fromDate, toDate: args.toDate, returnsPath: args.returnsPath }, result.findings.length, maskedCount(result.findings));
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_gst_report",
    "Write the GST review report and findings sheet to disk. Real names and tax IDs are " +
      "restored on write; compose the narrative with the pseudonyms you were given.",
    {
      company: z.string(),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      markdown: z.string().describe("The narrative report, in masked terms"),
    },
    async (args) => {
      if (!lastGst) throw new Error("run tb_gst_mismatch first: there are no GST findings to write");
      const paths = await writeGstReport({
        reportDir: cfg.reportDir,
        company: args.company,
        fromDate: args.fromDate,
        toDate: args.toDate,
        markdown: args.markdown,
        findings: lastGst.findings,
        vault: session.vault,
      });
      await audit(
        "tb_write_gst_report",
        { company: args.company, fromDate: args.fromDate, toDate: args.toDate },
        lastGst.findings.length,
        0,
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_write_tds_template",
    "Generate the fillable Excel TDS operator template (tds-operator-template-<company>-<date>.xlsx) into the " +
      "report directory and return its path. Fill the Sections, Parties, Certificates, Challans and Statements sheets " +
      "in Excel, then pass its path to tb_tds_review as templatePath - never paste its rows into chat.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
    },
    async (args) => {      const outPath = join(
        cfg.reportDir,
        templateFileName(
          args.company,
          new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        ),
      );
      await writeFile(outPath, buildTemplateWorkbook(args.company));
      await audit("tb_write_tds_template", { company: args.company }, 0, 0);
      return JSON.stringify({ templatePath: outPath }, null, 2);
    },
  );

  register(
    "tb_tds_review",
    "TDS compliance review for FY 2025-26: TDS not deducted, short deducted or deducted late; " +
      "deposits missing or late; statements late or missing; s.201(1A) interest, s.234E fee and " +
      "s.40(a)(ia)/s.271C exposures. Pass the PATH of the operator file - the fillable Excel " +
      "template from tb_write_tds_template (templatePath, recommended; optionally plus a Winman " +
      "TDS-summary export as winmanPath) or the legacy JSON (tdsFilePath). Never paste their " +
      "rows into chat, they carry tax identities. Deductees appear as pseudonyms" +
      " ('Creditor 3', 'TaxId 2'); drill in with tb_ledger_activity using the finding id.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      asOnDate: z.string().describe("Deposit/state date, YYYYMMDD"),
      templatePath: z.string().optional().describe("Path to the filled tds-operator-template-*.xlsx; its contents are read inside the gateway"),
      tdsFilePath: z.string().optional().describe("Path to the legacy operator TDS JSON file; templatePath takes precedence, give exactly one"),
      winmanPath: z.string().optional().describe("Optional path to the Winman TDS-summary xlsx export (challans and deductee PANs)"),
      company: z.string().optional(),
      fullCheckPath: z.string().optional().describe("Optional path to an operator day-book JSON export for the coverage reconciliation"),
    },
    async (args) => {
      if (args.templatePath && args.tdsFilePath) {
        throw new Error("give templatePath or tdsFilePath, not both — the template is the recommended channel");
      }
      if (!args.templatePath && !args.tdsFilePath) {
        throw new Error("pass templatePath (the fillable tds-operator-template-*.xlsx from tb_write_tds_template) or the legacy tdsFilePath (JSON)");
      }
      const operator = args.templatePath
        ? parseOperatorTemplate(await readFile(args.templatePath))
        : parseOperatorFile(await readFile(args.tdsFilePath!, "utf8"));
      const winman = args.winmanPath ? parseWinmanExport(await readFile(args.winmanPath)) : undefined;
      const fullCheckText = args.fullCheckPath ? await readFile(args.fullCheckPath, "utf8") : undefined;
      const result = await session.tdsReview(
        args.company ?? cfg.defaultCompany,
        args.fromDate,
        args.toDate,
        args.asOnDate,
        operator,
        args.templatePath ? "template" : "json",
        winman,
        fullCheckText,
      );
      lastTds = result;
      // The files' PATHS are audited, never their contents (the M2 returnsPath contract).
      await audit(
        "tb_tds_review",
        {
          company: args.company,
          fromDate: args.fromDate,
          toDate: args.toDate,
          ...(args.templatePath ? { templatePath: args.templatePath } : {}),
          ...(args.tdsFilePath ? { tdsFilePath: args.tdsFilePath } : {}),
          ...(args.winmanPath ? { winmanPath: args.winmanPath } : {}),
          ...(args.fullCheckPath ? { fullCheckPath: args.fullCheckPath } : {}),
        },
        result.findings.length,
        maskedCountTds(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_tds_report",
    "Write the TDS review report, findings sheet and interest schedule to disk. Real names are " +
      "restored on write; compose the narrative with the pseudonyms you were given.",
    {
      company: z.string(),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      markdown: z.string().describe("The narrative report, in masked terms"),
    },
    async (args) => {
      if (!lastTds) throw new Error("run tb_tds_review first: there are no TDS findings to write");
      const paths = await writeTdsReport({
        reportDir: cfg.reportDir,
        company: args.company,
        fromDate: args.fromDate,
        toDate: args.toDate,
        markdown: args.markdown,
        findings: lastTds.findings,
        vault: session.vault,
      });
      await audit(
        "tb_write_tds_report",
        { company: args.company, fromDate: args.fromDate, toDate: args.toDate },
        lastTds.findings.length,
        0,
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_depreciation_review",
    "Income Tax Act depreciation per block of assets for a year, against what the books charged, " +
      "block-wise and asset-wise (WDV, additional depreciation, s.50). Optionally pass the PATH of the " +
      "operator depreciation file (JSON) to seed verified opening WDV and overrides - never paste its rows " +
      "into chat. Without a file the block seed is the book balance, flagged unverified. " +
      "Asset ledgers appear as pseudonyms such as 'Ledger 2'.",
    {
      company: z.string().optional(),
      fromDate: z.string().describe("YYYYMMDD, the first day of the previous year"),
      toDate: z.string().describe("YYYYMMDD, the last day of the previous year"),
      depreciationFilePath: z.string().optional()
        .describe("Path to the operator depreciation file. The path is read inside the gateway; only the path is audited."),
    },
    async (args) => {
      const operatorText = args.depreciationFilePath
        ? await readFile(args.depreciationFilePath, "utf8")
        : null;
      const result = await session.depreciationReview(
        args.company ?? cfg.defaultCompany,
        args.fromDate,
        args.toDate,
        operatorText,
      );
      lastDep = result;
      // The file's PATH is audited, never its contents (the M2 returnsPath contract).
      await audit(
        "tb_depreciation_review",
        {
          company: args.company,
          fromDate: args.fromDate,
          toDate: args.toDate,
          ...(args.depreciationFilePath ? { depreciationFilePath: args.depreciationFilePath } : {}),
        },
        result.findings.length,
        maskedCount(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_depreciation_report",
    "Write the depreciation review trio (markdown, findings CSV and workbook) to disk. Real names are " +
      "restored on write; the narrative uses the pseudonyms you were given and is generated from the " +
      "review result itself.",
    {
      company: z.string(),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
    },
    async (args) => {
      if (!lastDep) throw new Error("run tb_depreciation_review first: there are no depreciation findings to write");
      const paths = await writeDepreciationReport({
        reportDir: cfg.reportDir,
        company: args.company,
        fromDate: args.fromDate,
        toDate: args.toDate,
        result: lastDep,
        vault: session.vault,
      });
      await audit(
        "tb_write_depreciation_report",
        { company: args.company, fromDate: args.fromDate, toDate: args.toDate },
        lastDep.findings.length,
        0,
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_fixed_asset_register",
    "Fixed asset purchase & sale register for audit: one row per acquisition debit with date, asset, " +
      "block, counterparty, vendor, amount and voucher identification; disposals from asset-ledger credits " +
      "and disposal-signal ledgers; vehicle incidental-cost checks (insurance, RTO, accessories; s.43(1)); " +
      "vehicle-vendor settlement. Accounting PII is masked; voucher numbers appear as Doc N aliases.",
    {
      company: z.string().optional()
        .describe("Company name as in Tally. Omit to use the default company."),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
    },
    async (args) => {
      const result = await session.faRegister(args.company ?? cfg.defaultCompany, args.fromDate, args.toDate);
      lastFa = result;
      await audit(
        "tb_fixed_asset_register",
        { company: args.company, fromDate: args.fromDate, toDate: args.toDate },
        result.findings.length,
        maskedCount(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_fixed_asset_report",
    "Write the fixed asset register trio (markdown, findings CSV and the six-sheet workbook) to disk. " +
      "Real names and voucher numbers are restored on write.",
    {
      company: z.string(),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
    },
    async (args) => {
      if (!lastFa) throw new Error("run tb_fixed_asset_register first: there is no register to write");
      const paths = await writeFaRegisterReport({
        reportDir: cfg.reportDir,
        company: args.company,
        fromDate: args.fromDate,
        toDate: args.toDate,
        result: lastFa,
        vault: session.vault,
      });
      await audit(
        "tb_write_fixed_asset_report",
        { company: args.company, fromDate: args.fromDate, toDate: args.toDate },
        lastFa.findings.length,
        0,
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );
}

function maskedCount(findings: Array<{ ledger: string }>): number {
  return findings.filter((f) => /^(\w+ \d+)$/.test(f.ledger)).length;
}

function maskedCountTds(findings: Array<{ deductee: string }>): number {
  return findings.filter((f) => /^(\w+) \d+$/.test(f.deductee)).length;
}

/** Kept separate so the tool handler stays synchronous to read. */
async function sessionCompanies(session: Session): Promise<string[]> {
  return session.listCompanies();
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const overridesFile = overridesPath(import.meta.url);
  const overrides = loadOverrides(overridesFile, (why) =>
    console.error(`tally-agent: no ledger/group overrides loaded (${why}): ${overridesFile}`),
  );
  const wrongGroup = loadWrongGroup(overridesFile);
  const downstream = await connectDownstream(cfg);
  const session = createSession(downstream, overrides, wrongGroup,
    { tdsRound100: cfg.tdsRound100 });

  const server = new McpServer(
    { name: "tally-agent", version: "0.1.0" },
    {
        instructions:
        "Read-only Tally Prime review (trial balance, GST, single-ledger scrutiny), with accounting PII masked. " +
        "Party ledgers, bank accounts, capital accounts and loan accounts appear as stable " +
        "pseudonyms such as 'Creditor 3'; tax IDs appear as aliases such as 'TaxId 2'; " +
        "voucher numbers appear as aliases such as 'Doc 4'; " +
        "nominal accounts appear by their real names. " +
        "You cannot see the trial balance itself, only the exceptions the checks found. " +
        "Drill into a finding by its id with tb_ledger_activity or tb_ledger_scrutiny, never by ledger name. " +
        "The depreciation review (tb_depreciation_review) and the fixed asset register " +
        "(tb_fixed_asset_register) cover blocks, acquisitions and disposals; the register's " +
        "workbook is written with tb_write_fixed_asset_report. " +
        "Write the report with tb_write_report (or tb_write_gst_report, tb_write_ledger_report) using the pseudonyms; " +
        "real names are restored on write. GST returns data is passed by file path only - " +
        "never paste return rows into chat.",
    },
  );

  registerTools(
    (name, description, schema, handler) => {
      server.tool(name, description, schema as any, async (args: any) => {
        try {
          return { content: [{ type: "text" as const, text: await handler(args ?? {}) }] };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `ERROR: ${e.message}` }],
            isError: true,
          };
        }
      });
    },
    session,
    cfg,
  );

  await server.connect(new StdioServerTransport());
  console.error(`tally-agent gateway running; reports to ${cfg.reportDir}`);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
