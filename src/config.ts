export interface GatewayConfig {
  downstreamCommand: string;
  downstreamArgs: string[];
  reportDir: string;
  defaultCompany?: string;
  dumpVault: boolean;
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
    downstreamArgs: (env.TALLY_MCP_ARGS ?? "").split(" ").filter(Boolean),
    reportDir,
    defaultCompany: env.TALLY_DEFAULT_COMPANY || undefined,
    dumpVault: env.TALLY_AGENT_DUMP_VAULT === "1",
  };
}
