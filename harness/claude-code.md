# Claude Code setup

Build first:

```bash
npm install && npm run build
```

Add the gateway as the **only** Tally-related MCP server. Do not also configure
`tally_prime_mcp_server` — the whole point is that the model cannot reach it.

`.mcp.json`:

```json
{
  "mcpServers": {
    "tally-agent": {
      "command": "node",
      "args": ["/absolute/path/to/tally-agent/dist/index.js"],
      "env": {
        "TALLY_MCP_COMMAND": "node",
        "TALLY_MCP_ARGS": "/absolute/path/to/tally_prime_mcp_server/dist/index.js",
        "TALLY_AGENT_REPORT_DIR": "/absolute/path/outside/this/project/tally-reports",
        "TALLY_DEFAULT_COMPANY": "Your Company Name"
      }
    }
  }
}
```

**The report directory must sit outside this project**, and the harness must be
denied read access to it. In `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Read(/absolute/path/outside/this/project/tally-reports/**)"]
  }
}
```

Reports are written de-masked. Without that deny rule the model can read back the
real names it was never given — see the design document, section 7.1.

## Asking for a review

> Review the trial balance as of 31 March 2026 and write it up.

The model calls `tb_review`, drills into anything unclear with `tb_ledger_activity`,
then calls `tb_write_report`. Read the Markdown and CSV in your report directory.
