#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig, type GatewayConfig } from "./config.js";
import { connectDownstream } from "./downstream.js";
import { loadOverrides } from "./overrides.js";
import { appendAudit, writeReport, writeVaultDump } from "./report.js";
import { createSession, type ReviewResult, type Session } from "./review.js";

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
    "Run the seven trial balance sanity checks as of a date and return masked findings. " +
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
  const downstream = await connectDownstream(cfg);
  const session = createSession(downstream, overrides);

  const server = new McpServer(
    { name: "tally-agent", version: "0.1.0" },
    {
      instructions:
        "Read-only trial balance review for Tally Prime, with accounting PII masked. " +
        "Party ledgers, bank accounts, capital accounts and loan accounts appear as stable " +
        "pseudonyms such as 'Creditor 3'; nominal accounts appear by their real names. " +
        "You cannot see the trial balance itself, only the exceptions the checks found. " +
        "Drill into a finding by its id with tb_ledger_activity, never by ledger name. " +
        "Write the report with tb_write_report using the pseudonyms; real names are restored on write.",
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
