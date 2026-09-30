#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildTemplateWorkbook, templateFileName } from "./tds-template.js";
import { buildPfEsiTemplate, pfEsiTemplateFileName } from "./pf-esi-template.js";
import { buildWorkbook } from "./xlsx.js";
import {
  buildLoansTemplateWorkbook,
  loansTemplateFileName,
} from "./loans-file.js";
import { buildDep3cdTemplate, dep3cdTemplateFileName } from "./dep3cd-file.js";
import { DEFAULT_BLOCK_LISTS } from "./dep3cd-law.js";
import { parseRateFromGroup } from "./depreciation.js";
import { readXlsm } from "./xlsm.js";
import { readListValues } from "./winman3cd.js";
import { buildNotdsTemplate, notdsTemplateFileName } from "./notds-template.js";
import { parseOperatorFile, parseOperatorTemplate, parseWinmanExport } from "./tds-file.js";
import { EMPTY_PF_ESI, parsePfEsiTemplate } from "./pf-esi-file.js";
import { buildGst44Template, gst44TemplateFileName } from "./gst44-template.js";
import { EMPTY_GST44, parseGst44Template } from "./gst44-file.js";
import { gstWorksheetFileName } from "./gst44-worksheet-template.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import { connectDownstream } from "./downstream.js";
import { loadOverrides, loadPfEsiLedgers, loadWrongGroup } from "./overrides.js";
import { parseAs26Export } from "./as26-file.js";
import {
  as26TemplateFileName,
  buildAs26MapTemplate,
  loadAs26MapFile,
  templateDeductors,
} from "./as26-template.js";
import {
  appendAudit,
  writeDepreciationReport,
  writeFaRegisterReport,
  writeGstReport,
  writeGst44Report,
  writeLedgerReport,
  writeReport,
  writeAs26Report,
  writePfEsiReport,
  writeLoansReport,
  writeDep3cdReport,
  writeTdsReport,
  writeVaultDump,
} from "./report.js";
import {
  createSession,
  type As26ReviewResult,
  type DepReviewResult,
  type Dep3cdReviewResult,
  type FaReviewResult,
  type Gst44ReviewResult,
  type GstMismatchResult,
  type LedgerScrutinyResult,
  type PfEsiReviewResult,
  type ReviewResult,
  type Session,
  type TdsReviewResult,
} from "./review.js";
import {
  LOANS_SHEET_NAMES,
  bankLenderNameMatch,
  buildLoansCtx,
  type LoansReviewResult,
} from "./loans.js";
import {
  loadDayBookText,
  readDayBook,
  readDayBookLedgerNames,
  readDayBookMasterPairs,
  type DayBookInput,
} from "./tds-daybook.js";
import { registerWorkflowTools } from "./workflow.js";

export type ToolRegistrar = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<string>,
) => void;

export type ToolsConfig = Pick<GatewayConfig, "reportDir"> &
  Partial<Pick<GatewayConfig, "defaultCompany" | "dumpVault" | "downstreamArgs">> &
  Pick<GatewayConfig, "dayBookMaxBytes">;

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

/** The 26AS operator party map sits next to the build like the overrides. */
export function as26MapPath(metaUrl: string): string {
  return fileURLToPath(new URL("../config/as26-map.json", metaUrl));
}

/** One id per gateway process, naming this session's audit and vault files. */
export function newSessionId(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function registerTools(
  outerRegister: ToolRegistrar,
  session: Session,
  cfg: ToolsConfig,
  sessionId: string = newSessionId(),
): void {
  // Every handler is kept in-process so the workflow tools can call them
  // directly (one step per run call) without another MCP hop.
  const handlers = new Map<string, (args: any) => Promise<string>>();
  const register: ToolRegistrar = (name, description, schema, handler) => {
    handlers.set(name, handler);
    outerRegister(name, description, schema, handler);
  };
  let last: ReviewResult | undefined;
  let lastGst: GstMismatchResult | undefined;
  let lastTds: TdsReviewResult | undefined;
  let lastAs26: As26ReviewResult | undefined;
  let lastDayBookMeta: { bytes: number; digest: string } | undefined;
  let lastDep: DepReviewResult | undefined;
  let lastFa: FaReviewResult | undefined;
  let lastPfEsi: PfEsiReviewResult | undefined;
  let lastLoans: LoansReviewResult | undefined;
let lastGst44: Gst44ReviewResult | undefined;
  let lastDep3cd: Dep3cdReviewResult | undefined;
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
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      const outDir = args.outDir ?? cfg.reportDir;
      const outPath = join(
        outDir,
        templateFileName(
          args.company,
          new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        ),
      );
      await mkdir(outDir, { recursive: true });
      await writeFile(outPath, buildTemplateWorkbook(args.company));
      await audit("tb_write_tds_template", { company: args.company, outDir }, 0, 0);
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
      " ('Creditor 3', 'TaxId 2'); drill in with tb_ledger_activity using the finding id." +
      " Pass dayBookPath to run the books from an operator export instead of reading ~640 per-ledger reports from Tally; the result and the written report both say which was used.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      asOnDate: z.string().describe("Deposit/state date, YYYYMMDD"),
      templatePath: z.string().optional().describe("Path to the filled tds-operator-template-*.xlsx; its contents are read inside the gateway"),
      tdsFilePath: z.string().optional().describe("Path to the legacy operator TDS JSON file; templatePath takes precedence, give exactly one"),
      winmanPath: z.string().optional().describe("Optional path to the Winman TDS-summary xlsx export (challans and deductee PANs)"),
      dayBookPath: z
        .string()
        .optional()
        .describe(
          "Optional PATH to an operator day-book JSON export for the whole period. When given, the " +
            "books are read from that file instead of from Tally (no per-ledger calls). Pass the path — " +
            "never paste the file's rows into chat.",
        ),
      company: z.string().optional(),
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
      let dayBook: DayBookInput | undefined;
      let dayBookMeta: { bytes: number; digest: string } | undefined;
      if (args.dayBookPath) {
        const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
        dayBook = readDayBook(text, {
          company: args.company ?? cfg.defaultCompany,
          fromDate: args.fromDate,
          toDate: args.toDate,
        });
        dayBookMeta = {
          bytes: Buffer.byteLength(text, "utf8"),
          digest: createHash("sha256").update(text).digest("hex"),
        };
      }
      lastDayBookMeta = dayBookMeta;
      const result = await session.tdsReview(
        args.company ?? cfg.defaultCompany,
        args.fromDate,
        args.toDate,
        args.asOnDate,
        operator,
        args.templatePath ? "template" : "json",
        winman,
        dayBook,
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
          ...(args.dayBookPath ? { dayBookPath: args.dayBookPath } : {}),
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
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!lastTds) throw new Error("run tb_tds_review first: there are no TDS findings to write");
      const paths = await writeTdsReport({
        reportDir: args.outDir ?? cfg.reportDir,
        company: args.company,
        fromDate: args.fromDate,
        toDate: args.toDate,
        markdown: args.markdown,
        findings: lastTds.findings,
        vault: session.vault,
        booksSource: lastTds.booksSource,
        ...(lastTds.books && lastDayBookMeta
          ? { books: { ...lastTds.books, ...lastDayBookMeta } }
          : {}),
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
    "tb_write_26as_template",
    "Generate the fillable Excel 26AS party-mapping template (as26-map-template-<company>-<date>.xlsx) " +
      "into the report directory and return its path. It pre-fills one row per 26AS deductor/collector " +
      "with the Tally ledger already in effect; type the matching Tally ledger into the \"Tally ledger\" " +
      "column, then pass its path to tb_26as_review as as26MapPath — never paste its rows into chat. " +
      "The blank 'Bank Interest' sheet marks 26AS banks and their interest income/FD ledgers; " +
      "a bank named there reconciles its 194A entries on totals, never bill by bill.",
    {
      as26Path: z.string()
        .describe("Path to the TRACES Form 26AS export (.xlsm); read inside the gateway, only the path is audited"),
      as26MapPath: z.string().optional()
        .describe(
          "Optional PATH to the operator party map already in effect (JSON or a filled .xlsx template); " +
            "its rows are pre-filled so the template can be re-filled iteratively. Defaults to config/as26-map.json.",
        ),
      dayBookPath: z.string().optional()
        .describe(
          "Optional PATH to an operator day-book export; when given its ledger list fills the template's " +
            "dropdown/reference sheet instead of live Tally masters.",
        ),
      company: z.string().optional(),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      const file = parseAs26Export(await readFile(args.as26Path));
      const map = loadAs26MapFile(
        args.as26MapPath ?? as26MapPath(import.meta.url),
        (why) => console.error(`tally-agent: ${why}`),
      );
      let ledgers: string[] = [];
      if (args.dayBookPath) {
        const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
        ledgers = readDayBookLedgerNames(text, args.company ?? cfg.defaultCompany);
      }
      if (ledgers.length === 0) ledgers = await session.ledgerNames(args.company ?? cfg.defaultCompany);
      const deductors = templateDeductors(file);
      const outPath = join(
        args.outDir ?? cfg.reportDir,
        as26TemplateFileName(
          args.company,
          new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        ),
      );
      await mkdir(args.outDir ?? cfg.reportDir, { recursive: true });
      await writeFile(outPath, buildAs26MapTemplate({ company: args.company, deductors, map, ledgers }));
      await audit(
        "tb_write_26as_template",
        {
          company: args.company,
          as26Path: args.as26Path,
          ...(args.as26MapPath ? { as26MapPath: args.as26MapPath } : {}),
          ...(args.dayBookPath ? { dayBookPath: args.dayBookPath } : {}),
          outDir: args.outDir ?? null,
        },
        deductors.length,
        0,
      );
      return JSON.stringify(
        { templatePath: outPath, deductors: deductors.length, ledgers: ledgers.length },
        null,
        2,
      );
    },
  );

  register(
    "tb_26as_review",
    "Tally-books vs TRACES Form 26AS reconciliation: TDS/TCS tax booked but absent from 26AS, " +
      "26AS tax the books never booked, gross-vs-taxable valuation mismatch, mapping gaps, " +
      "late booking and export self-consistency, totals-only 194R/bank-194A reconciliation and " +
      "20%-taxed FD interest reporting. Pass the PATH of the TRACES Form 26AS export " +
      "(.xlsm) — never paste its rows into chat; parties appear as pseudonyms; drill in with " +
      "tb_ledger_activity using finding ids. Correct the party mapping by passing the filled " +
      "template from tb_write_26as_template as as26MapPath. The books come from live Tally: every " +
      "TDS/TCS receivable voucher is read with its full entry composition, so a journal that also moves " +
      "funds between the company's own ledgers is still attributed to its own deductor. Pass dayBookPath " +
      "to read the books from an operator day-book export instead — faster, and the way to reconcile a " +
      "whole financial year, since the live read exports the period's vouchers and cannot carry a year " +
      "over stdio.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      as26Path: z.string()
        .describe("Path to the TRACES Form 26AS export (.xlsm); read inside the gateway, only the path is audited"),
      dayBookPath: z.string().optional()
        .describe(
          "Optional PATH to an operator day-book JSON export covering the whole period " +
            "(scripts/export-daybook.mjs); when given, the books are read from that file instead of live " +
            "Tally. Pass the path — never paste the rows.",
        ),
      company: z.string().optional(),
      as26MapPath: z.string().optional()
        .describe(
          "Optional PATH to the operator party map: the fillable .xlsx template from " +
            "tb_write_26as_template, or the JSON ({ mappings: [{ ledger, as26Name }] }); " +
            "dispatched by extension. Defaults to config/as26-map.json next to the build. " +
            "The path is audited, never its rows.",
        ),
    },
    async (args) => {
      const file = parseAs26Export(await readFile(args.as26Path));
      let dayBook: DayBookInput | undefined;
      if (args.dayBookPath) {
        const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
        dayBook = readDayBook(text, {
          company: args.company ?? cfg.defaultCompany,
          fromDate: args.fromDate,
          toDate: args.toDate,
        });
      }
      const result = await session.as26Review(
        args.company ?? cfg.defaultCompany,
        args.fromDate,
        args.toDate,
        file,
        args.as26MapPath ?? as26MapPath(import.meta.url),
        dayBook,
      );
      lastAs26 = result;
      await audit(
        "tb_26as_review",
        {
          company: args.company,
          fromDate: args.fromDate,
          toDate: args.toDate,
          as26Path: args.as26Path,
          ...(args.dayBookPath ? { dayBookPath: args.dayBookPath } : {}),
          ...(args.as26MapPath ? { as26MapPath: args.as26MapPath } : {}),
        },
        result.findings.length,
        maskedCountAs26(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_26as_report",
    "Write the 26AS reconciliation report (markdown plus workbook: findings, deductor " +
      "reconciliation, books evidence and the 26AS-name mapping aid) to disk. Real names are " +
      "restored on write; compose the narrative with the pseudonyms you were given.",
    {
      company: z.string(),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      markdown: z.string().describe("The narrative report, in masked terms"),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!lastAs26) throw new Error("run tb_26as_review first: there are no 26AS findings to write");
      const paths = await writeAs26Report({
        reportDir: args.outDir ?? cfg.reportDir,
        company: args.company,
        fromDate: args.fromDate,
        toDate: args.toDate,
        markdown: args.markdown,
        result: lastAs26,
        vault: session.vault,
      });
      await audit(
        "tb_write_26as_report",
        { company: args.company, fromDate: args.fromDate, toDate: args.toDate },
        lastAs26.findings.length,
        0,
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_write_pf_esi_template",
    "Generate the fillable Excel PF/ESI operator template (pf-esi-operator-template-<company>-<date>.xlsx) " +
      "into the report directory and return its path. Fill the Challans sheet in Excel - one row per " +
      "challan or ECR payment - then pass its path to tb_pf_esi_review as templatePath; never paste its rows into chat.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      const outDir = args.outDir ?? cfg.reportDir;
      const outPath = join(
        outDir,
        pfEsiTemplateFileName(
          args.company,
          new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        ),
      );
      await writeFile(outPath, buildPfEsiTemplate(args.company));
      await audit("tb_write_pf_esi_template", { company: args.company, outDir }, 0, 0);
      return JSON.stringify({ templatePath: outPath }, null, 2);
    },
  );

  register(
    "tb_pf_esi_review",
    "Winman Form 3CD clause 20(b) review - PF/ESI employees' contributions: extraction from the books, " +
      "the strict 15th due date, s.36(1)(va) disallowance for late deposits, missing or amount-mismatched " +
      "challans. Pass the PATH of the filled PF/ESI operator template from tb_write_pf_esi_template as " +
      "templatePath and optionally the PATH of a day-book JSON export as dayBookPath - the day book is the " +
      "primary books channel; never paste either file's rows into chat. Fund payable ledgers appear as " +
      "pseudonyms such as 'Ledger 2'. Run tb_write_3cd_pf_esi afterwards to write the Winman sheets.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      templatePath: z.string().optional().describe("Path to the filled pf-esi-operator-template-*.xlsx; read inside the gateway"),
      dayBookPath: z
        .string()
        .optional()
        .describe(
          "Optional PATH to an operator day-book JSON export for the whole period. When given, the books are " +
            "read from that file instead of from Tally. Pass the path - never paste the file's rows into chat.",
        ),
      overridesPath: z
        .string()
        .optional()
        .describe(
          "Optional PATH to an overrides JSON carrying pfEsiLedgers ({ pf: [...], esi: [...] }); defaults to the gateway's config/overrides.json",
        ),
      company: z.string().optional(),
    },
    async (args) => {
      // Path-only channels: the file contents are parsed here, inside the
      // gateway; what crosses back is the review result with names masked.
      const operator = args.templatePath
        ? parsePfEsiTemplate(await readFile(args.templatePath))
        : EMPTY_PF_ESI;
      const pfOverrides = args.overridesPath
        ? loadPfEsiLedgers(args.overridesPath, (why) =>
            console.error(`tally-agent: no per-call PF/ESI ledger overrides loaded (${why}): ${args.overridesPath}`),
          )
        : undefined;
      let dayBook: DayBookInput | undefined;
      let digest: string | undefined;
      if (args.dayBookPath) {
        const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
        dayBook = readDayBook(text, {
          company: args.company ?? cfg.defaultCompany,
          fromDate: args.fromDate,
          toDate: args.toDate,
        });
        digest = createHash("sha256").update(text).digest("hex");
      }
      const result = await session.pfEsiReview({
        company: args.company ?? cfg.defaultCompany,
        fromDate: args.fromDate,
        toDate: args.toDate,
        operator,
        dayBook,
        pfOverrides,
      });
      lastPfEsi = result;
      // The files' PATHS are audited, never their contents (the M2 contract;
      // the digest records which day book the run consumed, never its rows).
      await audit(
        "tb_pf_esi_review",
        {
          company: args.company,
          fromDate: args.fromDate,
          toDate: args.toDate,
          ...(args.templatePath ? { templatePath: args.templatePath } : {}),
          ...(args.dayBookPath ? { dayBookPath: args.dayBookPath } : {}),
          ...(args.overridesPath ? { overridesPath: args.overridesPath } : {}),
          ...(digest ? { dayBookDigest: digest } : {}),
        },
        result.findings.length,
        maskedCount(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_3cd_pf_esi",
    "Write the clause 20(b) rows of the last tb_pf_esi_review into the P.F. and E.S.I. sheets of a COPY of " +
      "the operator's Winman 3CD workbook and return the copy's path. The copy is written to the report " +
      "directory (or outPath) as '<source stem> - filled - <date>.xlsm'; the source workbook is never modified. " +
      "Compose nothing by hand: the sheets carry the due dates, deposit dates and amounts from the review.",
    {
      sourcePath: z.string().describe("Path to the operator's Winman `PF ESI funds.xlsm`; read only, never written"),
      outPath: z.string().optional().describe("Directory for the filled copy; defaults to the report directory"),
    },
    async (args) => {
      const outPath = await session.write3cdPfEsi({
        sourcePath: args.sourcePath,
        outPath: args.outPath ?? cfg.reportDir,
      });
      await audit(
        "tb_write_3cd_pf_esi",
        { sourcePath: args.sourcePath, outPath: args.outPath ?? null },
        0,
        0,
      );
      return JSON.stringify({ outPath }, null, 2);
    },
  );

  register(
    "tb_write_gst44_template",
    "Generate the fillable clause-44 GST operator template (gst-44-operator-template-<company>-<date>.xlsx) " +
      "into the report directory and return its path. Fill the GST Status sheet in Excel - one row per ledger " +
      "whose GST status you know better than the books (composition dealers, corrections, or when Tally is down) - " +
      "then pass its path to tb_gst44_review as templatePath; never paste its rows into chat.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
      dayBookPath: z.string().optional().describe(
        "Optional PATH to a day-book JSON export; its ledgers[] feed the Ledger column's dropdown",
      ),
    },
    async (args) => {
      // Path-only channel: the day book is read inside the gateway; only the
      // path is audited, never its rows.
      let ledgers: string[] = [];
      if (args.dayBookPath) {
        ledgers = readDayBookLedgerNames(
          await readFile(args.dayBookPath, "utf8"),
          args.company ?? cfg.defaultCompany,
        );
      } else {
        ledgers = await session.ledgerNames(args.company ?? cfg.defaultCompany);
      }
      const outDir = args.outDir ?? cfg.reportDir;
      const outPath = join(
        outDir,
        gst44TemplateFileName(args.company, new Date().toISOString().slice(0, 10).replace(/-/g, "")),
      );
      await writeFile(outPath, buildGst44Template({ company: args.company, ledgers }));
      await audit("tb_write_gst44_template", { company: args.company, outDir, dayBookPath: args.dayBookPath ?? null }, 0, 0);
      return JSON.stringify({ templatePath: outPath }, null, 2);
    },
  );

  register(
    "tb_write_3cd_gst44",
    "Write the clause 44 rows into the Break-up of GST expenditure sheet of a COPY of the operator's Winman 3CD " +
      "workbook and return the copy's path. The copy is written to the report directory (or outPath) as " +
      "'<source stem> - filled - <date>.xlsm'; the source workbook is never modified. Compose nothing by hand. " +
      "By default the rows come from the last tb_gst44_review; pass worksheetPath to take them from the " +
      "operator's APPROVED GST nature-wise break-up working sheet instead (its per-ledger treatments are the " +
      "authority — only use a sheet the captain has approved).",
    {
      sourcePath: z.string().describe("Path to the operator's Winman `Break-up of GST expenditure.xlsm`; read only, never written"),
      outPath: z.string().optional().describe("Directory for the filled copy; defaults to the report directory"),
      worksheetPath: z
        .string()
        .optional()
        .describe("Optional path to the approved GST nature-wise break-up working sheet to source the totals from"),
    },
    async (args) => {
      const outPath = await session.write3cdGst44({
        sourcePath: args.sourcePath,
        outPath: args.outPath ?? cfg.reportDir,
        ...(args.worksheetPath ? { worksheetPath: args.worksheetPath } : {}),
      });
      await audit("tb_write_3cd_gst44", { sourcePath: args.sourcePath, outPath: args.outPath ?? null, worksheetPath: args.worksheetPath ?? null }, 0, 0);
      return JSON.stringify({ outPath }, null, 2);
    },
  );

  register(
    "tb_write_gst44_report",
    "Write the clause 44 review workbook to disk: a Findings sheet, the Clause 44 break-up " +
      "matrix (capital/revenue rows split by supplier GST status - what Winman will import) and " +
      "the per-party long format (Party | Bucket | Capital | Revenue) so each bucket can be traced " +
      "to ledgers. Real names are restored on write; compose nothing by hand - it is generated " +
      "from the last tb_gst44_review.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!lastGst44) throw new Error("run tb_gst44_review first: there are no clause 44 findings to write");
      const paths = await writeGst44Report({
        reportDir: args.outDir ?? cfg.reportDir,
        result: {
          company: args.company ?? lastGst44.company,
          fromDate: lastGst44.fromDate,
          toDate: lastGst44.toDate,
          findings: lastGst44.findings,
          // The matrix cells come from the cached raw rows; the review
          // result's own rows are display-shaped for the model.
          rows: session.gst44Rows() ?? [],
          parties: lastGst44.parties,
        },
        vault: session.vault,
      });
      await audit(
        "tb_write_gst44_report",
        { company: args.company ?? lastGst44.company ?? null },
        lastGst44.findings.length,
        maskedCount(lastGst44.findings),
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_gst44_review",
    "Winman Form 3CD clause 44 review - break-up of total expenditure into GST categories: capital/revenue " +
      "rows split by supplier GST status (registered exempt / composition / others / unregistered), computed from " +
      "the books. Pass the PATH of a day-book JSON export as dayBookPath and optionally the PATH of the filled " +
      "gst-44 operator template as templatePath - never paste either file's rows into chat. Parties appear as " +
      "pseudonyms such as 'Ledger 2'. Run tb_write_3cd_gst44 afterwards to write the Winman sheet.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      templatePath: z.string().optional().describe("Path to the filled gst-44-operator-template-*.xlsx; read inside the gateway"),
      dayBookPath: z.string().optional().describe(
        "Optional PATH to an operator day-book JSON export for the whole period. When given, the books are " +
          "read from that file instead of from Tally. Pass the path - never paste the file's rows into chat.",
      ),
      company: z.string().optional(),
    },
    async (args) => {
      // Path-only channels: both files are read and parsed here, inside the
      // gateway; what crosses back is the review result with names masked.
      const operator = args.templatePath
        ? parseGst44Template(await readFile(args.templatePath))
        : EMPTY_GST44;
      let dayBook: DayBookInput | undefined;
      let digest: string | undefined;
      if (args.dayBookPath) {
        const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
        dayBook = readDayBook(text, {
          company: args.company ?? cfg.defaultCompany,
          fromDate: args.fromDate,
          toDate: args.toDate,
        });
        digest = createHash("sha256").update(text).digest("hex");
      }
      const result = await session.gst44Review({
        company: args.company ?? cfg.defaultCompany,
        fromDate: args.fromDate,
        toDate: args.toDate,
        operator,
        dayBook,
      });
      lastGst44 = result;
      await audit(
        "tb_gst44_review",
        {
          company: args.company,
          fromDate: args.fromDate,
          toDate: args.toDate,
          ...(args.templatePath ? { templatePath: args.templatePath } : {}),
          ...(args.dayBookPath ? { dayBookPath: args.dayBookPath } : {}),
          ...(digest ? { dayBookDigest: digest } : {}),
        },
        result.findings.length,
        maskedCount(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_gst_working_sheet",
    "Generate the GST nature-wise break-up WORKING SHEET for the year: REVENUE and CAPITAL sheets in the " +
      "prior-year hand-prepared layout (one row per expense / fixed-asset ledger; the operator fills only the " +
      "exempt / composite / unregistered / not-supply columns and the rest derive), seeded per ledger from a " +
      "generic treatment vocabulary, the prior-year sheet and the books' GSTIN evidence. Review and correct the " +
      "seeded columns in Excel; nothing is written into any Winman workbook until the captain plainly approves " +
      "the working-sheet totals. Pass the PATH of the day-book JSON export - never paste its rows into chat. " +
      "Ledger names appear as pseudonyms in this result.",
    {
      dayBookPath: z.string().describe("PATH to the day-book JSON export for the whole period; read inside the gateway"),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      priorSheetPath: z.string().optional().describe(
        "PATH to the prior-year 'GST INWARD SUPPLY - NATURE WISE BREAK UP' .xlsx; read only, never written, seeds treatments for exact ledger-name matches",
      ),
      rulesPath: z.string().optional().describe("PATH to a treatment-rules JSON ({rules:[...]}) extending the built-in vocabulary"),
      company: z.string().optional(),
      outPath: z.string().optional().describe("File path for the working sheet; defaults to next to the day book"),
    },
    async (args) => {
      const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
      const dayBook = readDayBook(text, {
        company: args.company ?? cfg.defaultCompany,
        fromDate: args.fromDate,
        toDate: args.toDate,
      });
      const digest = createHash("sha256").update(text).digest("hex");
      const priorYear = args.priorSheetPath ? await readFile(args.priorSheetPath) : undefined;
      const outPath =
        args.outPath ??
        join(
          dirname(args.dayBookPath),
          gstWorksheetFileName(
            args.company ?? cfg.defaultCompany,
            new Date().toISOString().slice(0, 10).replace(/-/g, ""),
          ),
        );
      const result = await session.writeGstWorksheet({
        company: args.company ?? cfg.defaultCompany,
        fromDate: args.fromDate,
        toDate: args.toDate,
        dayBook,
        priorYear,
        rulesPath: args.rulesPath,
        outPath,
      });
      await audit(
        "tb_write_gst_working_sheet",
        {
          company: args.company ?? null,
          fromDate: args.fromDate,
          toDate: args.toDate,
          dayBookPath: args.dayBookPath,
          dayBookDigest: digest,
          ...(args.priorSheetPath ? { priorSheetPath: args.priorSheetPath } : {}),
          ...(args.rulesPath ? { rulesPath: args.rulesPath } : {}),
          outPath,
        },
        result.findings.length,
        maskedCount(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_3cd_tds_tcs",
    "Write the clause 34 TDS/TCS rows of the last tb_tds_review into the TDS, TCS, Return details and " +
      "interest sheets of a COPY of the operator's Winman 3CD workbook and return the copy's path with " +
      "per-sheet row counts. The copy is written to the report directory (or outPath) as '<source stem> " +
      "- filled - <date>.xlsm'; the source workbook is never modified. The sheets actually carry the " +
      "operator TAN and company name, like the returns they transcribe; the response is counts only.",
    {
      sourcePath: z.string().describe("Path to the operator's Winman 3CD .xlsm; read only, never written"),
      outPath: z.string().optional().describe("Directory for the filled copy; defaults to the report directory"),
    },
    async (args) => {
      const path = await session.write3cdTdsTcs({
        sourcePath: args.sourcePath,
        outPath: args.outPath ?? cfg.reportDir,
      });
      const cached = session.tds3cdResult();
      const sheets = {
        tds: cached?.tds.length ?? 0,
        tcs: cached?.tcs.length ?? 0,
        returns: cached?.returns.length ?? 0,
        interestTds: cached?.interestTds.length ?? 0,
        interestTcs: cached?.interestTcs.length ?? 0,
      };
      await audit(
        "tb_write_3cd_tds_tcs",
        { sourcePath: args.sourcePath, outPath: args.outPath ?? null },
        0,
        0,
      );
      return JSON.stringify({ path, sheets }, null, 2);
    },
  );

  register(
    "tb_write_notds_template",
    "Generate the fillable Excel No-TDS operator template (notds-operator-template-<company>-<date>.xlsx) " +
      "out of a cached tb_tds_review's clause 21(b) candidate rows, into the report directory, and return its " +
      "PATH. Fill the Include / Residency / NR Section / Nature / PAN columns in Excel - one row per candidate, " +
      "manual rows on the Manual Rows sheet - then pass its PATH to tb_notds_review as templatePath; never " +
      "paste its rows into chat. Requires tb_tds_review to have run first.",
    {
      company: z.string().describe("Company name, used only in the file name"),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      // The template seed is the cached TDS review's books candidates, not a
      // live call: the template restates what the cached review saw.
      const candidates = session.notdsCandidates();
      if (!candidates) {
        throw new Error("run tb_tds_review first: it caches the books the clause 21(b) template seeds from");
      }
      const outDir = args.outDir ?? cfg.reportDir;
      const outPath = join(
        outDir,
        notdsTemplateFileName(
          args.company,
          new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        ),
      );
      await writeFile(outPath, buildNotdsTemplate({
        company: args.company,
        candidates,
        generatedOn: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
      }));
      await audit("tb_write_notds_template", { company: args.company, outDir }, candidates.length, 0);
      return JSON.stringify({ templatePath: outPath }, null, 2);
    },
  );

  register(
    "tb_notds_review",
    "Clause 21(b) (No TDS Disallowance) review: merge the clause 21(b) candidates of the last tb_tds_review " +
      "with the operator's decisions workbook (Pass the PATH of the filled notds-operator-template-*.xlsx as " +
      "templatePath; never paste its rows into chat). Include=N rows vanish with their cure reason restated; " +
      "an NR mark routes a row to the non-resident sheet under the operator's NR section spelling. Names appear " +
      "as pseudonyms; no PAN anywhere. Run tb_write_3cd_notds afterwards to fill the Winman sheets.",
    {
      templatePath: z.string().optional().describe("Path to the filled notds-operator-template-*.xlsx; read inside the gateway"),
    },
    async (args) => {
      const result = await session.noTdsReview({
        ...args,
      });
      await audit(
        "tb_notds_review",
        {
          company: result.company ?? null,
          fromDate: result.fromDate,
          toDate: result.toDate,
          ...(args.templatePath ? { templatePath: args.templatePath } : {}),
        },
        result.findings.length,
        maskedCountNotds(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_3cd_notds",
    "Write the clause 21(b) rows of the last tb_notds_review into the four No-TDS sheets of a COPY of the " +
      "operator's `No TDS Disallowance.xlsm` and return the copy's path and per-sheet row counts. The copy is " +
      "written to the report directory (or outPath) as '<source stem> - filled - <date>.xlsm'; the source " +
      "workbook is never modified. Compose nothing by hand: the sheets carry the payment facts from the review.",
    {
      sourcePath: z.string().describe("Path to the operator's Winman `No TDS Disallowance.xlsm`; read only, never written"),
      outPath: z.string().optional().describe("Directory for the filled copy; defaults to the report directory"),
    },
    async (args) => {
      const written = await session.write3cdNoTds({
        sourcePath: args.sourcePath,
        outPath: args.outPath ?? cfg.reportDir,
      });
      await audit(
        "tb_write_3cd_notds",
        { sourcePath: args.sourcePath, outPath: args.outPath ?? null },
        Object.values(written.rowsBySheet).reduce((a, b) => a + b, 0),
        0,
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(written, null, 2);
    },
  );

  register(
    "tb_write_pf_esi_report",
    "Write the PF/ESI clause 20(b) review workbook to disk: a Findings sheet and the Clause 20(b) " +
      "working paper (fund, wage month, amount collected, due date, amount paid, paid on, delay, " +
      "disallowed) so the auditor sees the s.36(1)(va) disallowance before importing. Real names are " +
      "restored on write; compose nothing by hand - it is generated from the last tb_pf_esi_review.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!lastPfEsi) throw new Error("run tb_pf_esi_review first: there are no PF/ESI findings to write");
      const paths = await writePfEsiReport({
        reportDir: args.outDir ?? cfg.reportDir,
        result: {
          company: args.company ?? lastPfEsi.company,
          fromDate: lastPfEsi.fromDate,
          toDate: lastPfEsi.toDate,
          findings: lastPfEsi.findings,
          // The working paper's date cells come from the cached raw rows;
          // the review result's own rows are display-formatted.
          rows: session.pfEsiRows() ?? [],
        },
        vault: session.vault,
      });
      await audit(
        "tb_write_pf_esi_report",
        { company: args.company ?? lastPfEsi.company ?? null },
        lastPfEsi.findings.length,
        maskedCount(lastPfEsi.findings),
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_write_loans_template",
    "Generate the fillable Excel loans operator template (loans-operator-template-<company>-<date>.xlsx) " +
      "for Form 3CD clause 31 (l.269SS/l.269T) and l.269ST into the report directory and return its path. " +
      "It pre-fills the Parties sheet with the ledger list (from the day-book export when dayBookPath is " +
      "given, else live Tally masters) and back-fills the ledger dropdowns from its hidden Ledgers sheet. " +
      "Fill Parties, Specified Sums and 269ST in Excel, then pass its path to tb_loans_review as " +
      "templatePath - never paste its rows into chat.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
      dayBookPath: z.string().optional()
        .describe(
          "Optional PATH to an operator day-book JSON export; when given its ledger list fills the " +
            "template's Parties/Ledgers sheet instead of live Tally masters.",
        ),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      const masterPairsInfo: {
        ledgers: { name: string; parent: string }[];
        groups: { name: string; parent: string }[];
      } = { ledgers: [], groups: [] };
      let ledgerList: string[] = [];
      if (args.dayBookPath) {
        const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
        const mp = readDayBookMasterPairs(text, args.company ?? cfg.defaultCompany);
        masterPairsInfo.ledgers = mp.ledgers;
        masterPairsInfo.groups = mp.groups;
        ledgerList = mp.ledgers.map((p) => p.name);
      }
      // Degrade honestly: a template without a list is still useful (the
      // operator types party names by hand); the warning says so.
      if (ledgerList.length === 0) {
        const pairsInfo = await session.ledgerPairs(args.company ?? cfg.defaultCompany);
        masterPairsInfo.ledgers = pairsInfo.ledgers;
        masterPairsInfo.groups = pairsInfo.groups;
        ledgerList = pairsInfo.ledgers.map((p) => p.name);
      }
      // Addendum 2 (2026-09-26): pre-fill Exempt = Y for Bank OD/OCC-ancestry
      // loan ledgers, banking-company name matches, and — addendum 4 —
      // Secured Loans ancestry; the operator can overwrite with N either way.
      const exemptCtx = buildLoansCtx(masterPairsInfo.ledgers, masterPairsInfo.groups);
      const exemptPrefill = (name: string): boolean =>
        exemptCtx.isLoanLedger(name) &&
        (exemptCtx.isBankOdLedger(name) ||
          bankLenderNameMatch(name) ||
          exemptCtx.isSecuredLoanLedger(name));
      if (ledgerList.length === 0) {
        console.error(
          "tally-agent: no ledger names available (no day-book list and live masters unavailable) — " +
            "writing the loans template with an empty party list",
        );
      }
      const outDir = args.outDir ?? cfg.reportDir;
      const outPath = join(
        outDir,
        loansTemplateFileName(args.company, new Date().toISOString().slice(0, 10).replace(/-/g, "")),
      );
      const { sheets } = buildLoansTemplateWorkbook(
        ledgerList.map((n) => ({ name: n, ...(exemptPrefill(n) ? { exempt: true } : {}) })),
        {},
      );
      await writeFile(outPath, buildWorkbook(sheets));
      await audit(
        "tb_write_loans_template",
        {
          company: args.company,
          outDir,
          ...(args.dayBookPath ? { dayBookPath: args.dayBookPath } : {}),
        },
        ledgerList.length,
        0,
      );
      return JSON.stringify({ templatePath: outPath, ledgers: ledgerList.length }, null, 2);
    },
  );

  register(
    "tb_loans_review",
    "Winman Form 3CD clause 31 (l.269SS/l.269T) and l.269ST loans review: cash acceptances and cash " +
      "repayments breaching the Rs 20,000 mode limits (ss.269SS/269T; penalty exposure ss.271D/271E), " +
      "movements whose mode cannot be read from the books, same-day splitting under the thresholds, the " +
      "s.269ST register of Rs 2,00,000-or-more cash receipts (penalty s.271DA) and payments (reporting), " +
      "and estimate honesty flags when the day-book carries no masters. Parties appear as pseudonyms such " +
      "as 'Ledger 2'. Optionally pass the PATH of the filled loans operator template from " +
      "tb_write_loans_template as templatePath (its mode overrides, PANs/Aadhaars and 269ST declarations " +
      "are read inside the gateway, never pasted into chat). The books come from ONE channel: live Tally " +
      "(default) or an operator day-book export by dayBookPath - not both. Run tb_write_3cd_loans " +
      "afterwards to write the Winman sheets.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      dayBookPath: z
        .string()
        .optional()
        .describe(
          "PATH to an operator day-book JSON export for the whole period. When given, the books are read " +
            "from that file INSTEAD OF from Tally. Pass the path - never paste the file's rows into chat.",
        ),
      templatePath: z.string().optional()
        .describe("Path to the filled loans-operator-template-*.xlsx; read inside the gateway, only the path is audited"),
      overridesPath: z.string().optional()
        .describe("Optional PATH to an overrides JSON; kept for interface parity, warns when no loans key applies"),
      live: z
        .boolean()
        .optional()
        .describe(
          "Explicitly request the live Tally fetch. Give dayBookPath OR live: true, never both - the books " +
            "come from one channel. When neither is given the books come from live Tally.",
        ),
      company: z.string().optional(),
    },
    async (args) => {
      // Day book vs live are mutually exclusive by contract (Task 8 owns it at
      // the tool layer; the session honours whichever the paths say): an
      // explicit live fetch alongside a day-book path is a refused run, never
      // a silent winner.
      if (args.dayBookPath && args.live) {
        throw new Error(
          "give dayBookPath (operator day-book export) or live: true, not both - the books come from one channel",
        );
      }
      let dayBookDigest: string | undefined;
      if (args.dayBookPath) {
        // Path-only channel: validate the file (size ceiling, period coverage,
        // company match) inside the gateway and record its digest, exactly as
        // the other review tools do. Session.loansReview re-reads the path.
        const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
        readDayBook(text, {
          company: args.company ?? cfg.defaultCompany,
          fromDate: args.fromDate,
          toDate: args.toDate,
        });
        dayBookDigest = createHash("sha256").update(text).digest("hex");
      }
      const result = await session.loansReview({
        company: args.company ?? cfg.defaultCompany,
        fromDate: args.fromDate,
        toDate: args.toDate,
        dayBookPath: args.dayBookPath,
        templatePath: args.templatePath,
        overridesPath: args.overridesPath,
      });
      lastLoans = result;
      // The files' PATHS are audited, never their contents (the M2 contract).
      await audit(
        "tb_loans_review",
        {
          company: args.company,
          fromDate: args.fromDate,
          toDate: args.toDate,
          ...(args.dayBookPath ? { dayBookPath: args.dayBookPath } : {}),
          ...(args.templatePath ? { templatePath: args.templatePath } : {}),
          ...(args.overridesPath ? { overridesPath: args.overridesPath } : {}),
          ...(args.live ? { live: true } : {}),
          ...(dayBookDigest ? { dayBookDigest } : {}),
        },
        result.findings.length,
        maskedCount(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_3cd_loans",
    "Write the clause 31 and 269ST rows of the last tb_loans_review into the Sec.269SS/269T/269ST sheets " +
      "of a COPY of the operator's Winman 3CD loans workbook and return the copy's path. The copy is written " +
      "to the report directory (or outPath) as '<source stem> - filled - <date>.xlsm'; the source workbook is " +
      "never modified. Compose nothing by hand: the sheets carry the review's names, amounts and dates.",
    {
      sourcePath: z.string().describe("Path to the operator's Winman loans workbook (.xlsm); read only, never written"),
      outPath: z.string().optional().describe("Directory for the filled copy; defaults to the report directory"),
    },
    async (args) => {
      const { written } = await session.write3cdLoans({
        sourcePath: args.sourcePath,
        outPath: args.outPath ?? cfg.reportDir,
      });
      await audit("tb_write_3cd_loans", { sourcePath: args.sourcePath, outPath: args.outPath ?? null }, 0, 0);
      return JSON.stringify({ outPath: written }, null, 2);
    },
  );

  register(
    "tb_write_loans_report",
    "Write the clause 31 / 269ST loans review report workbook to disk from the last tb_loans_review. " +
      "Real names are restored on write; compose nothing by hand - it is generated from the cached review.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!lastLoans || !session.loansRows()) {
        throw new Error("run tb_loans_review first: there are no clause-31/269ST rows to write");
      }
      // The family sheets carry the RAW cached rows (real names, PAN and
      // address, YYYYMMDD dates) exactly as tb_write_pf_esi_report carries
      // its clause 20(b) rows; the findings stay masked and de-mask through
      // the vault on write. Both channels arrive correct by construction.
      const cached = session.loansRows()!;
      const company = args.company ?? lastLoans.company;
      const paths = await writeLoansReport({
        reportDir: args.outDir ?? cfg.reportDir,
        result: {
          company,
          fromDate: lastLoans.fromDate,
          toDate: lastLoans.toDate,
          findings: lastLoans.findings,
          rows: LOANS_SHEET_NAMES.flatMap((n) => cached.sheets[n]),
          sheets: lastLoans.sheets,
        },
        vault: session.vault,
      });
      await audit(
        "tb_write_loans_report",
        { company: company ?? null, outDir: args.outDir ?? null },
        lastLoans.findings.length,
        maskedCount(lastLoans.findings),
      );
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );

  register(
    "tb_write_dep3cd_template",
    "Generate the fillable Excel clause-18 depreciation operator template " +
      "(dep3cd-operator-template-<company>-<date>.xlsx) into the report directory and return its path. " +
      "It pre-fills the fixed-asset groups and asset ledgers from the day-book masters (pass dayBookPath - " +
      "a PATH, never pasted contents) and back-fills the Winman-block dropdowns from its hidden Blocks " +
      "sheet (from sourcePath's workbook lists when given, else the built-in AY 2026-27 list). Fill the " +
      "group/ledger block choices and any Adjustment rows in Excel, then pass its path to tb_dep3cd_review " +
      "as templatePath - never paste its rows into chat.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
      dayBookPath: z.string().describe(
        "PATH to the operator day-book JSON export; its groups and ledgers fill the template. Required.",
      ),
      sourcePath: z.string().optional().describe(
        "Optional PATH to the Winman depreciation workbook whose block lists the dropdowns should carry; " +
          "read only, never written.",
      ),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!args.dayBookPath) {
        throw new Error("pass dayBookPath: the fixed-asset ledgers come from the day-book masters");
      }
      const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
      const mp = readDayBookMasterPairs(text, args.company ?? cfg.defaultCompany);
      let blockLists: { additions: readonly string[]; deletions: readonly string[] } = DEFAULT_BLOCK_LISTS;
      if (args.sourcePath) {
        const pkg = readXlsm(await readFile(args.sourcePath));
        const additions = readListValues(pkg, "Depreciation additions", "FISTCOL");
        const deletions = readListValues(pkg, "Depreciation deletions", "DELETIONDTLS");
        if (additions.length > 0 || deletions.length > 0) blockLists = { additions, deletions };
      }
      const buf = buildDep3cdTemplate({
        company: args.company,
        groups: mp.groups.map((g) => ({ name: g.name, rate: parseRateFromGroup(g.name) })),
        ledgers: mp.ledgers.map((l) => ({ name: l.name, group: l.parent })),
        blockLists: { additions: [...blockLists.additions], deletions: [...blockLists.deletions] },
      });
      const outDir = args.outDir ?? cfg.reportDir;
      await mkdir(outDir, { recursive: true });
      const templatePath = join(outDir, dep3cdTemplateFileName(args.company, new Date().toISOString().slice(0, 10)));
      await writeFile(templatePath, buf);
      await audit(
        "tb_write_dep3cd_template",
        {
          company: args.company ?? null,
          dayBookPath: args.dayBookPath,
          ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
          ...(args.outDir ? { outDir: args.outDir } : {}),
        },
        mp.ledgers.length,
        0,
      );
      return JSON.stringify({ templatePath, groups: mp.groups.length, ledgers: mp.ledgers.length }, null, 2);
    },
  );

  register(
    "tb_dep3cd_review",
    "Winman Form 3CD clause 18 depreciation as per the Income-tax Act: the additions and deletions " +
      "sheets, one row per asset acquisition or sale. Additional depreciation is always N/A; deletions " +
      "are recorded at the ACTUAL CONSIDERATION received (never the book value or the profit/loss on " +
      "sale). A ledger with no resolvable Winman block is critical and its row is not written. " +
      "Asset ledgers appear as pseudonyms such as 'Ledger 2'. Books come from an operator day-book export " +
      "by dayBookPath (a PATH, never pasted contents). Optionally pass the filled operator template from " +
      "tb_write_dep3cd_template as templatePath (block choices and Adjustment rows are read inside the " +
      "gateway, never pasted into chat), and the Winman workbook as sourcePath so its actual block lists " +
      "are used. Run tb_write_3cd_depreciation afterwards to write the Winman sheets.",
    {
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      dayBookPath: z.string().describe(
        "PATH to the operator day-book JSON export for the whole period; the books are read from that file.",
      ),
      templatePath: z.string().optional()
        .describe("Path to the filled dep3cd-operator-template-*.xlsx; read inside the gateway, only the path is audited"),
      sourcePath: z.string().optional()
        .describe("Path to the Winman depreciation workbook, read only, so its real block lists drive block resolution"),
      company: z.string().optional(),
    },
    async (args) => {
      const text = await loadDayBookText(args.dayBookPath, cfg.dayBookMaxBytes);
      readDayBook(text, {
        company: args.company ?? cfg.defaultCompany,
        fromDate: args.fromDate,
        toDate: args.toDate,
      });
      const dayBookDigest = createHash("sha256").update(text).digest("hex");
      const result = await session.dep3cdReview({
        company: args.company ?? cfg.defaultCompany,
        fromDate: args.fromDate,
        toDate: args.toDate,
        dayBookPath: args.dayBookPath,
        templatePath: args.templatePath,
        sourcePath: args.sourcePath,
      });
      lastDep3cd = result;
      await audit(
        "tb_dep3cd_review",
        {
          company: args.company,
          fromDate: args.fromDate,
          toDate: args.toDate,
          dayBookPath: args.dayBookPath,
          ...(args.templatePath ? { templatePath: args.templatePath } : {}),
          ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
          dayBookDigest,
        },
        result.findings.length,
        maskedCount(result.findings),
      );
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_write_3cd_depreciation",
    "Write the clause 18 additions and deletions of the last tb_dep3cd_review into a COPY of the " +
      "operator's Winman depreciation workbook and return the copy's path. The copy goes to the report " +
      "directory (or outPath) as '<source stem> - filled - <date>.xlsm'; the source workbook is read only " +
      "and is never modified, so never pass the Winman folder as outPath. Compose nothing by hand: the " +
      "sheets carry the review's blocks, dates and amounts.",
    {
      sourcePath: z.string().describe("Path to the operator's Winman depreciation workbook (.xlsm); read only, never written"),
      outPath: z.string().optional().describe("Directory for the filled copy; defaults to the report directory"),
    },
    async (args) => {
      const r = await session.write3cdDepreciation({
        sourcePath: args.sourcePath,
        outPath: args.outPath ?? cfg.reportDir,
      });
      await audit("tb_write_3cd_depreciation", { sourcePath: args.sourcePath, outPath: args.outPath ?? null }, 0, 0);
      return JSON.stringify(
        {
          outPath: r.written,
          additions: r.additions,
          deletions: r.deletions,
          skipped: r.skipped,
          notes: r.notes,
        },
        null,
        2,
      );
    },
  );

  register(
    "tb_write_dep3cd_report",
    "Write the clause 18 depreciation review workbook to disk from the last tb_dep3cd_review: Additions, " +
      "Parts, Deletions and Findings sheets so the auditor sees each acquired asset's cost, block and " +
      "dates, every part of an acquisition, and each disposal's actual consideration against its book " +
      "credit. Real names are restored on write; compose nothing by hand - it is generated from the cache.",
    {
      company: z.string().optional().describe("Company name, used only in the file name"),
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!lastDep3cd || !session.dep3cdRows()) {
        throw new Error("run tb_dep3cd_review first: there are no clause-18 rows to write");
      }
      const cached = session.dep3cdRows()!;
      const paths = await writeDep3cdReport({
        reportDir: args.outDir ?? cfg.reportDir,
        result: {
          company: args.company ?? lastDep3cd.company,
          fromDate: lastDep3cd.fromDate,
          toDate: lastDep3cd.toDate,
          findings: lastDep3cd.findings,
        },
        rows: { additions: cached.additions, deletions: cached.deletions },
        vault: session.vault,
      });
      await audit(
        "tb_write_dep3cd_report",
        { company: args.company ?? lastDep3cd.company ?? null, outDir: args.outDir ?? null },
        lastDep3cd.findings.length,
        maskedCount(lastDep3cd.findings),
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
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!lastDep) throw new Error("run tb_depreciation_review first: there are no depreciation findings to write");
      const paths = await writeDepreciationReport({
        reportDir: args.outDir ?? cfg.reportDir,
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
      outDir: z.string().optional().describe("Optional directory to write into; defaults to the report directory"),
    },
    async (args) => {
      if (!lastFa) throw new Error("run tb_fixed_asset_register first: there is no register to write");
      const paths = await writeFaRegisterReport({
        reportDir: args.outDir ?? cfg.reportDir,
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

  registerWorkflowTools(register, {
    call: (name, args) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no such internal tool: ${name}`);
      return handler(args);
    },
    session,
    cfg,
    sessionId,
    audit,
  });
}

function maskedCount(findings: Array<{ ledger: string }>): number {
  return findings.filter((f) => /^(\w+ \d+)$/.test(f.ledger)).length;
}

function maskedCountTds(findings: Array<{ deductee: string }>): number {
  return findings.filter((f) => /^(\w+) \d+$/.test(f.deductee)).length;
}

function maskedCountAs26(findings: Array<{ party: string }>): number {
  return findings.filter((f) => /^(\w+) \d+$/.test(f.party)).length;
}

function maskedCountNotds(findings: Array<{ party: string }>): number {
  return findings.filter((f) => f.party !== "" && /^(\w+) \d+$/.test(f.party)).length;
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
  const session = createSession(downstream, overrides, wrongGroup);

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
