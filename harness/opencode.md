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
        "TALLY_MCP_ARGS": "[\"/absolute/path/to/tally_prime_mcp_server/dist/index.js\"]",
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

This machine's real paths, the confirmed upstream server, how to check Tally is
reachable, what a healthy start looks like and what each failure message means
all live in [`claude-code.md`](claude-code.md) — that document is the verified
one, and it is kept as the single owner of those details rather than duplicating
them here. Read it first; only the config shape above differs for opencode.

`TALLY_MCP_ARGS` is a JSON array of strings (shown above), used verbatim — this is the
documented default. **Every path on the machine this was verified on contains a
space, so this form is required**: plain whitespace-splitting (still accepted for a
single-token value with no spaces) cuts that path into two bogus arguments and the
downstream server dies with `Cannot find module 'F:\Software'`.

Same rule as Claude Code: the report directory sits outside the project and the
harness is denied read access to it. Reports are written de-masked.

**Verify the deny rule before your first real run** — opencode's permission schema
has changed between versions, and this setup was verified on Claude Code, not
opencode. Put a file with a distinctive marker in the report directory and ask
opencode to print its contents; it must refuse, and the marker must not appear.
Run the same request with the rule removed as well: if the marker comes back
then and not with the rule in place, the rule is genuinely doing the work.
