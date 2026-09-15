# Claude Code setup

This document covers two verified setups. Sections 1–5 are **native Windows**
(verified 2026-09-09, real paths). The **WSL2 Ubuntu** variant is in
[WSL2 (Ubuntu) setup](#wsl2-ubuntu-setup) — read that
section instead of sections 1–3 when Claude Code runs inside WSL; sections 4–5
apply to both except where noted.

Every step below was executed on this machine on 2026-09-09 against the live
Tally Prime install, and the paths are that machine's real paths, not
placeholders. Where something could **not** be executed, it says so and why —
see [What is not verified](#what-is-not-verified) at the end.

Verified on: Windows 11 (10.0.26200), Node v24.13.0, npm 11.13.0,
Claude Code 2.1.266, TallyPrime gateway 11.0 release 7.1.0.

## The three paths on this machine

| What | Path |
| --- | --- |
| This project (the gateway) | `F:\Software Projects\firstmate\firstmate\projects\tally-agent` |
| Upstream Tally MCP server | `F:\Software Projects\tally_prime_mcp_server` |
| Report output directory | `C:\Users\Admin\tally-reports` |

Two of those contain a space. That is not incidental — it is the single most
common way this setup fails, and both places it bites are called out below.

The upstream server is the one at `F:\Software Projects\tally_prime_mcp_server`
(package `tally-prime-mcp-server`, HEAD `b55a67d`), confirmed by checking that it
registers the five tools the gateway calls: `tally_list_companies`,
`tally_trial_balance`, `tally_get_groups`, `tally_get_ledgers`,
`tally_get_ledger_vouchers`. **It is not** the `tally_mcp_server_v6` directory
under `F:\AgenticWorkspace\Tally Prime Automation\` — that is an unrelated older
server which registers none of those tools, and pointing the gateway at it fails
at the first tool call. Its sibling `1766393040_tally_mcp_server_v6` is an empty
directory.

The upstream server ships a committed `dist/`, so it needs no build of its own.

## Before you start

Tally Prime must be running, with the company you want reviewed open, and its
XML/HTTP gateway enabled and listening — port 9000 by default
(*Gateway of Tally → F1: Help → Settings → Connectivity → Client/Server
configuration*). Confirm with:

```bash
node -e "require('net').connect(9000,'127.0.0.1').on('connect',()=>{console.log('OPEN');process.exit(0)}).on('error',e=>{console.log('CLOSED',e.code);process.exit(1)})"
```

If that prints `CLOSED`, nothing below will work; fix it first.

## 1. Build

```bash
cd "F:/Software Projects/firstmate/firstmate/projects/tally-agent"
npm install && npm run build && npm test
```

`npm test` should end with `17 passed` / `194 passed` (3 skipped off Windows). It is worth running once:
it includes the leak test, which drives all nine gateway tools and fails the
build if any real ledger name, bank account number, GSTIN or PAN reaches a tool
result.

## 2. Configure the MCP server

Add the gateway as the **only** Tally-related MCP server. Do not also configure
`tally_prime_mcp_server` directly — the whole point is that the model cannot
reach it. (The gateway strips `TALLY_ALLOW_WRITES` from the environment it hands
the upstream server, so the upstream's write tools stay disabled regardless of
what is set here; you will see `writes disabled` on startup.)

`.mcp.json`, in whatever directory you start Claude Code from:

```json
{
  "mcpServers": {
    "tally-agent": {
      "command": "node",
      "args": ["F:/Software Projects/firstmate/firstmate/projects/tally-agent/dist/index.js"],
      "env": {
        "TALLY_MCP_COMMAND": "node",
        "TALLY_MCP_ARGS": "[\"F:/Software Projects/tally_prime_mcp_server/dist/index.js\"]",
        "TALLY_AGENT_REPORT_DIR": "C:/Users/Admin/tally-reports",
        "TALLY_DEFAULT_COMPANY": "Prohear Speech and Hearing Clinic"
      }
    }
  }
}
```

Forward slashes throughout, including on Windows. Both forms work for `args`,
but a JSON file needs every backslash doubled, and a half-escaped Windows path
is its own class of confusing failure.

`TALLY_DEFAULT_COMPANY` is optional — omit it and name the company in the
request instead. `tb_list_companies` reports what Tally actually has open; on
this machine that is the one company above.

`TALLY_MCP_ARGS` **must** be a JSON array of strings, as shown. It is the
documented default, and with a space in `Software Projects` it is not optional:
the plain whitespace-split form (still accepted for a single token with no
spaces) cuts the path in two and the upstream child dies with

```
Error: Cannot find module 'F:\Software'
```

The report directory does not need creating by hand — the gateway creates it on
first write.

## 3. Deny the harness read access to the report directory

Reports are written **de-masked**. Without this rule the model can read back the
real names it was deliberately never given. This is a security boundary, not a
nicety — see the design document, section 7.1.

`.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Read(C:/Users/Admin/tally-reports/**)"]
  }
}
```

**What that rule actually covers, tested rather than assumed.** Three isolated
`claude -p` runs against a file in a denied directory:

| Setup | Result |
| --- | --- |
| No deny rule, `Read` the file | contents came back — so the test below is not vacuous |
| Deny rule, `Read` the file | refused: "blocked by your permission settings" |
| Deny rule, `Bash` allowed, `cat` the file | refused — the path rule covers shell reads too |

A control in the third configuration confirmed Bash was genuinely enabled: the
same session read a file *outside* the denied directory without complaint. So a
single `Read(...)` rule is sufficient; you do not also need to restrict Bash, and
nothing here needs weakening to make setup work.

Keeping the report directory outside the project (mitigation 1 of the two in
section 7.1) is still worth doing, and `C:\Users\Admin\tally-reports` is outside
it. If you ever start Claude Code from a directory that contains the reports,
the working-directory confinement blocks access as well — belt and braces.

## 4. Confirm it is working

Start Claude Code and run `/mcp`. `tally-agent` must be **connected**, listing
exactly nine tools:

```
tb_gst_mismatch, tb_gst_summary, tb_ledger_activity, tb_ledger_scrutiny,
tb_list_companies, tb_review, tb_write_gst_report, tb_write_ledger_report,
tb_write_report
```

If you start the gateway by hand instead, a healthy start prints two lines to
stderr and then waits:

```
tally-prime-mcp-server running; Tally gateway at http://127.0.0.1:9000; writes disabled
tally-agent gateway running; reports to C:/Users/Admin/tally-reports
```

Then ask for a review:

> Review the trial balance as of 31 March 2026 and write it up.

To scrutinise one ledger behind a finding, ask for it by finding id:

> Scrutinise the ledger behind TB-004-1 for FY 2025-26 and write up the ledger scrutiny.

The model calls `tb_review`, drills into anything unclear with
`tb_ledger_activity`, then calls `tb_write_report`. Read the Markdown and CSV in
`C:\Users\Admin\tally-reports`.

**What a working run looks like.** On this machine, as of 20260331, `tb_review`
returned a balanced trial balance (debits and credits both 7,734,887.39) with 34
findings — 0 critical, 1 warning, 33 review. Party ledgers came back to the model
as `Debtor 1` and the like; the written Markdown and CSV contained the real
names, with no pseudonym left in either. Your numbers will differ; the shape is
what to check. That run predates the eighth check, `ledger_in_wrong_group`, so a
run today may show more warnings.

Three files land per run: `trial-balance-review-<company>-<date>.md`,
`findings-<company>-<date>.csv`, and `session-<timestamp>.jsonl` (one audit line
per tool call). The audit file is per gateway process, so restarting Claude Code
starts a new one.

## 5. When it is not working

| What you see | Cause | Fix |
| --- | --- | --- |
| `Cannot reach Tally at http://127.0.0.1:9000 ... (fetch failed)` | Tally not running, or its gateway is off or on another port | Start Tally, enable the XML/HTTP gateway, or set `TALLY_PORT` in `env` |
| `Cannot find module 'F:\Software'` | `TALLY_MCP_ARGS` was given as a bare path, not a JSON array | Use the JSON-array form from step 2 |
| `Failed to start the downstream Tally MCP server. Command tried: ...` | The upstream path is wrong or its `dist/` is missing | Check the path in the message; confirm `F:\Software Projects\tally_prime_mcp_server\dist\index.js` exists |
| `TALLY_MCP_COMMAND is required` / `TALLY_AGENT_REPORT_DIR is required` | The `env` block did not reach the process | Check `.mcp.json` is in the directory you started Claude Code from |
| `Tally could not process the Collection request 'CompaniesColl'`, and the quoted response mentions *License server is Running* | `TALLY_PORT` points at a port some other Tally service answers on, not the XML gateway (seen on 9999 here) | Set `TALLY_PORT` back to the XML gateway port — 9000 on this machine |
| `tally-agent: no ledger/group overrides loaded (ENOENT)` on startup | `config/overrides.json` is missing next to `dist/` | Harmless if you use no overrides; otherwise restore the file from the repo |
| Server "starts" then exits immediately with no output at all | You are on a build from before 2026-09-09 | Rebuild. The entrypoint check compared a percent-encoded file URL against a raw argv path, so on any install path containing a space `main()` never ran |
| `tb_write_report` errors with `run tb_review first` | The model composed a report without running the checks | Ask it to run `tb_review` first |

`/mcp` showing `tally-agent` as failed, with no other clue, is almost always one
of the first three rows. Run the gateway by hand with the same env to see the
real error.

## WSL2 (Ubuntu) setup

Verified 2026-09-14 on: WSL2 Ubuntu (kernel
`6.18.33.2-microsoft-standard-WSL2`), Node v24.21.0, npm 11.19.0, Claude Code
2.1.270, TallyPrime XML/HTTP gateway on port 9000. Use this section instead of
sections 1–3 when Claude Code runs inside WSL.

### Three differences from the native-Windows setup

1. **`TALLY_HOST=127.0.0.1`.** WSL here is in **mirrored networking mode**
   (`[wsl2] networkingMode=mirrored` in `.wslconfig`), so Windows' Tally gateway
   on its own `localhost` is reachable from WSL at `127.0.0.1`. The Windows-host
   address used in NAT mode (for example `172.21.80.1`) is stale here and times
   out. Probe before blaming anything else — with mirrored networking,
   `127.0.0.1:9000` is open and `172.21.80.1:9000` is not.
2. **The deny-rule path needs two leading slashes on Linux.**
   `Read(/home/ram/tally-reports/**)` silently matches nothing;
   `Read(//home/ram/tally-reports/**)` blocks as intended. Same three-run
   evidence as step 3: the single-slash form returned the sentinel file, the
   double-slash form was blocked, and the Bash control confirmed Bash was
   genuinely enabled.
3. **Set `TALLY_DEFAULT_COMPANY`.** It is optional on Windows, but the upstream
   does not auto-select the single loaded company: with no default and no
   `company` argument it throws
   `No company specified and no default configured`. Recommended.

### Build first

The primary clone ships no `dist/`, so build before pointing Claude Code at it:

```bash
cd /home/ram/firstmate/projects/tally-agent
npm install && npm run build
```

Gateway startup is also slow when the upstream lives on `/mnt/f`: Windows-drive
reads make the upstream child's boot take several seconds. A hand start showed
no stderr at 4 s and both `running` lines at 12 s. That is not a silent exit.

### Working `.mcp.json`

```json
{
  "mcpServers": {
    "tally-agent": {
      "command": "node",
      "args": ["/home/ram/firstmate/projects/tally-agent/dist/index.js"],
      "env": {
        "TALLY_MCP_COMMAND": "node",
        "TALLY_MCP_ARGS": "[\"/mnt/f/Software Projects/tally_prime_mcp_server/dist/index.js\"]",
        "TALLY_HOST": "127.0.0.1",
        "TALLY_PORT": "9000",
        "TALLY_AGENT_REPORT_DIR": "/home/ram/tally-reports",
        "TALLY_DEFAULT_COMPANY": "RVS Constructions ( Firm) - FY 25-26"
      }
    }
  }
}
```

### Working `.claude/settings.json`

```json
{
  "permissions": {
    "deny": ["Read(//home/ram/tally-reports/**)"]
  }
}
```

### Timeouts on a real company

The gateway→upstream request timeout is the MCP SDK default of **60 s**, which
alone aborts `tb_review` on any real company. Raise the whole chain together:

| Variable | Set where | Value used |
| --- | --- | --- |
| `TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS` | gateway `env` | `900000` |
| `TALLY_TIMEOUT_MS` | gateway `env` (forwarded to the upstream child) | `900000` |
| `MCP_TOOL_TIMEOUT` / `MCP_TIMEOUT` | Claude Code's own environment | `900000` |

`TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS` is the gateway's downstream timeout; leave
it unset to keep the SDK default. `TALLY_TIMEOUT_MS` is read by the **upstream**
server — the gateway forwards its environment to the child, so it is set in the
gateway's `env` block above. `MCP_TOOL_TIMEOUT`/`MCP_TIMEOUT` bound Claude
Code's own call to the gateway, so they belong to Claude Code's environment, not
to the gateway's `env` block. The verified `tb_review` run took 10.7 minutes.

### TDS review timeout note

`tb_tds_review` rides the per-ledger monthly Ledger-Vouchers path (~640 small
calls for a full FY at ~58 ledgers), never the Day Book, so it stays inside one
per-call timeout by shape — the same `900000` chain above covers it. On a slow
company, if individual ledger-month calls time out first, the gateway's
`TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS` is the knob; the per-call ceiling matters,
not a whole-snapshot budget.

### Large-company note

On a large company the upstream connector exports **every voucher with no date
filter** — 40 MB for the trial balance, 53 MB for the GST day book — and can
drive Tally into its `Error` state. Slow or failing `tb_review` /
`tb_gst_summary` / `tb_ledger_scrutiny` on such a company is the upstream
voucher export, **not a setup failure**; restart Tally, which recovers. On the
company used for this verification `tb_review` completed in 10.7 min peaking at
2.37 GB RSS, while `tb_gst_summary` consumed the full 15-minute cap and wedged
Tally. Fixing that export is a separate upstream task.

## What is not verified

- **The `.mcp.json` and `.claude/settings.json` files themselves have not been
  placed on this machine.** Doing so would change the configuration of the
  captain's own Claude Code install, which is not this task's to change. What was
  verified is everything those files configure: the gateway binary, the exact
  command, args and environment above were driven end to end over real stdio by a
  standalone MCP client, and the deny rule was tested in isolated `claude -p`
  sessions as described in step 3.
- **Only one company was reviewed** — the one open in Tally on the day. The
  masking classifier's group allowlist has now been exercised against two real
  companies (SJ Infra previously, this one now), which is still not a guarantee
  it has seen every group name a third company might use. `config/overrides.json`
  is the escape hatch; see `AGENTS.md`.
- **The review was run as of 20260331 only.** Other as-on dates are untested
  against live data.
