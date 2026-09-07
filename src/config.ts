export interface GatewayConfig {
  downstreamCommand: string;
  downstreamArgs: string[];
  reportDir: string;
  defaultCompany?: string;
  dumpVault: boolean;
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
    dumpVault: env.TALLY_AGENT_DUMP_VAULT === "1",
  };
}
