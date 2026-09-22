# Exporting an operator day book for `tb_tds_review`

## What this is

`scripts/export-daybook.mjs` exports one company's day book (all vouchers with
their ledger lines) plus the group and ledger trees, as a single JSON bundle
that `tb_tds_review` accepts through its `dayBookPath` argument. When you pass
that path, the review reads the books from this file instead of making ~640
per-ledger Ledger-Vouchers calls from Tally, which is why a whole-FY TDS
review takes minutes instead of about an hour.

The script talks to the upstream Tally MCP server with a raw
newline-delimited JSON-RPC client over stdio. The MCP SDK's own stdio client
transport cannot carry a whole-FY response (three of three attempts died with
`McpError -32000: Connection closed`, upstream exiting cleanly mid-write);
the raw client takes the same payload in ~140 s.

## The command line

```bash
node scripts/export-daybook.mjs <upstream-dist/index.js> <company> <YYYYMMDD> <YYYYMMDD> <out.json>
```

- `<upstream-dist/index.js>` — the built entry point of the upstream Tally MCP
  server (`npm run build` there first; `dist/` is not committed).
- `<company>` — the exact company name as Tally shows it.
- dates — review period, `YYYYMMDD` start and end (a full FY like
  `20250401`–`20260331` is the normal case).
- `<out.json>` — where the bundle is written.

The script needs the same environment as the upstream server itself
(`TALLY_HOST`, `TALLY_PORT`, `TALLY_TIMEOUT_MS` and friends). Do not restate
them here: they are owned by `harness/claude-code.md` and are already in
place wherever the upstream runs.

## Where the output may live

The bundle contains **real ledger names, party names and voucher numbers**.
It is operator data:

- keep it outside this repository and outside the gateway's report directory;
- give `tb_tds_review` the file's **path** (`dayBookPath`), never its
  contents — the gateway reads the file itself and never echoes rows, tax
  identities or file text back to the model.

A typical workflow:

```bash
node scripts/export-daybook.mjs "$UPSTREAM/dist/index.js" "$COMPANY" 20250401 20260331 "$HOME/tally-exports/daybook-fy.json"
# then, in the agent session:
tb_tds_review fromDate=20250401 toDate=20260331 asOnDate=20260331 dayBookPath=$HOME/tally-exports/daybook-fy.json
```

## Validation the gateway applies

The file must parse as JSON and may be at most
`TALLY_AGENT_DAYBOOK_MAX_MB` MB (default 64). A bundle that names a company
must name the company being reviewed, and its declared period must cover the
review period; a file whose vouchers fall outside its own declared period is
refused as self-describing incorrectly. Months with no voucher at all raise
critical findings in the review rather than being silently skipped.
