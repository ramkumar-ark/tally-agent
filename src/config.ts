export interface GatewayConfig {
  downstreamCommand: string;
  downstreamArgs: string[];
  reportDir: string;
  defaultCompany?: string;
  /**
   * Per-request timeout for calls to the downstream MCP server, in
   * milliseconds. Undefined means the MCP SDK's own default (60 s); a real
   * Tally company needs far longer, so this is settable per install.
   */
  downstreamTimeoutMs?: number;
  dumpVault: boolean;
  /** Rule 119A(c) ₹100 interest treatment, default on; TALLY_AGENT_TDS_ROUND100_OFF=1 disables. */
  tdsRound100: boolean;
  /** Largest operator day-book file accepted, in bytes. TALLY_AGENT_DAYBOOK_MAX_MB, default 64. */
  dayBookMaxBytes: number;
}

/**
 * TALLY_MCP_ARGS is normally whitespace-split, which breaks on a path
 * containing a space (e.g. "F:/Software Projects/.../index.js" splits into
 * two bogus arguments and the downstream child dies with a confusing
 * module-not-found error). A JSON array of strings is used verbatim instead
 * when the value parses as one; malformed JSON falls back to whitespace
 * splitting rather than throwing, so an existing single-token config keeps
 * working unchanged.
 */
function parseDownstreamArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    // Not JSON - fall through to whitespace splitting.
  }
  return trimmed.split(" ").filter(Boolean);
}

/**
 * The downstream request timeout, in milliseconds. Absent or empty means the
 * MCP SDK default (60 s) — an empty value is treated as unset, like
 * TALLY_DEFAULT_COMPANY. Anything present must be a positive integer: a
 * fractional or non-numeric value would otherwise reach the SDK as NaN and
 * silently behave in a surprising way, so it is refused at startup with a
 * message naming the variable.
 */
function parseDownstreamTimeoutMs(raw: string | undefined): number | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0 || !Number.isSafeInteger(Number(trimmed))) {
    throw new Error(
      `TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS must be a positive integer number of milliseconds, got "${raw}"`,
    );
  }
  return Number(trimmed);
}

/**
 * Largest operator day-book file accepted, in whole megabytes. Absent means
 * the 64 MB default; anything present must be a positive whole number.
 */
function parseDayBookMaxBytes(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return 64 * 1024 * 1024;
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0 || !Number.isSafeInteger(Number(trimmed))) {
    throw new Error(
      `TALLY_AGENT_DAYBOOK_MAX_MB must be a positive whole number of megabytes, got "${raw}"`,
    );
  }
  return Number(trimmed) * 1024 * 1024;
}

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const downstreamCommand = env.TALLY_MCP_COMMAND;
  if (!downstreamCommand) {
    throw new Error(
      "TALLY_MCP_COMMAND is required: the command that starts tally_prime_mcp_server",
    );
  }
  const reportDir = env.TALLY_AGENT_REPORT_DIR;
  if (!reportDir) {
    throw new Error(
      "TALLY_AGENT_REPORT_DIR is required and must point outside the harness working directory",
    );
  }
  return {
    downstreamCommand,
    downstreamArgs: parseDownstreamArgs(env.TALLY_MCP_ARGS ?? ""),
    reportDir,
    defaultCompany: env.TALLY_DEFAULT_COMPANY || undefined,
    downstreamTimeoutMs: parseDownstreamTimeoutMs(env.TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS),
    dumpVault: env.TALLY_AGENT_DUMP_VAULT === "1",
    tdsRound100: env.TALLY_AGENT_TDS_ROUND100_OFF !== "1",
    dayBookMaxBytes: parseDayBookMaxBytes(env.TALLY_AGENT_DAYBOOK_MAX_MB),
  };
}
