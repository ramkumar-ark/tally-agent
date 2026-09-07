# opencode setup

Build first:

```bash
npm install && npm run build
```

`opencode.json` in your working directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "tally-agent": {
      "type": "local",
      "command": ["node", "/absolute/path/to/tally-agent/dist/index.js"],
      "environment": {
        "TALLY_MCP_COMMAND": "node",
        "TALLY_MCP_ARGS": "/absolute/path/to/tally_prime_mcp_server/dist/index.js",
        "TALLY_AGENT_REPORT_DIR": "/absolute/path/outside/this/project/tally-reports",
        "TALLY_DEFAULT_COMPANY": "Your Company Name"
      }
    }
  },
  "permission": {
    "read": { "/absolute/path/outside/this/project/tally-reports/**": "deny" }
  }
}
```

Same rule as Claude Code: the report directory sits outside the project and the
harness is denied read access to it. Reports are written de-masked.

**Verify the deny rule before your first real run** — opencode's permission schema
has changed between versions. Ask it to read a file in the report directory; it
must refuse.
